import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchFeed } from '../src/utils/fetcher.js';

const feedUrl = 'https://example.com/feed.xml';
const MAX_FEED_BYTES = 20 * 1024 * 1024;

function responseWithBody(body, options) {
    return new Response(body, options);
}

test('Atom retains the reported article content base and resolves relative alternate links', async t => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom" xml:base="https://anil.recoil.org/">
        <link rel="self" href="news.xml"/><link href="/"/>
        <entry><id>weekly-note</id><link href="/notes/2026w41"/>
            <content type="html" xml:base="https://anil.recoil.org/">&lt;img src="/images/w41-photos.webp"&gt;</content>
        </entry></feed>`;
    t.mock.method(globalThis, 'fetch', async () => responseWithBody(xml));
    const parsed = await fetchFeed(feedUrl);
    assert.equal(parsed.siteLink, 'https://anil.recoil.org/');
    assert.equal(parsed.items[0].link, 'https://anil.recoil.org/notes/2026w41');
    assert.equal(parsed.items[0].contentBaseUrl, 'https://anil.recoil.org/');
    assert.equal(parsed.items[0].content, '<img src="/images/w41-photos.webp">');
});

test('Atom inherits nested XML bases and uses the final feed response URL after redirects', async t => {
    let xml = `<feed xmlns="http://www.w3.org/2005/Atom" xml:base="../site/">
        <entry xml:base="posts/"><id>entry</id><link xml:base="../" href="article"/>
            <summary xml:base="../../media/" type="html">Image</summary></entry></feed>`;
    t.mock.method(globalThis, 'fetch', async () => {
        const response = responseWithBody(xml);
        Object.defineProperty(response, 'url', { value: 'https://redirected.example/feeds/atom.xml' });
        return response;
    });
    const parsed = await fetchFeed(feedUrl);
    assert.equal(parsed.items[0].link, 'https://redirected.example/site/article');
    assert.equal(parsed.items[0].contentBaseUrl, 'https://redirected.example/media/');

    xml = '<feed><entry><id>entry</id><link href="post"/><content>Text</content></entry></feed>';
    const withoutBase = await fetchFeed(feedUrl);
    assert.equal(withoutBase.items[0].link, 'https://redirected.example/feeds/post');
    assert.equal(withoutBase.items[0].contentBaseUrl, 'https://redirected.example/feeds/atom.xml');
});

test('RSS and RDF resolve relative article links without changing stable item IDs', async t => {
    let xml;
    t.mock.method(globalThis, 'fetch', async () => responseWithBody(xml));
    for (xml of [
        '<rss><channel><link>/</link><item><link>/posts/article</link><description>Article</description></item></channel></rss>',
        '<rdf:RDF><channel><link>/</link></channel><item><link>/posts/article</link><description>Article</description></item></rdf:RDF>',
    ]) {
        const parsed = await fetchFeed(feedUrl);
        assert.equal(parsed.siteLink, 'https://example.com/');
        assert.equal(parsed.items[0].id, '/posts/article');
        assert.equal(parsed.items[0].link, 'https://example.com/posts/article');
        assert.equal(parsed.items[0].contentBaseUrl, 'https://example.com/posts/article');
    }
});

test('RSS respects XML bases on the feed, item, and selected content element', async t => {
    const xml = `<rss xml:base="../"><channel xml:base="site/">
        <item xml:base="posts/"><guid>stable</guid><link>article</link>
            <description xml:base="../../media/">Image</description></item></channel></rss>`;
    t.mock.method(globalThis, 'fetch', async () => responseWithBody(xml));
    const parsed = await fetchFeed('https://example.com/feeds/rss.xml');
    assert.equal(parsed.items[0].id, 'stable');
    assert.equal(parsed.items[0].link, 'https://example.com/site/posts/article');
    assert.equal(parsed.items[0].contentBaseUrl, 'https://example.com/media/');
});

test('numeric Atom text and attributed values are returned as strings, including zero', async t => {
    const xml = `<?xml version="1.0"?>
        <feed xmlns="http://www.w3.org/2005/Atom">
            <title>0</title>
            <entry>
                <id>urn:entry:1</id>
                <title type="text">0</title>
                <content type="text">123</content>
            </entry>
        </feed>`;
    t.mock.method(globalThis, 'fetch', async () => responseWithBody(xml));

    const parsed = await fetchFeed(feedUrl);

    assert.equal(parsed.title, '0');
    assert.equal(parsed.items[0].title, '0');
    assert.equal(parsed.items[0].content, '123');
    assert.equal(typeof parsed.items[0].content, 'string');
});

test('empty RSS, Atom, and RDF feeds produce empty item arrays', async t => {
    let xml = '';
    t.mock.method(globalThis, 'fetch', async () => responseWithBody(xml));

    const emptyFeeds = [
        '<rss version="2.0"><channel><title>RSS</title></channel></rss>',
        '<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title></feed>',
        '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/"><channel><title>RDF</title></channel></rdf:RDF>',
        '<rss/>',
        '<feed xmlns="http://www.w3.org/2005/Atom"/>',
        '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/"/>'
    ];

    for (const feed of emptyFeeds) {
        xml = feed;
        const parsed = await fetchFeed(feedUrl);
        assert.deepEqual(parsed.items, []);
    }
});

test('plain RSS GUID text keeps articles with the same title distinct', async t => {
    const xml = `<rss version="2.0"><channel><title>RSS</title>
        <item><guid>https://example.com/article/1</guid><title>Daily update</title></item>
        <item><guid>https://example.com/article/2</guid><title>Daily update</title></item>
    </channel></rss>`;
    t.mock.method(globalThis, 'fetch', async () => responseWithBody(xml));

    const parsed = await fetchFeed(feedUrl);

    assert.deepEqual(parsed.items.map(item => item.id), [
        'https://example.com/article/1',
        'https://example.com/article/2'
    ]);
});

test('304 returns null and sends cached conditional request headers', async t => {
    let requestOptions;
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
        requestOptions = options;
        return responseWithBody(null, { status: 304 });
    });

    const result = await fetchFeed(feedUrl, {
        etag: '"saved-etag"',
        lastModified: 'Sat, 12 Sep 2026 00:00:00 GMT'
    });

    assert.equal(result, null);
    assert.equal(requestOptions.headers['If-None-Match'], '"saved-etag"');
    assert.equal(requestOptions.headers['If-Modified-Since'], 'Sat, 12 Sep 2026 00:00:00 GMT');
});

test('DOCTYPE declarations are rejected while standard XML entities still parse', async t => {
    let xml = '<!DOCTYPE rss [<!ENTITY injected "replacement">]><rss><channel><title>&injected;</title></channel></rss>';
    t.mock.method(globalThis, 'fetch', async () => responseWithBody(xml));
    t.mock.method(console, 'error', () => {});

    await assert.rejects(fetchFeed(feedUrl), /DOCTYPE declarations are not supported/);

    xml = '<!-- <!DOCTYPE text in a comment is not a declaration> --><rss version="2.0"><channel><title>A &amp; B &lt; C</title></channel></rss>';
    const parsed = await fetchFeed(feedUrl);
    assert.equal(parsed.title, 'A & B < C');
});

test('feeds at the 20 MiB limit parse with and without Content-Length', async t => {
    const prefix = '<rss version="2.0"><channel><title>Large feed</title><!--';
    const suffix = '--><item><guid>large-1</guid><title>Article</title><description>Full article</description></item></channel></rss>';
    const xml = prefix + ' '.repeat(MAX_FEED_BYTES - prefix.length - suffix.length) + suffix;
    let headers;
    t.mock.method(globalThis, 'fetch', async () => responseWithBody(xml, { headers }));

    for (headers of [{ 'Content-Length': String(MAX_FEED_BYTES) }, {}]) {
        const parsed = await fetchFeed(feedUrl);
        assert.equal(parsed.title, 'Large feed');
        assert.equal(parsed.items.length, 1);
        assert.equal(parsed.items[0].content, 'Full article');
    }
});

test('oversized feed responses are rejected by Content-Length and streamed byte count', async t => {
    let headerBodyCancelled = false;
    let response = responseWithBody(new ReadableStream({
        cancel() { headerBodyCancelled = true; }
    }), {
        headers: { 'Content-Length': String(MAX_FEED_BYTES + 1) }
    });
    t.mock.method(globalThis, 'fetch', async () => response);
    t.mock.method(console, 'error', () => {});

    await assert.rejects(fetchFeed(feedUrl), /Feed response exceeds the 20 MiB limit/);
    assert.equal(headerBodyCancelled, true);

    let streamedBodyCancelled = false;
    let streamedSecondChunk = false;
    response = responseWithBody(new ReadableStream({
        start(controller) {
            controller.enqueue(new Uint8Array(MAX_FEED_BYTES));
        },
        pull(controller) {
            if (!streamedSecondChunk) {
                streamedSecondChunk = true;
                controller.enqueue(new Uint8Array([0]));
            }
        },
        cancel() { streamedBodyCancelled = true; }
    }));
    await assert.rejects(fetchFeed(feedUrl), /Feed response exceeds the 20 MiB limit/);
    assert.equal(streamedBodyCancelled, true);
});

test('the ten-second abort deadline remains active while the response body is stalled', async t => {
    let signal;
    let deadline;
    let deadlineMs;
    let clearCount = 0;
    let bodyStarted;
    const bodyReadStarted = new Promise(resolve => { bodyStarted = resolve; });

    t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
        deadline = callback;
        deadlineMs = delay;
        return 1;
    });
    t.mock.method(globalThis, 'clearTimeout', () => { clearCount += 1; });
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
        signal = options.signal;
        const body = new ReadableStream({
            start(controller) {
                signal.addEventListener('abort', () => {
                    controller.error(new DOMException('The operation was aborted', 'AbortError'));
                });
                bodyStarted();
            }
        });
        return responseWithBody(body);
    });
    t.mock.method(console, 'error', () => {});

    const pending = fetchFeed(feedUrl);
    await bodyReadStarted;
    assert.equal(deadlineMs, 10000);
    assert.equal(clearCount, 0);

    deadline();
    await assert.rejects(pending, /aborted/i);
    assert.equal(signal.aborted, true);
    assert.equal(clearCount, 1);
});
