/**
 * storage.js
 * Unified wrapper for chrome.storage to handle Sync vs Local separation.
 */

import { normalizeSettings } from './settings.js';

const STORAGE_KEYS = {
    SETTINGS: 'settings',
    SUBSCRIPTIONS: 'subscriptions',
    FEED_META: 'feedMeta',
    ITEMS: 'items' // Stored in local
};

export const SUBSCRIPTION_PREFIX = 'subscription_';

/**
 * Get Settings from Sync Storage
 */
export async function getSettings() {
    const data = await chrome.storage.sync.get([STORAGE_KEYS.SETTINGS]);
    return normalizeSettings(data[STORAGE_KEYS.SETTINGS]);
}

/**
 * Save Settings to Sync Storage
 */
export async function saveSettings(settings) {
    await chrome.storage.sync.set({ [STORAGE_KEYS.SETTINGS]: settings });
}

/** Update preferences against the latest saved settings, retaining other fields. */
export async function updateSettings(patch) {
    const settings = normalizeSettings({ ...await getSettings(), ...patch });
    await saveSettings(settings);
    return settings;
}

function getSubscriptionEntries(data) {
    const byId = new Map();
    let nextOrder = 0;

    const legacySubscriptions = Array.isArray(data[STORAGE_KEYS.SUBSCRIPTIONS])
        ? data[STORAGE_KEYS.SUBSCRIPTIONS]
        : [];

    legacySubscriptions.forEach((subscription) => {
        if (!subscription || subscription.id == null) return;
        const id = String(subscription.id);
        const existing = byId.get(id);
        byId.set(id, {
            subscription,
            order: existing ? existing.order : nextOrder++,
        });
    });

    Object.entries(data)
        .filter(([key]) => key.startsWith(SUBSCRIPTION_PREFIX))
        .forEach(([key, subscription]) => {
            if (!subscription || subscription.id == null) return;
            const id = String(subscription.id);
            if (key !== `${SUBSCRIPTION_PREFIX}${id}`) return;
            const existing = byId.get(id);
            byId.set(id, {
                subscription,
                order: existing ? existing.order : nextOrder++,
            });
        });

    const entries = Array.from(byId.values());
    if (entries.every(({ subscription }) => Number.isFinite(Number(subscription.addedAt)))) {
        entries.sort((left, right) => {
            const addedAtDifference = Number(left.subscription.addedAt) - Number(right.subscription.addedAt);
            return addedAtDifference || left.order - right.order;
        });
    } else {
        entries.sort((left, right) => left.order - right.order);
    }

    return entries.map(({ subscription }) => subscription);
}

/** Get subscriptions from per-record keys, merged with the legacy array. */
export async function getSubscriptions() {
    const data = await chrome.storage.sync.get(null);
    return getSubscriptionEntries(data);
}

/** Write one subscription without rewriting the rest of the collection. */
export async function saveSubscription(subscription) {
    if (!subscription || subscription.id == null) {
        throw new Error('A subscription id is required');
    }
    await chrome.storage.sync.set({
        [`${SUBSCRIPTION_PREFIX}${subscription.id}`]: subscription,
    });
}

/** Remove one subscription record from Sync Storage. */
export async function removeSubscription(id) {
    await chrome.storage.sync.remove(`${SUBSCRIPTION_PREFIX}${id}`);
}

/**
 * Copy legacy subscriptions to individual sync keys. The legacy key remains
 * until the complete missing-record write succeeds, making retries safe.
 */
export async function migrateSubscriptions() {
    const data = await chrome.storage.sync.get(null);
    const legacySubscriptions = Array.isArray(data[STORAGE_KEYS.SUBSCRIPTIONS])
        ? data[STORAGE_KEYS.SUBSCRIPTIONS]
        : [];
    const missingRecords = {};

    legacySubscriptions.forEach((subscription) => {
        if (!subscription || subscription.id == null) return;
        const key = `${SUBSCRIPTION_PREFIX}${subscription.id}`;
        if (!Object.prototype.hasOwnProperty.call(data, key)) {
            missingRecords[key] = subscription;
        }
    });

    const keysToWrite = Object.keys(missingRecords);
    if (keysToWrite.length > 0) {
        await chrome.storage.sync.set(missingRecords);
    }

    if (Object.prototype.hasOwnProperty.call(data, STORAGE_KEYS.SUBSCRIPTIONS)) {
        await chrome.storage.sync.remove(STORAGE_KEYS.SUBSCRIPTIONS);
    }
    return getSubscriptions();
}

/**
 * Get Items (Articles) from Local Storage
 * Items are stored per-feed under keys like "items_<feedId>".
 * @param {string} feedId - Optional, filter by feedId
 */
export async function getItems(feedId = null) {
    if (feedId) {
        const key = `items_${feedId}`;
        const data = await chrome.storage.local.get([key]);
        return Object.values(data[key] || {});
    }

    // Fetch all subscriptions to know which per-feed keys exist
    const subs = await getSubscriptions();
    if (subs.length === 0) return [];

    const keys = subs.map(s => `items_${s.id}`);
    const data = await chrome.storage.local.get(keys);
    return keys.flatMap(key => Object.values(data[key] || {}));
}

