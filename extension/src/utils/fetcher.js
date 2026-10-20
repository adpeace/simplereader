import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    // Keep values as strings so numeric article content remains usable by UI code.
    parseTagValue: false
});

function getText(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') {
        const text = value['#text'];
        return text === null || text === undefined ? '' : String(text);
    }
    return String(value);
}

function asArray(value) {
    if (value === null || value === undefined) return [];
    return Array.isArray(value) ? value : [value];
}

function hasDoctypeDeclaration(xmlText) {
    let cursor = 0;
    while (cursor < xmlText.length) {
        const start = xmlText.indexOf('<', cursor);
        if (start === -1) return false;

        if (xmlText.startsWith('<!--', start)) {
            const end = xmlText.indexOf('-->', start + 4);
            cursor = end === -1 ? xmlText.length : end + 3;
            continue;
        }
        if (xmlText.startsWith('<![CDATA[', start)) {
            const end = xmlText.indexOf(']]>', start + 9);
            cursor = end === -1 ? xmlText.length : end + 3;
            continue;
        }
        if (xmlText.startsWith('<?', start)) {
            const end = xmlText.indexOf('?>', start + 2);
            cursor = end === -1 ? xmlText.length : end + 2;
            continue;
        }
        if (/^<!DOCTYPE\b/i.test(xmlText.slice(start))) return true;

        // Skip a tag while respecting quoted attributes so lookalike text inside
        // an attribute cannot be mistaken for a declaration.
        let quote = null;
        let end = start + 1;
        for (; end < xmlText.length; end += 1) {
            const character = xmlText[end];
            if (quote) {
                if (character === quote) quote = null;
            } else if (character === '"' || character === "'") {
                quote = character;
            } else if (character === '>') {
                break;
            }
        }
        cursor = end + 1;
    }
    return false;
}

async function readResponseBody(response) {
    const declaredLength = response.headers.get('Content-Length');
    if (declaredLength !== null) {
        const length = Number(declaredLength);
        if (Number.isFinite(length) && length > MAX_FEED_BYTES) {
            void response.body?.cancel().catch(() => {});
            throw new Error(`Feed response exceeds the ${MAX_FEED_MIB} MiB limit`);
        }
    }

    if (!response.body) return '';

    const reader = response.body.getReader();
    const chunks = [];
    let totalBytes = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
            totalBytes += chunk.byteLength;
            if (totalBytes > MAX_FEED_BYTES) {
                void reader.cancel().catch(() => {});
                throw new Error(`Feed response exceeds the ${MAX_FEED_MIB} MiB limit`);
            }
            chunks.push(chunk);
        }
    } finally {
        reader.releaseLock();
    }

    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
}

const MAX_FEED_MIB = 20;
const MAX_FEED_BYTES = MAX_FEED_MIB * 1024 * 1024;

/**
 * Fetches and parses an RSS/Atom feed.
 *
 * Supports conditional requests: pass cached `etag` and/or `lastModified` from
 * a previous response and the server may reply with 304 Not Modified, in which
 * case this function returns `null` (no body, nothing changed).
 *
 * @param {string} url
 * @param {{ etag?: string|null, lastModified?: string|null }} [validators]
 * @returns {Promise<{title: string, items: Array, etag: string|null, lastModified: string|null} | null>}
 */
export async function fetchFeed(url, { etag, lastModified } = {}) {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error('Only http/https feed URLs are supported');
    }

    try {
        const headers = {};
        if (etag)         headers['If-None-Match'] = etag;
        if (lastModified) headers['If-Modified-Since'] = lastModified;

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);
        let response;
        let xmlText;
        try {
            response = await fetch(url, { signal: controller.signal, headers });
            if (response.status === 304) return null;
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            xmlText = await readResponseBody(response);
        } finally {
            clearTimeout(timeoutId);
        }

        if (hasDoctypeDeclaration(xmlText)) {
            throw new Error('DOCTYPE declarations are not supported in feeds');
        }
        const result = parser.parse(xmlText);

        let feed;
        // Normalize RSS vs Atom
        if (Object.prototype.hasOwnProperty.call(result, 'rss')) {
            feed = parseRSS2(result.rss ?? {});
        } else if (Object.prototype.hasOwnProperty.call(result, 'feed')) {
            feed = parseAtom(result.feed ?? {});
        } else if (Object.prototype.hasOwnProperty.call(result, 'rdf:RDF')) {
            feed = parseRSS1(result['rdf:RDF'] ?? {});
        } else {
            throw new Error('Unknown feed format');
        }

        return {
            ...feed,
            etag: response.headers.get('ETag'),
            lastModified: response.headers.get('Last-Modified'),
        };

    } catch (error) {
        console.error('Feed fetch error:', error);
        throw error;
    }
}

function parseRSS2(rss) {
    const channel = rss.channel ?? {};
    const items = asArray(channel.item);

    return {
        title: getText(channel.title),
        description: getText(channel.description),
        siteLink: channel.link || null,
        items: items.map(item => ({
            id: getText(item.guid) || getText(item.link) || getText(item.title),
            title: getText(item.title),
            link: item.link,
            content: getText(item['content:encoded'] || item.description),
            pubDate: item.pubDate,
            read: false
        }))
    };
}

function parseAtom(feed) {
    const entries = asArray(feed.entry);

    const siteLink = Array.isArray(feed.link)
        ? (feed.link.find(l => l['@_rel'] === 'alternate' || !l['@_rel'])?.['@_href'] ?? null)
        : (feed.link?.['@_href'] ?? null);

    return {
        title: getText(feed.title),
        siteLink,
        items: entries.map(entry => {
            // Atom links can be arrays or objects
            const link = Array.isArray(entry.link)
                ? entry.link.find(l => l['@_rel'] === 'alternate' || !l['@_rel'])?.['@_href']
                : entry.link?.['@_href'];

            return {
                id: getText(entry.id),
                title: getText(entry.title),
                link: link,
                content: getText(entry.content || entry.summary),
                pubDate: entry.updated || entry.published,
                read: false
            };
        })
    };
}

function parseRSS1(rdf) {
    const channel = rdf.channel ?? {};
    const items = asArray(rdf.item);

    return {
        title: getText(channel.title),
        siteLink: channel.link || null,
        items: items.map(item => ({
            id: item.link || getText(item.title),
            title: getText(item.title),
            link: item.link,
            content: getText(item.description),
            pubDate: item['dc:date'],
            read: false
        }))
    }
}
