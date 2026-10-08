import test from 'node:test';
import assert from 'node:assert/strict';
import { SUBSCRIPTION_PREFIX } from '../src/utils/storage.js';

function createEvent() {
    const listeners = [];
    return {
        addListener(listener) {
            listeners.push(listener);
        },
        fire(...args) {
            let result;
            for (const listener of listeners) result = listener(...args);
            return result;
        },
    };
}

function createStorageArea(areaName, onChanged) {
    const data = {};
    const setCalls = [];
    let failNextSet = null;

    return {
        data,
        setCalls,
        failNextSet(error) {
            failNextSet = error;
        },
        async get(keys) {
            if (keys == null) return structuredClone(data);
            const requested = Array.isArray(keys) ? keys : [keys];
            return Object.fromEntries(requested
                .filter((key) => Object.prototype.hasOwnProperty.call(data, key))
                .map((key) => [key, structuredClone(data[key])]));
        },
        async set(values) {
            setCalls.push(structuredClone(values));
            if (failNextSet) {
                const error = failNextSet;
                failNextSet = null;
                throw error;
            }
            const changes = {};
            for (const [key, value] of Object.entries(values)) {
                changes[key] = {
                    ...(Object.prototype.hasOwnProperty.call(data, key) ? { oldValue: structuredClone(data[key]) } : {}),
                    newValue: structuredClone(value),
                };
            }
            Object.assign(data, structuredClone(values));
            if (Object.keys(changes).length > 0) onChanged.fire(changes, areaName);
        },
        async remove(keys) {
            const changes = {};
            for (const key of Array.isArray(keys) ? keys : [keys]) {
                if (!Object.prototype.hasOwnProperty.call(data, key)) continue;
                changes[key] = { oldValue: structuredClone(data[key]) };
                delete data[key];
            }
            if (Object.keys(changes).length > 0) onChanged.fire(changes, areaName);
        },
    };
}

function createChrome() {
    const changed = createEvent();
    const message = createEvent();
    const installed = createEvent();
    const startup = createEvent();
    const alarmEvent = createEvent();
    const state = { badgeText: '', badgeColor: null, alarms: {} };
    const sync = createStorageArea('sync', changed);
    const local = createStorageArea('local', changed);

    const chromeApi = {
        storage: {
            sync,
            local,
            onChanged: changed,
        },
        runtime: {
            onInstalled: installed,
            onStartup: startup,
            onMessage: message,
        },
        alarms: {
            onAlarm: alarmEvent,
            async get(name) {
                return state.alarms[name] || null;
            },
            create(name, options) {
                state.alarms[name] = { name, ...options };
            },
        },
        action: {
            async setBadgeText({ text }) {
                state.badgeText = text;
            },
            async setBadgeBackgroundColor({ color }) {
                state.badgeColor = color;
            },
        },
        state,
    };

    chromeApi.sendMessage = (request) => new Promise((resolve) => {
        const keepsChannelOpen = message.fire(request, {}, resolve);
        if (keepsChannelOpen !== true) resolve(undefined);
    });
    return chromeApi;
}

const chromeMock = createChrome();
globalThis.chrome = chromeMock;
const { refreshAllFeeds } = await import('../src/background/index.js');
const { getSubscriptions } = await import('../src/utils/storage.js');

function seedSubscription(subscription, items = []) {
    chromeMock.storage.sync.data[`${SUBSCRIPTION_PREFIX}${subscription.id}`] = structuredClone(subscription);
    if (items.length > 0) {
        chromeMock.storage.local.data[`items_${subscription.id}`] = Object.fromEntries(
            items.map((item) => [item.id, { ...item, feedId: subscription.id }])
        );
    }
}

async function resetStorage() {
    await chromeMock.sendMessage({ type: 'MARK_READ', itemId: 'missing', feedId: 'missing' });
    for (const key of Object.keys(chromeMock.storage.sync.data)) delete chromeMock.storage.sync.data[key];
    for (const key of Object.keys(chromeMock.storage.local.data)) delete chromeMock.storage.local.data[key];
    chromeMock.state.badgeText = '';
    chromeMock.storage.local.setCalls.length = 0;
    globalThis.fetch = async () => responseFor('https://example.test/feed');
}

