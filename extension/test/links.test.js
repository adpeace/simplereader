import assert from 'node:assert/strict';
import test from 'node:test';
import { getArticleUrl } from '../src/utils/links.js';

test('article URLs accept HTTP and HTTPS and preserve query strings and fragments', () => {
    for (const url of [
        'http://example.com/article',
        'https://example.com/article?source=rss&topic=reading#section',
    ]) {
        assert.equal(getArticleUrl(url), url);
    }
    assert.equal(getArticleUrl(' HTTPS://example.com/article '), 'https://example.com/article');
});

test('article URLs reject executable, local, and browser-internal schemes', () => {
    for (const link of [
        'javascript:alert(1)',
        '\nJaVaScRiPt:alert(1)',
        'data:text/html,<script>alert(1)</script>',
        'file:///etc/passwd',
        'chrome://settings',
        'chrome-extension://example/dashboard.html',
        'mailto:reader@example.com',
        'ftp://example.com/article',
    ]) {
        assert.equal(getArticleUrl(link), null, link);
    }
});

test('article URLs reject missing, malformed, relative, and non-string feed values', () => {
    for (const link of [undefined, null, '', 'not a URL', '/article', '//example.com/article', 'https://', 123, {}, ['https://example.com/article']]) {
        assert.equal(getArticleUrl(link), null);
    }
});
