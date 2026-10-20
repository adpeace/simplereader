import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('', { url: 'https://reader.invalid/dashboard.html' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
const { sanitizeArticleContent } = await import('../src/utils/content.js');

function render(content, baseUrl = 'https://anil.recoil.org/notes/2026w41') {
    const template = document.createElement('template');
    template.innerHTML = sanitizeArticleContent(content, baseUrl);
    return template.content;
}

test('article links and media resolve against the source, never the reader', () => {
    const body = render(`<a href="/notes/focs">Course</a>
        <a href="../papers?q=a&amp;b=c#result">Papers</a><a href="#section">Section</a>
        <img src="/images/w41-photos.webp" srcset="/images/w41-photos.320.webp 320w,/images/w41-photos.768.webp 768w">
        <picture><source srcset="//cdn.example.com/photo.webp 1x, photo@2x.webp 2x"></picture>
        <video poster="../poster.jpg"><source src="movie.mp4"></video>`);
    assert.deepEqual([...body.querySelectorAll('a')].map(a => a.getAttribute('href')), [
        'https://anil.recoil.org/notes/focs',
        'https://anil.recoil.org/papers?q=a&b=c#result',
        'https://anil.recoil.org/notes/2026w41#section',
    ]);
    assert.equal(body.querySelector('img').getAttribute('src'), 'https://anil.recoil.org/images/w41-photos.webp');
    assert.equal(body.querySelector('img').getAttribute('srcset'),
        'https://anil.recoil.org/images/w41-photos.320.webp 320w, https://anil.recoil.org/images/w41-photos.768.webp 768w');
    assert.equal(body.querySelector('picture source').getAttribute('srcset'),
        'https://cdn.example.com/photo.webp 1x, https://anil.recoil.org/notes/photo@2x.webp 2x');
    assert.equal(body.querySelector('video').getAttribute('poster'), 'https://anil.recoil.org/poster.jpg');
    assert.equal(body.querySelector('video source').getAttribute('src'), 'https://anil.recoil.org/notes/movie.mp4');
});

test('safe absolute links and inline images survive, with usable mixed srcset candidates', () => {
    const body = render(`<a href="https://other.example/a?q=1#b">Web</a><a href="mailto:me@example.com">Email</a>
        <img src="data:image/png;base64,AAAA" srcset="data:image/png;base64,AAAA 1x, /large.png 2x">
        <img srcset="/small.png, /large.png 2x">`);
    assert.equal(body.querySelector('a').getAttribute('href'), 'https://other.example/a?q=1#b');
    assert.equal(body.querySelectorAll('a')[1].getAttribute('href'), 'mailto:me@example.com');
    assert.equal(body.querySelector('img').getAttribute('src'), 'data:image/png;base64,AAAA');
    assert.equal(body.querySelector('img').getAttribute('srcset'),
        'https://anil.recoil.org/large.png 2x');
    assert.equal(body.querySelectorAll('img')[1].getAttribute('srcset'),
        'https://anil.recoil.org/small.png, https://anil.recoil.org/large.png 2x');
});

test('in-article fragments stay local while missing targets resolve against the source', () => {
    const body = render(`<p id="note-1">Note</p><a href="#note-1">Footnote</a>
        <h2 id="résumé">Section</h2><a href="#r%C3%A9sum%C3%A9">Section link</a>
        <a name="legacy-note"></a><a href="#legacy-note">Named anchor</a>
        <a href="#missing">On the source</a><a href="#bad%escape">Malformed escape</a>`, 'https://example.com/');
    assert.deepEqual([...body.querySelectorAll('a[href]')].map(a => a.getAttribute('href')), [
        '#note-1', '#r%C3%A9sum%C3%A9', '#legacy-note',
        'https://example.com/#missing', 'https://example.com/#bad%escape',
    ]);
});

test('fragment targets removed by sanitization resolve against the source', () => {
    const body = render('<script id="removed">ignored</script><a href="#removed">Source link</a>', 'https://example.com/');
    assert.equal(body.querySelector('#removed'), null);
    assert.equal(body.querySelector('a').getAttribute('href'), 'https://example.com/#removed');
});

test('nested XML bases are scoped and an HTML base tag cannot change the reader base', () => {
    const body = render(`<base href="https://wrong.example/"><div xml:base="https://cdn.example/assets/">
        <img src="photo.png"><div xml:base="../other/"><img src="photo.png"></div></div><img src="photo.png">`);
    assert.equal(body.querySelector('base'), null);
    assert.deepEqual([...body.querySelectorAll('img')].map(img => img.getAttribute('src')), [
        'https://cdn.example/assets/photo.png', 'https://cdn.example/other/photo.png',
        'https://anil.recoil.org/notes/photo.png',
    ]);
});

test('URL rewriting retains HTML sanitization and rejects unsafe srcset candidates', () => {
    const body = render(`<script>alert(1)</script><a href="java&#x73;cript:alert(1)">Bad</a>
        <img src="/ok.png" onerror="alert(1)" srcset="javascript:alert(1) 1x, /ok.png 2x">
        <iframe src="/embed"></iframe>`);
    assert.equal(body.querySelector('script, iframe, [onerror]'), null);
    assert.equal(body.querySelector('a').hasAttribute('href'), false);
    assert.equal(body.querySelector('img').getAttribute('srcset'), 'https://anil.recoil.org/ok.png 2x');
});

test('missing or unsafe bases never leave unresolved extension-relative resources', () => {
    for (const base of [undefined, 'javascript:alert(1)', 'chrome-extension://reader/dashboard.html']) {
        const body = render('<a href="/post">Link</a><img src="pic.jpg" srcset="pic.jpg 1x">', base ?? null);
        assert.equal(body.querySelector('a').hasAttribute('href'), false);
        assert.equal(body.querySelector('img').hasAttribute('src'), false);
        assert.equal(body.querySelector('img').hasAttribute('srcset'), false);
    }
});