function responseFor(itemId, title = 'Fetched', status = 200) {
    if (status === 304) {
        return new Response(null, { status: 304 });
    }

    const xml = `<?xml version="1.0"?><rss><channel><title>${title}</title><link>https://example.test</link><item><guid>${itemId}</guid><title>${itemId}</title><link>https://example.test/${itemId}</link><description>body</description><pubDate>Sat, 12 Sep 2026 00:00:00 GMT</pubDate></item></channel></rss>`;
    return new Response(xml, { status, headers: { 'Content-Type': 'application/rss+xml' } });
}

async function suppressConsoleError(operation) {
    const original = console.error;
    console.error = () => {};
    try {
        return await operation();
    } finally {
        console.error = original;
    }
}

test('a queued read and a refresh preserve existing item state', async () => {
    await resetStorage();
    const subscription = { id: 'read-race', url: 'https://read-race.test/rss', title: 'Read race', addedAt: 1 };
    seedSubscription(subscription, [{ id: 'existing', title: 'Old title', read: false }]);

    let markFetchStarted;
    const fetchStarted = new Promise((resolve) => { markFetchStarted = resolve; });
    let releaseFetch;
    const pendingFetch = new Promise((resolve) => { releaseFetch = resolve; });
    globalThis.fetch = async () => {
        markFetchStarted();
        return pendingFetch;
    };

    const refreshPromise = refreshAllFeeds();
    await fetchStarted;
    const readResponse = await chromeMock.sendMessage({
        type: 'MARK_READ', itemId: 'existing', feedId: subscription.id,
    });
    assert.deepEqual(readResponse, { success: true });

    releaseFetch(responseFor('existing', 'Server title'));
    const refreshResponse = await refreshPromise;
    assert.deepEqual({
        status: refreshResponse.status,
        refreshed: refreshResponse.refreshed,
        failed: refreshResponse.failed,
    }, { status: 'success', refreshed: 1, failed: 0 });

    const stored = chromeMock.storage.local.data[`items_${subscription.id}`];
    assert.equal(stored.existing.read, true);
    assert.equal(stored.existing.title, 'Old title');
});

test('manual unread changes affect only the requested feed and update the badge', async () => {
    await resetStorage();
    seedSubscription({ id: 'one', title: 'One' }, [{ id: 'same-id', read: true }]);
    seedSubscription({ id: 'two', title: 'Two' }, [{ id: 'same-id', read: true }]);
    const response = await chromeMock.sendMessage({ type: 'MARK_READ', feedId: 'one', itemId: 'same-id', isRead: false });
    assert.equal(response.success, true);
    assert.equal(chromeMock.storage.local.data.items_one['same-id'].read, false);
    assert.equal(chromeMock.storage.local.data.items_two['same-id'].read, true);
    assert.equal(chromeMock.state.badgeText, '1');
});

test('bulk feed marking handles the full 200-article cache and skips other feeds', async () => {
    await resetStorage();
    seedSubscription({ id: 'one', title: 'One' }, Array.from({ length: 200 }, (_, i) => ({ id: String(i), read: i === 0 })));
    seedSubscription({ id: 'two', title: 'Two' }, [{ id: '0', read: false }]);

    const response = await chromeMock.sendMessage({ type: 'MARK_ALL_READ', feedId: 'one' });
    assert.equal(response.success, true);
    assert.equal(response.changedItems.length, 199);
    assert.equal(response.changedItems.some(item => item.itemId === '0'), false);
    assert.equal(Object.values(chromeMock.storage.local.data.items_one).every(item => item.read), true);
    assert.equal(chromeMock.storage.local.data.items_two['0'].read, false);
    assert.equal(chromeMock.state.badgeText, '1');
    assert.equal(chromeMock.storage.local.setCalls.length, 1);
    assert.deepEqual(Object.keys(chromeMock.storage.local.setCalls[0]), ['items_one']);

    const repeated = await chromeMock.sendMessage({ type: 'MARK_ALL_READ', feedId: 'one' });
    assert.deepEqual(repeated.changedItems, []);
    assert.equal(chromeMock.storage.local.setCalls.length, 1);
});

