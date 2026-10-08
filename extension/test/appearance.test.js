import assert from 'node:assert/strict';
import test from 'node:test';
import { applyAppearance, observeAppearance } from '../src/utils/appearance.js';

function environment(t, initial = {}) {
    const attributes = new Map();
    const storageListeners = new Set();
    const systemListeners = new Set();
    const media = {
        matches: false,
        addEventListener: (_, callback) => systemListeners.add(callback),
        removeEventListener: (_, callback) => systemListeners.delete(callback),
    };
    const sync = { get: async () => ({ settings: initial }) };
    const values = {
        document: { documentElement: { setAttribute: (name, value) => attributes.set(name, value) } },
        window: { matchMedia: () => media },
        chrome: { storage: { sync, onChanged: {
            addListener: callback => storageListeners.add(callback),
            removeListener: callback => storageListeners.delete(callback),
        } } },
    };
    for (const [key, value] of Object.entries(values)) {
        const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
        Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
        t.after(() => {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        });
    }
    return {
        attributes, media, sync, storageListeners, systemListeners,
        storageChange(value, area = 'sync') {
            storageListeners.forEach(callback => callback({ settings: { newValue: value } }, area));
        },
        systemChange(dark) {
            media.matches = dark;
            systemListeners.forEach(callback => callback());
        },
    };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

test('all design/color combinations apply independently without resetting font size', t => {
    const env = environment(t);
    for (const designTheme of ['default', 'modern']) {
        for (const theme of ['light', 'dark', 'system']) {
            for (const prefersDark of [false, true]) {
                applyAppearance({ designTheme, theme, fontSize: 'large' }, prefersDark);
                assert.equal(env.attributes.get('data-design'), designTheme);
                assert.equal(env.attributes.get('data-theme'), theme === 'dark' || (theme === 'system' && prefersDark) ? 'dark' : 'light');
                assert.equal(env.attributes.get('data-fontsize'), 'large');
            }
        }
    }
});

test('saved appearance loads and follows synced preference and system changes', async t => {
    const env = environment(t, { designTheme: 'modern', theme: 'system' });
    let current;
    const stop = observeAppearance(value => { current = value; });
    t.after(stop);
    await flush();
    assert.equal(env.attributes.get('data-design'), 'modern');
    env.systemChange(true);
    assert.equal(env.attributes.get('data-theme'), 'dark');

    env.storageChange({ designTheme: 'default', theme: 'light', fontSize: 'small' });
    assert.equal(current.designTheme, 'default');
    assert.equal(env.attributes.get('data-fontsize'), 'small');
    env.systemChange(false);
    env.systemChange(true);
    assert.equal(env.attributes.get('data-theme'), 'light');

    env.storageChange({ designTheme: 'modern', theme: 'dark' }, 'local');
    assert.equal(env.attributes.get('data-design'), 'default');
    env.storageChange(undefined);
    assert.equal(current.theme, 'system');
    assert.equal(env.attributes.get('data-theme'), 'dark');
});

test('a delayed initial read cannot overwrite a newer storage change', async t => {
    const env = environment(t);
    let resolveRead;
    env.sync.get = () => new Promise(resolve => { resolveRead = resolve; });
    const stop = observeAppearance();
    t.after(stop);
    env.storageChange({ designTheme: 'modern', theme: 'dark' });
    resolveRead({ settings: { designTheme: 'default', theme: 'light' } });
    await flush();
    assert.equal(env.attributes.get('data-design'), 'modern');
    assert.equal(env.attributes.get('data-theme'), 'dark');
});

test('cleanup removes listeners and ignores pending initial reads', async t => {
    const env = environment(t);
    let resolveRead;
    env.sync.get = () => new Promise(resolve => { resolveRead = resolve; });
    const stop = observeAppearance(() => assert.fail('Unmounted observer received settings'));
    stop();
    resolveRead({ settings: { designTheme: 'modern' } });
    await flush();
    assert.equal(env.storageListeners.size, 0);
    assert.equal(env.systemListeners.size, 0);
    assert.equal(env.attributes.size, 0);
});

test('initial storage errors are reported without changing appearance', async t => {
    const env = environment(t);
    env.sync.get = async () => { throw new Error('storage unavailable'); };
    let error;
    const stop = observeAppearance(undefined, value => { error = value; });
    t.after(stop);
    await flush();
    assert.equal(error.message, 'storage unavailable');
    assert.equal(env.attributes.size, 0);
});
