import React, { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import DOMPurify from 'dompurify';
import '../App.css';
import {
    getSubscriptions, SUBSCRIPTION_PREFIX,
    getItems,
    getLastRefreshed,
    getSettings, saveSettings,
    getFeedValidators
} from '../utils/storage';
import { parseOPML, generateOPML } from '../utils/opml';

const PAGE_SIZE = 50;
const articleKey = (itemId, feedId) => JSON.stringify([feedId, itemId]);

async function requestBackground(request) {
    const response = await chrome.runtime.sendMessage(request);
    if (!response?.success) {
        const error = new Error(response?.error || 'The reader could not complete this action. Please try again.');
        error.code = response?.code;
        throw error;
    }
    return response;
}

// Strip HTML tags for collapsed plain-text previews — no DOMPurify needed.
function stripHtml(html) {
    // Older versions may already have cached numeric Atom text.
    const stripped = String(html ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    const ta = document.createElement('textarea');
    ta.innerHTML = stripped;
    return ta.value;
}

function applyAppearance(cfg) {
    const dark = cfg.theme === 'dark' ||
        (cfg.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    document.documentElement.setAttribute('data-fontsize', cfg.fontSize || 'medium');
}

// Memoized per-article component. Only re-renders when its own props change,
// so expanding one article doesn't re-render all others.
const ArticleItem = React.memo(function ArticleItem({ item, feedTitle, isExpanded, isFocused, onToggle }) {
    const ref = useRef(null);

    useEffect(() => {
        if (isFocused && ref.current) ref.current.scrollIntoView({ block: 'nearest' });
    }, [isFocused]);

    // Plain text excerpt for collapsed view — computed once, no sanitization.
    const textExcerpt = useMemo(() => {
        if (item.content == null || item.content === '') return '';
        return stripHtml(item.content).slice(0, 300);
    }, [item.content]);

    // Sanitize only when expanded, and only once per item (memoized by isExpanded + content).
    const sanitizedContent = useMemo(() => {
        if (!isExpanded || item.content == null || item.content === '') return null;
        return DOMPurify.sanitize(String(item.content), {
            ADD_TAGS: ['img'],
            ADD_ATTR: ['src', 'width', 'height', 'alt']
        });
    }, [isExpanded, item.content]);

    const pubDate = item.pubDate
        ? new Date(item.pubDate).toLocaleDateString('en-US', {
            month: 'short', day: 'numeric', year: 'numeric'
        })
        : '';

    return (
        <article
            ref={ref}
            className={`article-item${isExpanded ? ' expanded' : ''}${isFocused ? ' focused' : ''}`}
            onClick={() => onToggle(item.id, item.feedId)}
        >
            <h2 className="article-title">{item.title}</h2>

            <div className="article-meta">
                {feedTitle && <span className="feed-source">{feedTitle}</span>}
                {feedTitle && pubDate && <span className="meta-sep">·</span>}
                {pubDate && <time className="article-date">{pubDate}</time>}
            </div>

            {/* Collapsed: cheap plain-text preview, no sanitization */}
            {!isExpanded && textExcerpt && (
                <p className="article-preview">{textExcerpt}</p>
            )}

            {/* Expanded: full HTML, sanitized once and memoized */}
            {isExpanded && sanitizedContent && (
                <div className="article-excerpt expanded">
                    <div
                        className="article-body"
                        dangerouslySetInnerHTML={{ __html: sanitizedContent }}
                    />
                </div>
            )}

            {isExpanded && item.link && (
                <div className="article-actions">
                    <a
                        href={item.link}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="read-more-link"
                    >
                        Read full article →
                    </a>
                </div>
            )}
        </article>
    );
});

function Dashboard() {
    const [subscriptions, setSubscriptions] = useState([]);
    const [items, setItems] = useState([]);
    const [newFeedUrl, setNewFeedUrl] = useState('');
    const [loading, setLoading] = useState(false);
    const [feedError, setFeedError] = useState('');
    const [actionError, setActionError] = useState('');
    const [selectedFeedId, setSelectedFeedId] = useState(null);
    const [expandedItems, setExpandedItems] = useState(new Set());
    const [page, setPage] = useState(1);
    const [settings, setSettings] = useState({ theme: 'system', fontSize: 'medium' });
    const [focusedIndex, setFocusedIndex] = useState(null);

    const [showSettings, setShowSettings] = useState(false);
    const [importStatus, setImportStatus] = useState('');
    const [importFailures, setImportFailures] = useState([]);
    const [isImporting, setIsImporting] = useState(false);
    const fileInputRef = useRef(null);

    const [searchQuery, setSearchQuery] = useState('');

    const [lastRefreshedAt, setLastRefreshedAt] = useState(null);
    const [isRefreshing, setIsRefreshing] = useState(false);
    const [refreshStatus, setRefreshStatus] = useState(null);
    const [feedMeta, setFeedMeta] = useState({});
    const [now, setNow] = useState(() => Date.now());
    const [sidebarOpen, setSidebarOpen] = useState(false);

    // O(1) feed title lookup instead of O(n) find() called once per rendered item.
    const subMap = useMemo(
        () => Object.fromEntries(subscriptions.map(s => [s.id, s.title])),
        [subscriptions]
    );

    // Filter and sort items based on selected feed — all items always loaded for accurate unread counts.
    const displayItems = useMemo(() => {
        let filtered = selectedFeedId
            ? items.filter(i => i.feedId === selectedFeedId)
            : items;

        if (searchQuery.trim()) {
            const q = searchQuery.trim().toLowerCase();
            filtered = filtered.filter(i => {
                if (String(i.title ?? '').toLowerCase().includes(q)) return true;
                if (i.content != null) return stripHtml(i.content).toLowerCase().includes(q);
                return false;
            });
        }

        return [...filtered].sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
    }, [items, selectedFeedId, searchQuery]);

    // Per-feed unread counts, computed from full items list.
    const unreadByFeed = useMemo(() => {
        const counts = {};
        items.forEach(item => {
            if (!item.read) counts[item.feedId] = (counts[item.feedId] || 0) + 1;
        });
        return counts;
    }, [items]);

    const totalUnread = useMemo(() => items.filter(i => !i.read).length, [items]);

    // Starred feeds float to the top of the sidebar.
    const sortedSubscriptions = useMemo(() => [
        ...subscriptions.filter(s => s.starred),
        ...subscriptions.filter(s => !s.starred),
    ], [subscriptions]);

    // Only the slice of items for the current page goes into the DOM.
    const visibleItems = useMemo(
        () => displayItems.slice(0, page * PAGE_SIZE),
        [displayItems, page]
    );

    const hasMore = visibleItems.length < displayItems.length;

    // Relative time label — recomputed when the timestamp or the per-minute tick changes.
    const relativeTimeLabel = useMemo(() => {
        if (!lastRefreshedAt) return null;
        const diffMs = now - new Date(lastRefreshedAt).getTime();
        const diffMin = Math.floor(diffMs / 60000);
        if (diffMin < 1) return 'just now';
        if (diffMin < 60) return `${diffMin} min ago`;
        const diffHr = Math.floor(diffMin / 60);
        if (diffHr < 24) return `${diffHr}h ago`;
        return `${Math.floor(diffHr / 24)}d ago`;
    }, [lastRefreshedAt, now]);

    // useCallback makes the reference stable so ArticleItem's React.memo works correctly.
    const toggleExpand = useCallback((itemId, feedId) => {
        const key = articleKey(itemId, feedId);
        setExpandedItems(prev => {
            const next = new Set(prev);
            next.has(key) ? next.delete(key) : next.add(key);
            return next;
        });
        requestBackground({ type: 'MARK_READ', itemId, feedId })
            .catch(error => setActionError(`Could not save read status: ${error.message}`));
    }, []);

    const toggleStar = useCallback(async (feedId) => {
        setActionError('');
        try {
            await requestBackground({ type: 'TOGGLE_STAR', feedId });
        } catch (error) {
            setActionError(`Could not update this feed: ${error.message}`);
        }
    }, []);

    const itemsRequest = useRef(0);
    const refreshItems = useCallback(async () => {
        const request = ++itemsRequest.current;
        const allItems = await getItems();
        if (request === itemsRequest.current) setItems(allItems);
    }, []);

    useEffect(() => {
        async function init() {
            const [subs, ts, cfg, meta] = await Promise.all([
                getSubscriptions(), getLastRefreshed(), getSettings(), getFeedValidators()
            ]);
            setSubscriptions(subs);
            setLastRefreshedAt(ts);
            setSettings(cfg);
            setFeedMeta(meta);
            applyAppearance(cfg);
            await refreshItems();
        }
        init().catch(error => setActionError(`Could not load your reader: ${error.message}`));

        const handleStorageChange = (changes, area) => {
            if (area === 'sync' && Object.keys(changes).some(key => key === 'subscriptions' || key.startsWith(SUBSCRIPTION_PREFIX))) {
                getSubscriptions().then(subs => {
                    setSubscriptions(subs);
                    setSelectedFeedId(current => subs.some(sub => sub.id === current) ? current : null);
                    return refreshItems();
                }).catch(error => setActionError(`Could not load subscriptions: ${error.message}`));
            }
            if (area === 'local') {
                if (changes.lastRefreshedAt) {
                    setLastRefreshedAt(changes.lastRefreshedAt.newValue || null);
                }
                if (changes.feedMeta) {
                    setFeedMeta(changes.feedMeta.newValue || {});
                }
                refreshItems().catch(error => setActionError(`Could not load articles: ${error.message}`));
            }
        };
        chrome.storage.onChanged.addListener(handleStorageChange);

        // Tick every minute so the relative-time label stays current
        const ticker = setInterval(() => setNow(Date.now()), 60000);

        return () => {
            chrome.storage.onChanged.removeListener(handleStorageChange);
            clearInterval(ticker);
        };
    }, [refreshItems]);

    // Keyboard navigation: j/k or arrows to move focus, Enter to expand/collapse, Escape to close modal.
    useEffect(() => {
        const handler = (e) => {
            if (e.key === 'Escape') {
                setShowSettings(false);
                return;
            }
            if (showSettings || e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey ||
                e.target.closest('input, textarea, select, button, a, [role="button"], [contenteditable="true"]')) return;
            if (e.key === 'j' || e.key === 'ArrowDown') {
                e.preventDefault();
                setFocusedIndex(prev => Math.min((prev ?? -1) + 1, visibleItems.length - 1));
            } else if (e.key === 'k' || e.key === 'ArrowUp') {
                e.preventDefault();
                setFocusedIndex(prev => Math.max((prev ?? visibleItems.length) - 1, 0));
            } else if (e.key === 'Enter' && focusedIndex !== null) {
                const item = visibleItems[focusedIndex];
                if (item) toggleExpand(item.id, item.feedId);
            }
        };
        document.addEventListener('keydown', handler);
        return () => document.removeEventListener('keydown', handler);
    }, [focusedIndex, visibleItems, toggleExpand, showSettings]);

    const handleSaveSettings = async (patch) => {
        const updated = { ...settings, ...patch };
        try {
            await saveSettings(updated);
            setSettings(updated);
            applyAppearance(updated);
        } catch (error) {
            setActionError(`Could not save settings: ${error.message}`);
        }
    };

    const handleManualRefresh = async () => {
        if (isRefreshing) return;
        setIsRefreshing(true);
        setRefreshStatus(null);
        try {
            const response = await chrome.runtime.sendMessage({ type: 'REFRESH_FEEDS' });
            if (!response) throw new Error('No response from the reader. Please try again.');
            const errors = (response.errors || []).map(failure => `${failure.title}: ${failure.error}`).join('; ');
            if (response.status === 'error' || response.success === false) {
                throw new Error(errors || response.error || 'No feeds could be refreshed.');
            }
            setRefreshStatus({
                failed: response.status === 'partial',
                message: response.status === 'partial'
                    ? `${response.refreshed} feeds refreshed; ${response.failed} failed. ${errors}`
                    : response.refreshed ? `Refreshed ${response.refreshed} feeds.` : 'No feeds to refresh.'
            });
        } catch (error) {
            setRefreshStatus({ failed: true, message: `Refresh failed: ${error.message}` });
        } finally {
            setIsRefreshing(false);
        }
    };

    const handleAddFeed = async (e) => {
        e.preventDefault();
        if (!newFeedUrl) return;
        setLoading(true);
        setFeedError('');
        try {
            await requestBackground({ type: 'ADD_FEED', url: newFeedUrl.trim() });
            setNewFeedUrl('');
        } catch (error) {
            setFeedError(error.message);
        } finally {
            setLoading(false);
        }
    };

    const handleDeleteFeed = async (id) => {
        if (!confirm('Unsubscribe from this feed?')) return;
        setActionError('');
        try {
            await requestBackground({ type: 'DELETE_FEED', feedId: id });
        } catch (error) {
            setActionError(`Could not remove this feed: ${error.message}`);
        }
    };

    const handleImportOPML = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        e.target.value = '';
        setIsImporting(true);
        setImportFailures([]);
        try {
            const text = await file.text();
            const feeds = parseOPML(text);
            setImportStatus(`Found ${feeds.length} feeds. Importing...`);
            let imported = 0;
            let skipped = 0;
            const failures = [];
            for (const [index, feed] of feeds.entries()) {
                setImportStatus(`Importing ${index + 1}/${feeds.length}: ${feed.title}`);
                try {
                    await requestBackground({ type: 'ADD_FEED', url: feed.url });
                    imported++;
                } catch (error) {
                    if (error.code === 'DUPLICATE_FEED') skipped++;
                    else failures.push(`${feed.title}: ${error.message}`);
                }
            }
            setImportFailures(failures);
            setImportStatus(`Imported ${imported}; skipped ${skipped} duplicates; failed ${failures.length}.`);
        } catch (err) {
            setImportStatus(`Could not import OPML: ${err.message}`);
        } finally {
            setIsImporting(false);
        }
    };

    const handleExportOPML = () => {
        const xml = generateOPML(subscriptions, feedMeta);
        const blob = new Blob([xml], { type: 'text/xml' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'subscriptions.opml';
        a.click();
    };

    const selectFeed = (feedId) => {
        setSelectedFeedId(feedId);
        setSidebarOpen(false);
        setPage(1);
        setFocusedIndex(null);
    };

    const sectionTitle = selectedFeedId
        ? subMap[selectedFeedId] ?? 'Feed'
        : 'Reading List';

    const siteLink = selectedFeedId ? (feedMeta[selectedFeedId]?.siteLink ?? null) : null;

    return (
        <div className="dashboard-container">
            {/* Sidebar */}
            <aside className={`sidebar${sidebarOpen ? ' open' : ''}`}>
                <div className="sidebar-masthead">
                    <span className="masthead-brand">
                        <img src="/icons/icon.svg" className="masthead-icon" alt="" />
                        <span className="masthead-title">SimpleReader</span>
                    </span>
                    <button
                        className="settings-btn"
                        onClick={() => setShowSettings(true)}
                        title="Settings"
                        aria-label="Settings"
                    >
                        ⚙
                    </button>
                </div>

                <form className="add-feed-form" onSubmit={handleAddFeed}>
                    <input
                        type="url"
                        aria-label="Feed URL"
                        aria-describedby={feedError ? 'feed-error' : undefined}
                        className="feed-url-input"
                        placeholder="https://example.com/rss"
                        value={newFeedUrl}
                        onChange={(e) => setNewFeedUrl(e.target.value)}
                    />
                    <button type="submit" className="subscribe-btn" disabled={loading}>
                        {loading ? 'Adding...' : '+ Subscribe'}
                    </button>
                    {feedError && <p id="feed-error" className="feed-error" role="alert">{feedError}</p>}
                </form>

                <nav className="feed-nav">
                    <ul className="feed-list">
                        <li
                            className={`feed-item ${!selectedFeedId ? 'active' : ''}`}
                            role="button"
                            tabIndex={0}
                            onClick={() => selectFeed(null)}
                            onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); selectFeed(null); } }}
                        >
                            <span className="feed-item-title">All Articles</span>
                            {totalUnread > 0 && <span className="feed-unread">{totalUnread}</span>}
                        </li>
                        {sortedSubscriptions.map(sub => (
                            <li
                                key={sub.id}
                                className={`feed-item ${selectedFeedId === sub.id ? 'active' : ''}`}
                                role="button"
                                tabIndex={0}
                                onClick={() => selectFeed(sub.id)}
                                onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); selectFeed(sub.id); } }}
                            >
                                <span className="feed-item-title">{sub.title}</span>
                                {unreadByFeed[sub.id] > 0 && (
                                    <span className="feed-unread">{unreadByFeed[sub.id]}</span>
                                )}
                                <button
                                    className={`feed-item-star ${sub.starred ? 'starred' : ''}`}
                                    onClick={(e) => { e.stopPropagation(); toggleStar(sub.id); }}
                                    title={sub.starred ? 'Unpin' : 'Pin to top'}
                                    aria-label={sub.starred ? 'Unstar feed' : 'Star feed'}
                                >
                                    {sub.starred ? '★' : '☆'}
                                </button>
                            </li>
                        ))}
                    </ul>
                </nav>
            </aside>

            {/* Main Content */}
            <main className="main-content">
                <header className="content-header">
                    <button
                        className="menu-btn"
                        onClick={() => setSidebarOpen(o => !o)}
                        aria-label="Toggle navigation"
                    >
                        ☰
                    </button>
                    <h1 className="section-title">
                        {siteLink ? (
                            <a
                                href={siteLink}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="section-title-link"
                                onClick={e => e.stopPropagation()}
                            >
                                {sectionTitle}
                            </a>
                        ) : sectionTitle}
                    </h1>
                    {displayItems.length > 0 && (
                        <span className="article-count">{displayItems.length} articles</span>
                    )}
                    <div className="header-refresh">
                        <input
                            type="search"
                            className="search-input"
                            placeholder="Search…"
                            value={searchQuery}
                            onChange={(e) => { setSearchQuery(e.target.value); setPage(1); setFocusedIndex(null); }}
                            aria-label="Search articles"
                        />
                        {isRefreshing ? (
                            <span className="last-updated">Refreshing…</span>
                        ) : relativeTimeLabel ? (
                            <span className="last-updated">Updated {relativeTimeLabel}</span>
                        ) : null}
                        <button
                            className="refresh-btn"
                            onClick={handleManualRefresh}
                            disabled={isRefreshing}
                            title="Refresh feeds"
                            aria-label="Refresh feeds"
                        >
                            ↻
                        </button>
                    </div>
                </header>

                {!showSettings && actionError && <p className="reader-status" role="alert">{actionError}</p>}
                {refreshStatus && <p className="reader-status" role={refreshStatus.failed ? 'alert' : 'status'}>{refreshStatus.message}</p>}

                <div className="article-list">
                    {displayItems.length === 0 && (
                        <div className="empty-state">
                            <p className="empty-headline">Nothing here yet.</p>
                            <p className="empty-body">
                                Add an RSS feed above, or import an OPML file via Settings.
                            </p>
                        </div>
                    )}

                    {visibleItems.map((item, index) => (
                        <ArticleItem
                            key={articleKey(item.id, item.feedId)}
                            item={item}
                            feedTitle={subMap[item.feedId]}
                            isExpanded={expandedItems.has(articleKey(item.id, item.feedId))}
                            isFocused={focusedIndex === index}
                            onToggle={toggleExpand}
                        />
                    ))}

                    {hasMore && (
                        <div className="load-more-container">
                            <button className="load-more-btn" onClick={() => setPage(p => p + 1)}>
                                Load more — {displayItems.length - visibleItems.length} remaining
                            </button>
                        </div>
                    )}
                </div>
            </main>

            {sidebarOpen && (
                <div
                    className="sidebar-backdrop"
                    aria-hidden="true"
                    onClick={() => setSidebarOpen(false)}
                />
            )}

            {/* Settings Modal */}
            {showSettings && (
                <div className="modal-overlay" onClick={() => setShowSettings(false)}>
                    <div
                        className="modal"
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="settings-title"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="modal-header">
                            <h2 className="modal-title" id="settings-title">Settings</h2>
                            <button
                                className="modal-close"
                                onClick={() => setShowSettings(false)}
                                aria-label="Close settings"
                            >
                                ✕
                            </button>
                        </div>

                        {actionError && <p className="reader-status" role="alert">{actionError}</p>}

                        <section className="modal-section">
                            <h3 className="modal-section-title">Appearance</h3>
                            <p className="modal-section-title" style={{ marginBottom: 8 }}>Theme</p>
                            <div className="modal-actions" style={{ marginBottom: 16 }}>
                                {['light', 'dark', 'system'].map(t => (
                                    <button key={t}
                                        className={`modal-btn ${settings.theme === t ? 'primary' : 'secondary'}`}
                                        onClick={() => handleSaveSettings({ theme: t })}>
                                        {t[0].toUpperCase() + t.slice(1)}
                                    </button>
                                ))}
                            </div>
                            <p className="modal-section-title" style={{ marginBottom: 8 }}>Font Size</p>
                            <div className="modal-actions">
                                {['small', 'medium', 'large'].map(s => (
                                    <button key={s}
                                        className={`modal-btn ${settings.fontSize === s ? 'primary' : 'secondary'}`}
                                        onClick={() => handleSaveSettings({ fontSize: s })}>
                                        {s[0].toUpperCase() + s.slice(1)}
                                    </button>
                                ))}
                            </div>
                        </section>

                        <section className="modal-section">
                            <h3 className="modal-section-title">OPML</h3>
                            <div className="modal-actions">
                                <button className="modal-btn primary" disabled={isImporting} onClick={() => fileInputRef.current.click()}>
                                    {isImporting ? 'Importing…' : 'Import OPML'}
                                </button>
                                <input
                                    type="file"
                                    accept=".opml,.xml"
                                    ref={fileInputRef}
                                    style={{ display: 'none' }}
                                    onChange={handleImportOPML}
                                />
                                <button className="modal-btn secondary" onClick={handleExportOPML}>
                                    Export OPML
                                </button>
                            </div>
                            {importStatus && <p className="import-status" role="status">{importStatus}</p>}
                            {importFailures.length > 0 && <ul className="import-errors">{importFailures.map((failure, index) => <li key={index}>{failure}</li>)}</ul>}
                        </section>

                        <section className="modal-section">
                            <h3 className="modal-section-title">Subscriptions</h3>
                            <ul className="subscription-list">
                                {subscriptions.map(sub => (
                                    <li key={sub.id} className="subscription-item">
                                        <span className="subscription-title">{sub.title}</span>
                                        <button
                                            className="delete-btn"
                                            onClick={() => handleDeleteFeed(sub.id)}
                                        >
                                            Remove
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        </section>
                    </div>
                </div>
            )}
        </div>
    );
}

export default Dashboard;