test('global marking batches subscribed feeds and undo preserves prior read and later arrivals', async () => {
    await resetStorage();
    seedSubscription({ id: 'one', title: 'One' }, [{ id: 'shared', read: false }, { id: 'already-read', read: true }]);
    seedSubscription({ id: 'two', title: 'Two' }, [{ id: 'shared', read: false }]);
    chromeMock.storage.local.data.items_orphan = { old: { id: 'old', feedId: 'orphan', read: false } };

    const response = await chromeMock.sendMessage({ type: 'MARK_ALL_READ' });
    assert.equal(response.success, true);
    assert.deepEqual(response.changedItems.map(({ feedId, itemId }) => ({ feedId, itemId })),
        [{ feedId: 'one', itemId: 'shared' }, { feedId: 'two', itemId: 'shared' }]);
    assert.equal(chromeMock.state.badgeText, '');
    assert.equal(chromeMock.storage.local.setCalls.length, 1);
    assert.deepEqual(Object.keys(chromeMock.storage.local.setCalls[0]), ['items_one', 'items_two']);
    assert.equal(chromeMock.storage.local.data.items_orphan.old.read, false);

    chromeMock.storage.local.data.items_one.new = { id: 'new', feedId: 'one', read: false };
    const undo = await chromeMock.sendMessage({ type: 'UNDO_MARK_ALL_READ', items: response.changedItems });
    assert.equal(undo.success, true);
    assert.equal(chromeMock.storage.local.data.items_one.shared.read, false);
    assert.equal(chromeMock.storage.local.data.items_two.shared.read, false);
    assert.equal(chromeMock.storage.local.data.items_one['already-read'].read, true);
    assert.equal(chromeMock.storage.local.data.items_one.new.read, false);
    assert.equal(chromeMock.state.badgeText, '3');
});

test('undo tolerates removed feeds and pruned articles without recreating their data', async () => {
    await resetStorage();
    seedSubscription({ id: 'one', title: 'One' }, [{ id: 'pruned', read: false }]);
    seedSubscription({ id: 'two', title: 'Two' }, [{ id: 'deleted', read: false }]);
    const response = await chromeMock.sendMessage({ type: 'MARK_ALL_READ' });
    delete chromeMock.storage.local.data.items_one.pruned;
    await chromeMock.sendMessage({ type: 'DELETE_FEED', feedId: 'two' });
    const undo = await chromeMock.sendMessage({ type: 'UNDO_MARK_ALL_READ', items: response.changedItems });
    assert.equal(undo.success, true);
    assert.deepEqual(undo.changedItems, []);
    assert.deepEqual(chromeMock.storage.local.data.items_one, {});
    assert.equal(Object.hasOwn(chromeMock.storage.local.data, 'items_two'), false);
});

test('bulk undo preserves later explicit read actions and newer bulk changes across tabs', async () => {
    await resetStorage();
    seedSubscription({ id: 'one', title: 'One' }, [
        { id: 'opened-later', read: false },
        { id: 'marked-again', read: false },
        { id: 'untouched', read: false },
    ]);
    const original = await chromeMock.sendMessage({ type: 'MARK_ALL_READ' });
    // Opening an already read article must invalidate the old bulk Undo.
    await chromeMock.sendMessage({ type: 'MARK_READ', feedId: 'one', itemId: 'opened-later' });
    await chromeMock.sendMessage({ type: 'MARK_READ', feedId: 'one', itemId: 'marked-again', isRead: false });
    const later = await chromeMock.sendMessage({ type: 'MARK_ALL_READ' });

    const undo = await chromeMock.sendMessage({ type: 'UNDO_MARK_ALL_READ', items: original.changedItems });
    assert.equal(undo.success, true);
    assert.deepEqual(undo.changedItems, [{ feedId: 'one', itemId: 'untouched' }]);
    assert.equal(chromeMock.storage.local.data.items_one['opened-later'].read, true);
    assert.equal(chromeMock.storage.local.data.items_one['marked-again'].read, true);
    assert.equal(chromeMock.storage.local.data.items_one.untouched.read, false);
    assert.equal(chromeMock.state.badgeText, '1');

    await chromeMock.sendMessage({ type: 'UNDO_MARK_ALL_READ', items: later.changedItems });
    assert.equal(chromeMock.storage.local.data.items_one['marked-again'].read, false);
    assert.equal(chromeMock.state.badgeText, '2');
});

