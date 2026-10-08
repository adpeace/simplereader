import test from 'node:test';
import assert from 'node:assert/strict';
import {
    getSubscriptions,
    migrateSubscriptions,
    SUBSCRIPTION_PREFIX,
    getSettings,
    updateSettings,
} from '../src/utils/storage.js';

function createSyncArea(initial = {}) {
    const data = structuredClone(initial);
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
            Object.assign(data, structuredClone(values));
        },
        async remove(keys) {
            for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
        },
    };
}

function setChrome(sync) {
    globalThis.chrome = { storage: { sync } };
}

test('legacy settings acquire a default design without losing color, size, or future view preferences', async () => {
    const sync = createSyncArea({ settings: { theme: 'dark', fontSize: 'large', refreshInterval: 45, viewMode: 'headlines', showUnreadOnly: true } });
    setChrome(sync);
    const settings = await getSettings();
    assert.equal(settings.designTheme, 'default');
    assert.equal(settings.theme, 'dark');
    assert.equal(settings.fontSize, 'large');
    assert.equal(settings.viewMode, 'headlines');
    assert.equal(sync.setCalls.length, 0);

    await updateSettings({ designTheme: 'modern' });
    assert.deepEqual(await getSettings(), { ...settings, designTheme: 'modern' });
});

test('unknown appearance values fall back to supported defaults', async () => {
    setChrome(createSyncArea({ settings: { designTheme: 'removed-theme', theme: 'unknown', fontSize: 'huge' } }));
    const settings = await getSettings();
    assert.equal(settings.designTheme, 'default');
    assert.equal(settings.theme, 'system');
    assert.equal(settings.fontSize, 'medium');
});

test('failed preference writes retain the saved theme and report failure', async () => {
    const sync = createSyncArea({ settings: { designTheme: 'default', theme: 'light' } });
    setChrome(sync);
    sync.failNextSet(new Error('sync unavailable'));
    await assert.rejects(updateSettings({ designTheme: 'modern' }), /sync unavailable/);
    assert.equal((await getSettings()).designTheme, 'default');
    assert.equal((await getSettings()).theme, 'light');
});

test('appearance updates merge with the latest saved unrelated settings', async () => {
    const sync = createSyncArea({ settings: { designTheme: 'modern', theme: 'system', viewMode: 'headlines' } });
    setChrome(sync);
    sync.data.settings.viewMode = 'preview';
    sync.data.settings.showUnreadOnly = true;
    await updateSettings({ fontSize: 'large' });
    const settings = await getSettings();
    assert.equal(settings.viewMode, 'preview');
    assert.equal(settings.showUnreadOnly, true);
    assert.equal(settings.designTheme, 'modern');
    assert.equal(settings.fontSize, 'large');
});

test('migrates legacy subscriptions, preserves records, and lets per-record values win', async () => {
    const sync = createSyncArea({
        subscriptions: [
            { id: 'first', url: 'https://first.test/feed', title: 'Legacy first', addedAt: 10 },
            { id: 'second', url: 'https://second.test/feed', title: 'Second', addedAt: 20, starred: true },
        ],
        [`${SUBSCRIPTION_PREFIX}first`]: {
            id: 'first', url: 'https://first.test/feed', title: 'Updated first', addedAt: 10, starred: true,
        },
    });
    setChrome(sync);

    const migrated = await migrateSubscriptions();

    assert.deepEqual(migrated, [
        { id: 'first', url: 'https://first.test/feed', title: 'Updated first', addedAt: 10, starred: true },
        { id: 'second', url: 'https://second.test/feed', title: 'Second', addedAt: 20, starred: true },
    ]);
    assert.equal(Object.hasOwn(sync.data, 'subscriptions'), false);
    assert.deepEqual(await getSubscriptions(), migrated);
    assert.equal(sync.setCalls.length, 1);
    assert.deepEqual(Object.keys(sync.setCalls[0]), [`${SUBSCRIPTION_PREFIX}second`]);
});

test('migration retains legacy data after a failed write and succeeds on retry', async () => {
    const sync = createSyncArea({
        subscriptions: [
            { id: 'one', url: 'https://one.test/feed', title: 'One', addedAt: 1 },
            { id: 'two', url: 'https://two.test/feed', title: 'Two', addedAt: 2 },
        ],
    });
    setChrome(sync);
    sync.failNextSet(new Error('sync quota exceeded'));

    await assert.rejects(migrateSubscriptions(), /sync quota exceeded/);
    assert.equal(Object.hasOwn(sync.data, 'subscriptions'), true);
    assert.equal(Object.hasOwn(sync.data, `${SUBSCRIPTION_PREFIX}one`), false);
    assert.equal(Object.hasOwn(sync.data, `${SUBSCRIPTION_PREFIX}two`), false);

    const retried = await migrateSubscriptions();
    assert.deepEqual(retried.map(({ id }) => id), ['one', 'two']);
    assert.equal(Object.hasOwn(sync.data, 'subscriptions'), false);
    assert.equal(Object.hasOwn(sync.data, `${SUBSCRIPTION_PREFIX}one`), true);
    assert.equal(Object.hasOwn(sync.data, `${SUBSCRIPTION_PREFIX}two`), true);
    assert.equal(sync.setCalls.length, 2);
});

test('migrates 90 subscriptions as individual records in one sync write', async () => {
    const subscriptions = Array.from({ length: 90 }, (_, index) => ({
        id: `feed-${index}`,
        url: `https://feed-${index}.test/rss`,
        title: `Feed ${index}`,
        addedAt: index,
    }));
    const sync = createSyncArea({ subscriptions });
    setChrome(sync);

    const migrated = await migrateSubscriptions();

    assert.equal(migrated.length, 90);
    assert.equal(sync.setCalls.length, 1);
    assert.equal(Object.keys(sync.setCalls[0]).length, 90);
    assert.equal(Object.keys(sync.data).filter((key) => key.startsWith(SUBSCRIPTION_PREFIX)).length, 90);
    assert.equal(Object.hasOwn(sync.data, 'subscriptions'), false);
});
