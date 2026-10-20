import DOMPurify from 'dompurify';
import { getArticleUrl } from './links.js';

function resolveUrl(value, baseUrl) {
    // Leave absolute schemes for DOMPurify to validate, including mailto and
    // inline images. Never use the extension document as an implicit base.
    if (/^[a-z][a-z\d+.-]*:/i.test(value.trim())) return value;
    return getArticleUrl(value, baseUrl);
}

function resolveSrcset(value, baseUrl) {
    const candidates = [];
    let remaining = value;
    while (remaining) {
        remaining = remaining.replace(/^[\s,]+/, '');
        if (!remaining) break;
        // A URL ends at whitespace, not a comma: data URLs and ordinary URLs
        // can contain commas. A trailing comma ends a descriptorless candidate.
        const token = remaining.match(/^\S+/)[0];
        remaining = remaining.slice(token.length);
        const url = token.replace(/,+$/, '');
        let descriptor = '';
        if (!token.endsWith(',')) {
            const end = remaining.indexOf(',');
            descriptor = (end < 0 ? remaining : remaining.slice(0, end)).trim();
            remaining = end < 0 ? '' : remaining.slice(end + 1);
        }
        const resolved = resolveUrl(url, baseUrl);
        // DOMPurify's default policy permits data images in src, but not in
        // srcset. Drop those candidates without discarding other usable ones.
        if (resolved && /^https?:/i.test(resolved)) {
            candidates.push(resolved + (descriptor ? ` ${descriptor}` : ''));
        }
    }
    return candidates.join(', ');
}

export function sanitizeArticleContent(content, baseUrl) {
    // Template contents are inert: resources and scripts do not run while URLs
    // are being resolved. Sanitize the final HTML after every transformation.
    const template = document.createElement('template');
    template.innerHTML = String(content);
    // Use sanitized targets so a stripped script or reserved ID cannot make a
    // source-page fragment look like a working in-reader link.
    const sanitizedTargets = DOMPurify.sanitize(template.innerHTML, { RETURN_DOM_FRAGMENT: true });
    const localTargets = new Set();
    for (const element of sanitizedTargets.querySelectorAll('[id], a[name]')) {
        if (element.id) localTargets.add(element.id);
        if (element.localName === 'a' && element.getAttribute('name')) {
            localTargets.add(element.getAttribute('name'));
        }
    }

    function isLocalFragment(attribute, value) {
        if (attribute !== 'href' && attribute !== 'xlink:href') return false;
        const fragment = value.trim();
        if (!fragment.startsWith('#')) return false;
        try {
            return localTargets.has(decodeURIComponent(fragment.slice(1)));
        } catch {
            return false;
        }
    }

    function resolveElements(parent, inheritedBase) {
        for (const element of parent.children) {
            const elementBase = getArticleUrl(element.getAttribute('xml:base'), inheritedBase) || inheritedBase;
            element.removeAttribute('xml:base');
            for (const attribute of ['href', 'src', 'poster', 'cite', 'xlink:href']) {
                if (!element.hasAttribute(attribute)) continue;
                const value = element.getAttribute(attribute);
                // Footnotes, section links, and SVG references whose targets
                // are in this article should keep working inside the reader.
                if (isLocalFragment(attribute, value)) continue;
                const resolved = resolveUrl(value, elementBase);
                if (resolved) element.setAttribute(attribute, resolved);
                else element.removeAttribute(attribute);
            }
            if (element.hasAttribute('srcset')) {
                const resolved = resolveSrcset(element.getAttribute('srcset'), elementBase);
                if (resolved) element.setAttribute('srcset', resolved);
                else element.removeAttribute('srcset');
            }
            resolveElements(element, elementBase);
        }
    }
    resolveElements(template.content, getArticleUrl(baseUrl));
    return DOMPurify.sanitize(template.innerHTML);
}