test('bulk read during refresh preserves read state while later arrivals stay unread', async () => {
    await resetStorage();
    seedSubscription({ id: 'one', url: 'https://one.test/rss', title: 'One' }, [{ id: 'existing', read: false }]);
    let fetchStarted;
    const started = new Promise(resolve => { fetchStarted = resolve; });
    let releaseFetch;
    const fetched = new Promise(resolve => { releaseFetch = resolve; });
    globalThis.fetch = async () => { fetchStarted(); return fetched; };

    const refresh = refreshAllFeeds();
    await started;
    await chromeMock.sendMessage({ type: 'MARK_ALL_READ' });
    releaseFetch(responseFor('new-arrival'));
    await refresh;
    assert.equal(chromeMock.storage.local.data.items_one.existing.read, true);
    assert.equal(chromeMock.storage.local.data.items_one['new-arrival'].read, false);
    assert.equal(chromeMock.state.badgeText, '1');
});

test('failed bulk writes report errors, preserve status, and allow retry', async () => {
    await resetStorage();
    seedSubscription({ id: 'one', title: 'One' }, [{ id: 'article', read: false }]);
    chromeMock.storage.local.failNextSet(new Error('local storage unavailable'));
    const failed = await suppressConsoleError(() => chromeMock.sendMessage({ type: 'MARK_ALL_READ' }));
    assert.equal(failed.success, false);
    assert.match(failed.error, /local storage unavailable/);
    assert.equal(chromeMock.storage.local.data.items_one.article.read, false);
    const retry = await chromeMock.sendMessage({ type: 'MARK_ALL_READ' });
    assert.equal(retry.success, true);
    assert.equal(chromeMock.storage.local.data.items_one.article.read, true);
});

test('invalid bulk scopes and undo requests report failure', async () => {
    await resetStorage();
    const missing = await suppressConsoleError(() => chromeMock.sendMessage({ type: 'MARK_ALL_READ', feedId: 'missing' }));
    assert.equal(missing.success, false);
    assert.match(missing.error, /Feed not found/);
    const invalid = await chromeMock.sendMessage({ type: 'UNDO_MARK_ALL_READ', items: [{}] });
    assert.equal(invalid.success, false);
    assert.match(invalid.error, /Article references/);
});

test('concurrent add, delete, and star messages commit without lost collection updates', async () => {
    await resetStorage();
    const existing = { id: 'remove-me', url: 'https://remove-me.test/rss', title: 'Remove me', addedAt: 1 };
    seedSubscription(existing, [{ id: 'old-item', title: 'Old', read: false }]);
    chromeMock.storage.local.data.feedMeta = { [existing.id]: { etag: 'old' } };
    globalThis.fetch = async () => responseFor('new-item', 'New feed');

    const [starResponse, deleteResponse, addResponse] = await Promise.all([
        chromeMock.sendMessage({ type: 'TOGGLE_STAR', feedId: existing.id }),
        chromeMock.sendMessage({ type: 'DELETE_FEED', feedId: existing.id }),
        chromeMock.sendMessage({ type: 'ADD_FEED', url: 'https://new-feed.test/rss' }),
    ]);

    assert.equal(starResponse.success, true);
    assert.equal(deleteResponse.success, true);
    assert.equal(addResponse.success, true);
    assert.deepEqual((await getSubscriptions()).map(({ url }) => url), ['https://new-feed.test/rss']);
    assert.equal(Object.hasOwn(chromeMock.storage.local.data, `items_${existing.id}`), false);
    assert.equal(Object.hasOwn(chromeMock.storage.local.data, `items_${addResponse.subscription.id}`), true);
    assert.equal(Object.hasOwn(chromeMock.storage.local.data.feedMeta, existing.id), false);

    const duplicate = await chromeMock.sendMessage({ type: 'ADD_FEED', url: 'https://new-feed.test/rss' });
    assert.equal(duplicate.success, false);
    assert.equal(duplicate.code, 'DUPLICATE_FEED');
    assert.match(duplicate.error, /already exists/);
});

