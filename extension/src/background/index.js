import { fetchFeed } from '../utils/fetcher.js';
import {
    getSubscriptions,
    migrateSubscriptions,
    saveSubscription,
    removeSubscription,
    saveItems,
    markItemRead,
    markFeedsRead,
    restoreUnreadItems,
    getItems,
    getSettings,
    saveLastRefreshed,
    getFeedValidators,
    saveFeedValidators,
    SUBSCRIPTION_PREFIX,
} from '../utils/storage.js';

const ALARM_NAME = 'refresh_feeds';

// Every read-modify-write operation in the worker shares this queue. A failed
// operation is returned to its caller while the recovered tail lets later
// commits continue.
let commitQueue = Promise.resolve();

function enqueueCommit(operation) {
    const result = commitQueue.then(operation);
    commitQueue = result.catch((error) => {
        console.error('Background commit failed:', error);
    });
    return result;
}

function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}

function makeError(message, code) {
    const error = new Error(message);
    if (code) error.code = code;
    return error;
}

function logBackgroundError(context, error) {
    console.error(`${context}:`, error);
}

function reportResponse(promise, sendResponse, requestType) {
    promise.then(sendResponse).catch((error) => {
        const message = errorMessage(error);
        if (requestType === 'REFRESH_FEEDS') {
            sendResponse({
                success: false,
                status: 'error',
                refreshed: 0,
                failed: 0,
                errors: [],
                error: message,
            });
            return;
        }

        const response = { success: false, error: message };
        if (error?.code) response.code = error.code;
        sendResponse(response);
    });
    return true;
}

// Initialize Alarm and migrate old subscription storage on install.
chrome.runtime.onInstalled.addListener(() => {
    console.log('SimpleReader Installed');
    enqueueCommit(() => migrateSubscriptions()).catch((error) => {
        logBackgroundError('Failed to migrate subscriptions on install', error);
    });
    setupAlarm().catch((error) => logBackgroundError('Failed to set up refresh alarm', error));
});

// Re-create alarm on browser startup (guards against alarm loss on Chrome updates / disable+re-enable).
chrome.runtime.onStartup.addListener(() => {
    console.log('SimpleReader startup');
    enqueueCommit(() => migrateSubscriptions()).catch((error) => {
        logBackgroundError('Failed to migrate subscriptions on startup', error);
    });
    setupAlarm().catch((error) => logBackgroundError('Failed to set up refresh alarm', error));
});

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM_NAME) {
        console.log('Alarm triggered: Refreshing feeds...');
        refreshAllFeeds().catch((error) => logBackgroundError('Scheduled feed refresh failed', error));
    }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'REFRESH_FEEDS') {
        return reportResponse(refreshAllFeeds(), sendResponse, request.type);
    }

    if (request.type === 'ADD_FEED') {
        return reportResponse(addNewFeed(request.url), sendResponse, request.type);
    }

    if (request.type === 'DELETE_FEED') {
        return reportResponse(deleteFeed(request.feedId), sendResponse, request.type);
    }

    if (request.type === 'TOGGLE_STAR') {
        return reportResponse(toggleStar(request.feedId), sendResponse, request.type);
    }

    if (request.type === 'MARK_READ') {
        return reportResponse(markRead(request), sendResponse, request.type);
    }

    if (request.type === 'MARK_ALL_READ') {
        return reportResponse(markAllRead(request.feedId), sendResponse, request.type);
    }

    if (request.type === 'UNDO_MARK_ALL_READ') {
        return reportResponse(undoMarkAllRead(request.items), sendResponse, request.type);
    }
});

// Changes made in another extension surface should immediately affect the
// badge. There is no worker-side item cache to invalidate, and these events
// never trigger a feed refresh.
chrome.storage.onChanged.addListener((changes, areaName) => {
    const keys = Object.keys(changes);
    const subscriptionChanged = areaName === 'sync' && keys.some((key) =>
        key === 'subscriptions' || key.startsWith(SUBSCRIPTION_PREFIX)
    );
    const itemsChanged = areaName === 'local' && keys.some((key) => key.startsWith('items_'));

    if (subscriptionChanged || itemsChanged) {
        enqueueCommit(updateBadge).catch((error) => {
            logBackgroundError('Failed to update badge after storage change', error);
        });
    }
});

