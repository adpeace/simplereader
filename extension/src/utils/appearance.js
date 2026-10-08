import { getSettings } from './storage.js';
import { normalizeSettings } from './settings.js';

export function applyAppearance(value, prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches) {
    const settings = normalizeSettings(value);
    const dark = settings.theme === 'dark' || (settings.theme === 'system' && prefersDark);
    const root = document.documentElement;
    root.setAttribute('data-design', settings.designTheme);
    root.setAttribute('data-theme', dark ? 'dark' : 'light');
    root.setAttribute('data-fontsize', settings.fontSize);
}

// Shared by the reader and popup. Listen before loading so a late storage read
// cannot overwrite a newer preference, and ignore reads after unmount.
export function observeAppearance(onSettings = () => {}, onError = () => {}) {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const storageEvents = chrome.storage.onChanged;
    let settings = normalizeSettings();
    let disposed = false;
    let revision = 0;

    const apply = value => {
        settings = normalizeSettings(value);
        applyAppearance(settings, media.matches);
        onSettings(settings);
    };
    const onStorageChange = (changes, area) => {
        if (area !== 'sync' || !changes.settings) return;
        revision += 1;
        apply(changes.settings.newValue);
    };
    const onSystemChange = () => applyAppearance(settings, media.matches);
    storageEvents.addListener(onStorageChange);
    media.addEventListener('change', onSystemChange);

    const loadRevision = revision;
    getSettings().then(value => {
        if (!disposed && revision === loadRevision) apply(value);
    }).catch(error => {
        if (!disposed && revision === loadRevision) onError(error);
    });

    return () => {
        disposed = true;
        storageEvents.removeListener(onStorageChange);
        media.removeEventListener('change', onSystemChange);
    };
}
