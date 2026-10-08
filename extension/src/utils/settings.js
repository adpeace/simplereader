export const DESIGN_THEMES = [
    { id: 'default', label: 'Default' },
    { id: 'modern', label: 'Modern' },
];

export const DEFAULT_SETTINGS = {
    refreshInterval: 30,
    designTheme: 'default',
    theme: 'system',
    fontSize: 'medium',
    viewMode: 'preview',
    showUnreadOnly: false,
};

// Design, color mode, and view/filter preferences are independent.
// Retain unrecognized settings so an appearance change never resets them.
export function normalizeSettings(value) {
    const settings = { ...DEFAULT_SETTINGS, ...value };
    if (!DESIGN_THEMES.some(design => design.id === settings.designTheme)) settings.designTheme = 'default';
    if (!['light', 'dark', 'system'].includes(settings.theme)) settings.theme = 'system';
    if (!['small', 'medium', 'large'].includes(settings.fontSize)) settings.fontSize = 'medium';
    if (!['preview', 'headlines'].includes(settings.viewMode)) settings.viewMode = 'preview';
    return settings;
}
