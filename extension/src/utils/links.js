// Feed-provided article links must point to a web page before we open them.
export function getArticleUrl(link) {
    if (typeof link !== 'string') return null;
    try {
        const url = new URL(link);
        return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
    } catch {
        return null;
    }
}