const MAX_ITEMS_PER_FEED = 200;

/**
 * Save New Items to Local Storage
 * Reads and writes only the affected feed's key, not the entire items collection.
 * Trims to MAX_ITEMS_PER_FEED most recent items to prevent unbounded storage growth.
 */
export async function saveItems(newItems) {
    if (newItems.length === 0) return;

    // Items passed in a single call always share the same feedId
    const feedId = newItems[0].feedId;
    const key = `items_${feedId}`;
    const data = await chrome.storage.local.get([key]);
    const currentItems = data[key] || {};

    newItems.forEach(item => {
        if (!currentItems[item.id]) {
            currentItems[item.id] = item;
        }
    });

    // Trim to the most recent MAX_ITEMS_PER_FEED items
    const allValues = Object.values(currentItems);
    if (allValues.length > MAX_ITEMS_PER_FEED) {
        allValues.sort((a, b) => new Date(b.pubDate || b.fetchedAt) - new Date(a.pubDate || a.fetchedAt));
        const trimmed = allValues.slice(0, MAX_ITEMS_PER_FEED);
        const trimmedObj = {};
        trimmed.forEach(item => { trimmedObj[item.id] = item; });
        await chrome.storage.local.set({ [key]: trimmedObj });
    } else {
        await chrome.storage.local.set({ [key]: currentItems });
    }
}

/**
 * Mark Item as Read/Unread
 */
export async function markItemRead(itemId, feedId, isRead = true) {
    const key = `items_${feedId}`;
    const data = await chrome.storage.local.get([key]);
    const currentItems = data[key] || {};

    if (currentItems[itemId]) {
        currentItems[itemId].read = isRead;
        // A later explicit read/unread action takes precedence over bulk Undo,
        // even if it reaffirms the article's current state in another tab.
        delete currentItems[itemId].bulkReadToken;
        await chrome.storage.local.set({ [key]: currentItems });
    }
}

// Call from the worker's commit queue so refreshes and manual changes cannot
// overwrite each other. Only changed feed records are written, in one batch.
async function updateReadState(feedIds, isRead, selectedIds = null, bulkReadToken = null) {
    const keys = [...new Set(feedIds)].map(feedId => `items_${feedId}`);
    if (keys.length === 0) return [];
    const data = await chrome.storage.local.get(keys);
    const updates = {};
    const changedItems = [];

    for (const feedId of new Set(feedIds)) {
        const key = `items_${feedId}`;
        const items = data[key] || {};
        for (const [itemId, item] of Object.entries(items)) {
            if (selectedIds && (!selectedIds.get(feedId)?.has(itemId) ||
                item.bulkReadToken !== selectedIds.get(feedId).get(itemId))) continue;
            if (Boolean(item.read) === isRead) continue;
            item.read = isRead;
            if (isRead) item.bulkReadToken = bulkReadToken;
            else delete item.bulkReadToken;
            changedItems.push({ feedId, itemId, ...(isRead ? { bulkReadToken } : {}) });
            updates[key] = items;
        }
    }

    if (changedItems.length > 0) await chrome.storage.local.set(updates);
    return changedItems;
}

/** Mark all retained articles in the specified feeds read. */
export async function markFeedsRead(feedIds) {
    return updateReadState(feedIds, true, null, crypto.randomUUID());
}

/** Restore only articles still carrying this bulk action's token. */
export async function restoreUnreadItems(itemRefs) {
    const selectedIds = new Map();
    for (const { feedId, itemId, bulkReadToken } of itemRefs) {
        if (!selectedIds.has(feedId)) selectedIds.set(feedId, new Map());
        selectedIds.get(feedId).set(String(itemId), bulkReadToken);
    }
    return updateReadState([...selectedIds.keys()], false, selectedIds);
}

/**
 * Get all cached HTTP validators (ETag / Last-Modified) for every feed.
 * Returns a plain object keyed by feedId: { [feedId]: { etag, lastModified } }
 */
export async function getFeedValidators() {
    const data = await chrome.storage.local.get([STORAGE_KEYS.FEED_META]);
    return data[STORAGE_KEYS.FEED_META] || {};
}

/**
 * Persist the full validators map in a single write.
 * @param {{ [feedId]: { etag: string|null, lastModified: string|null } }} validators
 */
export async function saveFeedValidators(validators) {
    await chrome.storage.local.set({ [STORAGE_KEYS.FEED_META]: validators });
}

/**
 * Get the ISO timestamp of the last successful feed refresh from Local Storage
 */
export async function getLastRefreshed() {
    const data = await chrome.storage.local.get(['lastRefreshedAt']);
    return data.lastRefreshedAt || null;
}

/**
 * Save the ISO timestamp of the last successful feed refresh to Local Storage
 */
export async function saveLastRefreshed(ts) {
    await chrome.storage.local.set({ lastRefreshedAt: ts });
}

/**
 * Clear all data (Debugging/Reset)
 */
export async function clearAllData() {
    await chrome.storage.local.clear();
    await chrome.storage.sync.clear();
}
