// Feed-provided article links must point to a web page before we open them.
export function getArticleUrl(link, baseUrl) {
    if (typeof link !== 'string' || !link.trim()) return null;
    try {
        const url = new URL(link, baseUrl);
        return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
    } catch {
        return null;
    }
}