test('a failed add sync write rolls back its local data and the queue accepts later commits', async () => {
    await resetStorage();
    const existing = { id: 'still-here', url: 'https://still-here.test/rss', title: 'Still here', addedAt: 1 };
    seedSubscription(existing, [{ id: 'existing', title: 'Existing', read: false }]);
    globalThis.fetch = async () => responseFor('orphan', 'Would be orphaned');
    chromeMock.storage.sync.failNextSet(new Error('sync quota exceeded'));

    const failedAdd = await chromeMock.sendMessage({ type: 'ADD_FEED', url: 'https://quota.test/rss' });
    assert.equal(failedAdd.success, false);
    assert.match(failedAdd.error, /sync quota exceeded/);
    assert.deepEqual((await getSubscriptions()).map(({ id }) => id), [existing.id]);
    assert.equal(Object.keys(chromeMock.storage.local.data).some((key) => key.startsWith('items_') && key !== `items_${existing.id}`), false);

    const readResponse = await chromeMock.sendMessage({ type: 'MARK_READ', itemId: 'existing', feedId: existing.id });
    assert.deepEqual(readResponse, { success: true });
    assert.equal(chromeMock.storage.local.data[`items_${existing.id}`].existing.read, true);
});

test('partial and total refresh failures keep the last successful refresh time', async () => {
    await resetStorage();
    const good = { id: 'good', url: 'https://good.test/rss', title: 'Good', addedAt: 1 };
    const bad = { id: 'bad', url: 'https://bad.test/rss', title: 'Bad', addedAt: 2 };
    seedSubscription(good);
    seedSubscription(bad);
    chromeMock.storage.local.data.lastRefreshedAt = 'old-success';
    globalThis.fetch = async (url) => {
        if (url.includes('bad.test')) throw new Error('network unavailable');
        return responseFor('', '', 304);
    };

    const partial = await suppressConsoleError(() => refreshAllFeeds());
    assert.equal(partial.success, true);
    assert.equal(partial.status, 'partial');
    assert.equal(partial.refreshed, 1);
    assert.equal(partial.failed, 1);
    assert.deepEqual(partial.errors, [{ feedId: bad.id, title: bad.title, error: 'network unavailable' }]);
    assert.equal(chromeMock.storage.local.data.lastRefreshedAt, 'old-success');

    globalThis.fetch = async () => { throw new Error('offline'); };
    const failed = await suppressConsoleError(() => refreshAllFeeds());
    assert.equal(failed.success, false);
    assert.equal(failed.status, 'error');
    assert.equal(failed.refreshed, 0);
    assert.equal(failed.failed, 2);
    assert.match(failed.error, /all 2 feeds/);
    assert.equal(failed.errors.length, 2);
    assert.equal(chromeMock.storage.local.data.lastRefreshedAt, 'old-success');
});

test('a feed deleted during its network request is not restored by the refresh commit', async () => {
    await resetStorage();
    const subscription = { id: 'delete-in-flight', url: 'https://delete-in-flight.test/rss', title: 'In flight', addedAt: 1 };
    seedSubscription(subscription);
    chromeMock.storage.local.data.feedMeta = { [subscription.id]: { etag: 'old' } };
    chromeMock.storage.local.data.lastRefreshedAt = 'before-delete';

    let markFetchStarted;
    const fetchStarted = new Promise((resolve) => { markFetchStarted = resolve; });
    let releaseFetch;
    const pendingFetch = new Promise((resolve) => { releaseFetch = resolve; });
    globalThis.fetch = async () => {
        markFetchStarted();
        return pendingFetch;
    };

    const refreshPromise = refreshAllFeeds();
    await fetchStarted;
    const deletion = await chromeMock.sendMessage({ type: 'DELETE_FEED', feedId: subscription.id });
    assert.deepEqual(deletion, { success: true });
    releaseFetch(responseFor('late-item'));

    const refresh = await refreshPromise;
    assert.equal(refresh.status, 'success');
    assert.equal(refresh.refreshed, 1);
    assert.deepEqual(await getSubscriptions(), []);
    assert.equal(Object.hasOwn(chromeMock.storage.local.data, `items_${subscription.id}`), false);
    assert.equal(Object.hasOwn(chromeMock.storage.local.data.feedMeta, subscription.id), false);
});

test('refreshing with no feeds succeeds with zero counts', async () => {
    await resetStorage();
    const result = await refreshAllFeeds();
    assert.deepEqual(result, { success: true, status: 'success', refreshed: 0, failed: 0, errors: [] });
});