async function addNewFeed(url) {
    console.log('Adding new feed:', url);

    // Avoid a network request for an existing feed. The queued check below is
    // still required because another add can finish while this request runs.
    const existingSubscriptions = await getSubscriptions();
    if (existingSubscriptions.some((subscription) => subscription.url === url)) {
        throw makeError('Feed already exists', 'DUPLICATE_FEED');
    }

    // Network access stays outside the serialized storage commit queue.
    const feedData = await fetchFeed(url);
    if (!feedData) throw new Error('The feed could not be loaded');

    return enqueueCommit(async () => {
        await migrateSubscriptions();
        const subscriptions = await getSubscriptions();
        if (subscriptions.some((subscription) => subscription.url === url)) {
            throw makeError('Feed already exists', 'DUPLICATE_FEED');
        }

        const newSubscription = {
            id: crypto.randomUUID(),
            url,
            title: feedData.title,
            addedAt: Date.now(),
        };
        const itemKey = `items_${newSubscription.id}`;
        const localSnapshot = await chrome.storage.local.get([itemKey, 'feedMeta']);
        const hadItems = Object.prototype.hasOwnProperty.call(localSnapshot, itemKey);
        const hadFeedMeta = Object.prototype.hasOwnProperty.call(localSnapshot, 'feedMeta');
        const previousFeedMeta = localSnapshot.feedMeta || {};

        try {
            const { etag, lastModified, siteLink, items = [] } = feedData;
            const itemsToSave = items.map((item) => ({
                ...item,
                feedId: newSubscription.id,
                fetchedAt: Date.now(),
            }));
            await saveItems(itemsToSave);

            if (etag || lastModified || siteLink) {
                await saveFeedValidators({
                    ...previousFeedMeta,
                    [newSubscription.id]: { etag, lastModified, siteLink },
                });
            }

            // Write the sync subscription last, after all local data is ready.
            await saveSubscription(newSubscription);
        } catch (error) {
            // A rejected sync write should not leave this newly added feed
            // visible. Clean up any local data written earlier in the commit.
            try {
                await removeSubscription(newSubscription.id);
            } catch (cleanupError) {
                logBackgroundError('Failed to remove incomplete subscription', cleanupError);
            }
            try {
                if (hadItems) {
                    await chrome.storage.local.set({ [itemKey]: localSnapshot[itemKey] });
                } else {
                    await chrome.storage.local.remove(itemKey);
                }
            } catch (cleanupError) {
                logBackgroundError('Failed to roll back new feed items', cleanupError);
            }
            try {
                if (hadFeedMeta) {
                    await saveFeedValidators(previousFeedMeta);
                } else {
                    await chrome.storage.local.remove('feedMeta');
                }
            } catch (cleanupError) {
                logBackgroundError('Failed to roll back new feed metadata', cleanupError);
            }
            throw error;
        }

        await updateBadge();
        return { success: true, subscription: newSubscription };
    });
}

async function deleteFeed(feedId) {
    if (feedId == null || feedId === '') throw new Error('A feed id is required');
    console.log('Deleting feed:', feedId);

    return enqueueCommit(async () => {
        await migrateSubscriptions();
        const itemKey = `items_${feedId}`;
        const localSnapshot = await chrome.storage.local.get([itemKey, 'feedMeta']);
        const hadItems = Object.prototype.hasOwnProperty.call(localSnapshot, itemKey);
        const hadFeedMeta = Object.prototype.hasOwnProperty.call(localSnapshot, 'feedMeta');
        const previousFeedMeta = localSnapshot.feedMeta || {};
        const updatedFeedMeta = { ...previousFeedMeta };
        delete updatedFeedMeta[feedId];

        try {
            await chrome.storage.local.remove(itemKey);
            await saveFeedValidators(updatedFeedMeta);
            // Remove the subscription after the local cleanup. If sync removal
            // fails, restore the local state before returning an error.
            await removeSubscription(feedId);
        } catch (error) {
            try {
                if (hadItems) {
                    await chrome.storage.local.set({ [itemKey]: localSnapshot[itemKey] });
                }
            } catch (cleanupError) {
                logBackgroundError('Failed to restore feed items after delete error', cleanupError);
            }
            try {
                if (hadFeedMeta) {
                    await saveFeedValidators(previousFeedMeta);
                } else {
                    await chrome.storage.local.remove('feedMeta');
                }
            } catch (cleanupError) {
                logBackgroundError('Failed to restore feed metadata after delete error', cleanupError);
            }
            throw error;
        }

        await updateBadge();
        return { success: true };
    });
}

async function toggleStar(feedId) {
    if (feedId == null || feedId === '') throw new Error('A feed id is required');

    return enqueueCommit(async () => {
        await migrateSubscriptions();
        const subscriptions = await getSubscriptions();
        const subscription = subscriptions.find((candidate) => candidate.id === feedId);
        if (!subscription) throw new Error('Feed not found');

        const updatedSubscription = { ...subscription, starred: !subscription.starred };
        await saveSubscription(updatedSubscription);
        return { success: true, subscription: updatedSubscription };
    });
}

async function markRead(request) {
    if (request.itemId == null || request.feedId == null) {
        throw new Error('Both itemId and feedId are required');
    }

    return enqueueCommit(async () => {
        await migrateSubscriptions();
        await markItemRead(request.itemId, request.feedId, request.isRead ?? true);
        await updateBadge();
        return { success: true };
    });
}

async function markAllRead(feedId = null) {
    return enqueueCommit(async () => {
        await migrateSubscriptions();
        const subscriptions = await getSubscriptions();
        if (feedId !== null && !subscriptions.some(sub => sub.id === feedId)) {
            throw new Error('Feed not found');
        }
        const feedIds = feedId === null ? subscriptions.map(sub => sub.id) : [feedId];
        const changedItems = await markFeedsRead(feedIds);
        await updateBadge();
        return { success: true, changedItems };
    });
}

async function undoMarkAllRead(items) {
    if (!Array.isArray(items) || items.some(item => !item ||
        typeof item.feedId !== 'string' || typeof item.itemId !== 'string' ||
        typeof item.bulkReadToken !== 'string')) {
        throw new Error('Article references are required');
    }
    return enqueueCommit(async () => {
        await migrateSubscriptions();
        const subscriptions = await getSubscriptions();
        const feedIds = new Set(subscriptions.map(sub => sub.id));
        const changedItems = await restoreUnreadItems(items.filter(item => feedIds.has(item.feedId)));
        await updateBadge();
        return { success: true, changedItems };
    });
}

async function setupAlarm() {
    const existing = await chrome.alarms.get(ALARM_NAME);
    if (existing) return;
    const settings = await getSettings();
    await chrome.alarms.create(ALARM_NAME, {
        periodInMinutes: settings.refreshInterval || 30,
    });
}

export async function refreshAllFeeds() {
    const snapshot = await enqueueCommit(async () => {
        await migrateSubscriptions();
        const [subscriptions, validators] = await Promise.all([
            getSubscriptions(),
            getFeedValidators(),
        ]);
        return { subscriptions, validators };
    });

    if (snapshot.subscriptions.length === 0) {
        console.log('No subscriptions to refresh.');
        await enqueueCommit(updateBadge);
        return { success: true, status: 'success', refreshed: 0, failed: 0, errors: [] };
    }

    const outcomes = await Promise.all(snapshot.subscriptions.map(async (subscription) => {
        try {
            const feedData = await fetchFeed(subscription.url, snapshot.validators[subscription.id] || {});

            await enqueueCommit(async () => {
                await migrateSubscriptions();
                const currentSubscriptions = await getSubscriptions();
                if (!currentSubscriptions.some((current) =>
                    current.id === subscription.id && current.url === subscription.url
                )) {
                    return;
                }

                if (feedData === null) {
                    console.log(`${subscription.title}: not modified.`);
                    return;
                }

                const { etag, lastModified, siteLink, items = [] } = feedData;
                const itemsToSave = items.map((item) => ({
                    ...item,
                    feedId: subscription.id,
                    fetchedAt: Date.now(),
                }));
                await saveItems(itemsToSave);
                console.log(`Fetched ${subscription.title}: ${itemsToSave.length} items.`);

                if (etag || lastModified || siteLink) {
                    const currentValidators = await getFeedValidators();
                    await saveFeedValidators({
                        ...currentValidators,
                        [subscription.id]: { etag, lastModified, siteLink },
                    });
                }
            });

            return { success: true, subscription };
        } catch (error) {
            logBackgroundError(`Failed to refresh ${subscription.title}`, error);
            return { success: false, subscription, error: errorMessage(error) };
        }
    }));

    const errors = outcomes
        .filter((outcome) => !outcome.success)
        .map(({ subscription, error }) => ({
            feedId: subscription.id,
            title: subscription.title,
            error,
        }));
    const refreshed = outcomes.length - errors.length;
    let timestampError = null;

    await enqueueCommit(async () => {
        if (errors.length === 0) {
            try {
                await saveLastRefreshed(new Date().toISOString());
            } catch (error) {
                timestampError = errorMessage(error);
            }
        }
        await updateBadge();
    });

    if (timestampError) {
        return {
            success: false,
            status: 'error',
            refreshed,
            failed: 0,
            errors: [],
            error: `Feeds refreshed, but the refresh time could not be saved: ${timestampError}`,
        };
    }

    if (errors.length === 0) {
        return { success: true, status: 'success', refreshed, failed: 0, errors: [] };
    }

    if (refreshed === 0) {
        return {
            success: false,
            status: 'error',
            refreshed: 0,
            failed: errors.length,
            errors,
            error: `Failed to refresh all ${errors.length} feeds`,
        };
    }

    return {
        success: true,
        status: 'partial',
        refreshed,
        failed: errors.length,
        errors,
    };
}

async function updateBadge() {
    try {
        const items = await getItems();
        const unreadCount = items.filter((item) => !item.read).length;

        if (unreadCount > 0) {
            await chrome.action.setBadgeText({ text: unreadCount > 999 ? '999+' : String(unreadCount) });
            await chrome.action.setBadgeBackgroundColor({ color: '#666666' });
        } else {
            await chrome.action.setBadgeText({ text: '' });
        }
    } catch (error) {
        // Badge state is secondary to the storage mutation that triggered it.
        logBackgroundError('Failed to update unread badge', error);
    }
}
