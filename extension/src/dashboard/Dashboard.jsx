import React, { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import DOMPurify from 'dompurify';
import '../App.css';
import {
    getSubscriptions, SUBSCRIPTION_PREFIX,
    getItems,
    getLastRefreshed,
    updateSettings,
    getFeedValidators
} from '../utils/storage';
import { parseOPML, generateOPML } from '../utils/opml';
import { getArticleUrl } from '../utils/links';
import { DESIGN_THEMES, DEFAULT_SETTINGS } from '../utils/settings';
import { applyAppearance, observeAppearance } from '../utils/appearance';

const PAGE_SIZE = 50;
const articleKey = (itemId, feedId) => JSON.stringify([feedId, itemId]);

async function requestBackground(request) {
    const response = await chrome.runtime.sendMessage(request);
    if (!response?.success) {
        const detail = response == null
            ? `The background worker returned no response for ${request.type}.`
            : `The background worker returned an unexpected response for ${request.type}: ${JSON.stringify(response)}.`;
        const error = new Error(response?.error || detail);
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

// Memoized per-article component. Only re-renders when its own props change,
// so expanding one article doesn't re-render all others.
const ArticleItem = React.memo(function ArticleItem({ item, feedTitle, isExpanded, isFocused, isCompact, onToggle, onMarkRead, isSavingRead }) {
    const ref = useRef(null);
    const sourceUrl = getArticleUrl(item.link);

    useEffect(() => {
        if (isFocused && ref.current) ref.current.scrollIntoView({ block: 'nearest' });
    }, [isFocused]);

    // Plain text excerpt for collapsed view — computed once, no sanitization.
    const textExcerpt = useMemo(() => {
        if (isCompact || item.content == null || item.content === '') return '';
        return stripHtml(item.content).slice(0, 300);
    }, [isCompact, item.content]);

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
            className={`article-item${item.read ? ' read' : ' unread'}${isExpanded ? ' expanded' : ''}${isFocused ? ' focused' : ''}`}
            onClick={() => onToggle(item.id, item.feedId)}
        >
            <h2 className="article-title">
                {isCompact && !isExpanded && !item.read && (
                    <span className="article-unread-dot" role="img" aria-label="Unread" />
                )}
                <span className="article-title-text">{item.title}</span>
                {sourceUrl && (
                    <a
                        href={sourceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="article-source-link"
                        aria-label={`Open original article: ${item.title} (opens in a new tab)`}
                        title="Open original article in a new tab"
                    >
                        <span aria-hidden="true">↗</span>
                    </a>
                )}
            </h2>

            {(!isCompact || isExpanded) && <div className="article-meta">
                {!item.read && <span className="article-unread-label">Unread</span>}
                {feedTitle && <span className="feed-source">{feedTitle}</span>}
                {feedTitle && pubDate && <span className="meta-sep">·</span>}
                {pubDate && <time className="article-date">{pubDate}</time>}
                <button
                    className="article-read-btn"
                    disabled={isSavingRead}
                    title={`${item.read ? 'Mark unread' : 'Mark read'} (r when focused)`}
                    aria-label={`${item.read ? 'Mark unread' : 'Mark read'}: ${item.title}`}
                    onClick={(e) => {
                        e.stopPropagation();
                        onMarkRead(item.id, item.feedId, !item.read);
                    }}
                >
                    {item.read ? 'Mark unread' : 'Mark read'}
                </button>
            </div>}

            {/* Collapsed: cheap plain-text preview, no sanitization */}
            {!isCompact && !isExpanded && textExcerpt && (
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

            {isExpanded && sourceUrl && (
                <div className="article-actions">
                    <a
                        href={sourceUrl}
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
    const expandedItemsRef = useRef(new Set());
    const pendingReadRef = useRef(new Map());
    const [pendingReadItems, setPendingReadItems] = useState(new Set());
    const bulkReadInProgress = useRef(false);
    const [isSavingBulkRead, setIsSavingBulkRead] = useState(false);
    const [bulkReadStatus, setBulkReadStatus] = useState(null);
    const [openFeedMenuId, setOpenFeedMenuId] = useState(null);
    const [page, setPage] = useState(1);
    const [settings, setSettings] = useState(DEFAULT_SETTINGS);
    const [isSavingSettings, setIsSavingSettings] = useState(false);
    const settingsSaveInProgress = useRef(false);
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

    const itemsRequest = useRef(0);
    const refreshItems = useCallback(async () => {
        const request = ++itemsRequest.current;
        const allItems = await getItems();
        if (request === itemsRequest.current) setItems(allItems);
    }, []);

    const setItemRead = useCallback((itemId, feedId, isRead, queueIfPending = false) => {
        const key = articleKey(itemId, feedId);
        const pending = pendingReadRef.current.get(key);
        if (pending && !queueIfPending) return pending;

        // Explicit toggles ignore repeat input while saving; opening an article
        // queues its read write after any pending unread write instead of losing it.
        const operation = (pending || Promise.resolve()).then(async () => {
            setActionError('');
            await requestBackground({ type: 'MARK_READ', itemId, feedId, isRead });
            // Read canonical storage rather than overwriting a newer change
            // that another reader tab may have committed while awaiting a reply.
            await refreshItems();
        }).catch(error => {
            setActionError(`Could not save read status: ${error.message}`);
        }).finally(() => {
            if (pendingReadRef.current.get(key) !== operation) return;
            pendingReadRef.current.delete(key);
            setPendingReadItems(new Set(pendingReadRef.current.keys()));
        });
        pendingReadRef.current.set(key, operation);
        setPendingReadItems(new Set(pendingReadRef.current.keys()));
        return operation;
    }, [refreshItems]);

    // Keep expansion independent of read state; collapsing must preserve a
    // manual "mark unread". The ref also handles rapid clicks before rendering.
    const toggleExpand = useCallback((itemId, feedId) => {
        const key = articleKey(itemId, feedId);
        const next = new Set(expandedItemsRef.current);
        const opening = !next.has(key);
        opening ? next.add(key) : next.delete(key);
        expandedItemsRef.current = next;
        setExpandedItems(next);
        if (opening) setItemRead(itemId, feedId, true, true);
    }, [setItemRead]);

    const closeFeedMenu = useCallback((restoreFocus = false) => {
        if (restoreFocus && openFeedMenuId) {
            document.getElementById(`feed-options-${openFeedMenuId}`)?.focus();
        }
        setOpenFeedMenuId(null);
    }, [openFeedMenuId]);

    const markAllAsRead = async (feedId = null) => {
        if (bulkReadInProgress.current) return;
        bulkReadInProgress.current = true;
        setIsSavingBulkRead(true);
        closeFeedMenu(true);
        setActionError('');
        try {
            const { changedItems } = await requestBackground({ type: 'MARK_ALL_READ', feedId });
            const count = changedItems.length;
            setBulkReadStatus({
                message: count ? `Marked ${count} ${count === 1 ? 'article' : 'articles'} as read${feedId ? ` in ${subMap[feedId]}` : ''}.` : 'No unread articles to mark.',
                items: changedItems,
            });
        } catch (error) {
            setActionError(`Could not mark articles as read: ${error.message}`);
        } finally {
            bulkReadInProgress.current = false;
            setIsSavingBulkRead(false);
        }
    };

    const undoBulkRead = async () => {
        if (bulkReadInProgress.current || !bulkReadStatus?.items.length) return;
        bulkReadInProgress.current = true;
        setIsSavingBulkRead(true);
        setActionError('');
        try {
            const { changedItems } = await requestBackground({ type: 'UNDO_MARK_ALL_READ', items: bulkReadStatus.items });
            setBulkReadStatus({ message: `Restored ${changedItems.length} unread ${changedItems.length === 1 ? 'article' : 'articles'}.`, items: [] });
        } catch (error) {
            setActionError(`Could not undo read status: ${error.message}`);
        } finally {
            bulkReadInProgress.current = false;
            setIsSavingBulkRead(false);
        }
    };

    useEffect(() => {
        if (!openFeedMenuId) return;
        const closeOutside = e => {
            if (!e.target.closest('[data-feed-menu-open="true"]')) setOpenFeedMenuId(null);
        };
        document.addEventListener('pointerdown', closeOutside);
        document.addEventListener('focusin', closeOutside);
        return () => {
            document.removeEventListener('pointerdown', closeOutside);
            document.removeEventListener('focusin', closeOutside);
        };
    }, [openFeedMenuId]);

    const toggleStar = useCallback(async (feedId) => {
        setActionError('');
        try {
            await requestBackground({ type: 'TOGGLE_STAR', feedId });
        } catch (error) {
            setActionError(`Could not update this feed: ${error.message}`);
        }
    }, []);

    useEffect(() => observeAppearance(setSettings, error => {
        setActionError(`Could not load appearance settings: ${error.message}`);
    }), []);

    useEffect(() => {
        async function init() {
            const [subs, ts, meta] = await Promise.all([
                getSubscriptions(), getLastRefreshed(), getFeedValidators()
            ]);
            setSubscriptions(subs);
            setLastRefreshedAt(ts);
            setFeedMeta(meta);
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

    // Keyboard navigation: j/k or arrows wrap focus, Enter to expand/collapse,
    // r toggles read status, o opens the original, Escape closes menus/modals.
    useEffect(() => {
        const handler = (e) => {
            if (e.key === 'Escape') {
                closeFeedMenu(true);
                setShowSettings(false);
                return;
            }
            if (showSettings || e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey ||
                e.target.closest('input, textarea, select, button, a, [role="button"], [contenteditable="true"]')) return;
            if (e.key === 'j' || e.key === 'ArrowDown') {
                e.preventDefault();
                setFocusedIndex(prev => visibleItems.length
                    ? ((prev ?? -1) + 1) % visibleItems.length
                    : null);
            } else if (e.key === 'k' || e.key === 'ArrowUp') {
                e.preventDefault();
                setFocusedIndex(prev => visibleItems.length
                    ? ((prev ?? visibleItems.length) - 1 + visibleItems.length) % visibleItems.length
                    : null);
            } else if (e.key === 'Enter' && focusedIndex !== null) {
                const item = visibleItems[focusedIndex];
                if (item) toggleExpand(item.id, item.feedId);
            } else if (e.key === 'r' && !e.repeat && focusedIndex !== null && !bulkReadInProgress.current) {
                const item = visibleItems[focusedIndex];
                if (item) {
                    e.preventDefault();
                    setItemRead(item.id, item.feedId, !item.read);
                }
            } else if (e.key === 'o' && !e.repeat && focusedIndex !== null) {
                const item = visibleItems[focusedIndex];
                const url = getArticleUrl(item?.link);
                if (url) {
                    e.preventDefault();
                    chrome.tabs.create({ url, active: false })
                        .catch(error => setActionError(`Could not open this article: ${error.message}`));
                }
            }
        };
        document.addEventListener('keydown', handler);
        return () => document.removeEventListener('keydown', handler);
    }, [focusedIndex, visibleItems, toggleExpand, setItemRead, showSettings, closeFeedMenu]);

    const handleSaveSettings = async (patch) => {
        if (settingsSaveInProgress.current) return;
        settingsSaveInProgress.current = true;
        setIsSavingSettings(true);
        setActionError('');
        try {
            const updated = await updateSettings(patch);
            setSettings(updated);
            applyAppearance(updated);
        } catch (error) {
            setActionError(`Could not save settings: ${error.message}`);
        } finally {
            settingsSaveInProgress.current = false;
            setIsSavingSettings(false);
        }
    };

    const handleManualRefresh = async () => {
        if (isRefreshing) return;
        setIsRefreshing(true);
        setRefreshStatus(null);
        try {
            const response = await chrome.runtime.sendMessage({ type: 'REFRESH_FEEDS' });
            if (!response) throw new Error('The background worker returned no response for REFRESH_FEEDS.');
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
        setOpenFeedMenuId(null);
        setSidebarOpen(false);
        setPage(1);
        setFocusedIndex(null);
    };

    const sectionTitle = selectedFeedId
        ? subMap[selectedFeedId] ?? 'Feed'
        : 'Reading List';

    const siteLink = selectedFeedId ? (feedMeta[selectedFeedId]?.siteLink ?? null) : null;
    const isCompact = settings.viewMode === 'headlines';

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
                        >
                            <button className="feed-select" onClick={() => selectFeed(null)} aria-current={!selectedFeedId ? 'page' : undefined}>
                                <span className="feed-item-title">All Articles</span>
                                {totalUnread > 0 && <span className="feed-unread">{totalUnread}</span>}
                            </button>
                        </li>
                        {sortedSubscriptions.map(sub => (
                            <li
                                key={sub.id}
                                className={`feed-item ${selectedFeedId === sub.id ? 'active' : ''}`}
                                data-feed-menu-open={openFeedMenuId === sub.id}
                            >
                                <button className="feed-select" onClick={() => selectFeed(sub.id)} aria-current={selectedFeedId === sub.id ? 'page' : undefined}>
                                    <span className="feed-item-title">{sub.title}</span>
                                    {unreadByFeed[sub.id] > 0 && (
                                        <span className="feed-unread">{unreadByFeed[sub.id]}</span>
                                    )}
                                </button>
                                <button
                                    className={`feed-item-star ${sub.starred ? 'starred' : ''}`}
                                    onClick={(e) => { e.stopPropagation(); toggleStar(sub.id); }}
                                    title={sub.starred ? 'Unpin' : 'Pin to top'}
                                    aria-label={sub.starred ? 'Unstar feed' : 'Star feed'}
                                >
                                    {sub.starred ? '★' : '☆'}
                                </button>
                                <button
                                    id={`feed-options-${sub.id}`}
                                    className="feed-options-btn"
                                    aria-label={`Options for ${sub.title}`}
                                    aria-expanded={openFeedMenuId === sub.id}
                                    aria-controls={`feed-menu-${sub.id}`}
                                    onClick={() => setOpenFeedMenuId(current => current === sub.id ? null : sub.id)}
                                >
                                    ⋯
                                </button>
                                {openFeedMenuId === sub.id && (
                                    <div className="feed-menu-panel" id={`feed-menu-${sub.id}`}>
                                        <button
                                            disabled={isSavingBulkRead || !unreadByFeed[sub.id]}
                                            onClick={() => markAllAsRead(sub.id)}
                                        >
                                            Mark feed as read
                                        </button>
                                    </div>
                                )}
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
                        <button
                            className="view-mode-btn"
                            aria-label={isCompact ? 'Switch to preview view' : 'Switch to list view'}
                            aria-controls="article-list"
                            disabled={isSavingSettings}
                            title={isCompact ? 'Switch to preview view' : 'Switch to list view'}
                            onClick={() => handleSaveSettings({ viewMode: isCompact ? 'preview' : 'headlines' })}
                        >
                            <svg
                                width="18"
                                height="18"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="1.5"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                aria-hidden="true"
                                focusable="false"
                            >
                                {isCompact ? (
                                    <>
                                        <rect x="3" y="3" width="18" height="8" rx="1.5" />
                                        <rect x="3" y="13" width="18" height="8" rx="1.5" />
                                        <path d="M7 6h10M7 8.5h6M7 16h10M7 18.5h6" />
                                    </>
                                ) : (
                                    <>
                                        <circle cx="4" cy="6" r="1" />
                                        <circle cx="4" cy="12" r="1" />
                                        <circle cx="4" cy="18" r="1" />
                                        <path d="M9 6h12M9 12h12M9 18h12" />
                                    </>
                                )}
                            </svg>
                        </button>
                        <button
                            className="bulk-read-btn"
                            disabled={isSavingBulkRead || !(selectedFeedId ? unreadByFeed[selectedFeedId] : totalUnread)}
                            title={selectedFeedId ? 'Mark all cached articles in this feed as read, including articles hidden by search' : 'Mark all cached articles across all feeds as read, including articles hidden by search'}
                            onClick={() => markAllAsRead(selectedFeedId)}
                        >
                            {selectedFeedId ? 'Mark feed as read' : 'Mark all as read'}
                        </button>
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
                {bulkReadStatus && (
                    <div className="reader-status bulk-read-status" role="status">
                        <span>{bulkReadStatus.message}</span>
                        {bulkReadStatus.items.length > 0 && (
                            <button className="bulk-read-btn" disabled={isSavingBulkRead} onClick={undoBulkRead}>Undo</button>
                        )}
                    </div>
                )}
                {refreshStatus && <p className="reader-status" role={refreshStatus.failed ? 'alert' : 'status'}>{refreshStatus.message}</p>}

                <div id="article-list" className={`article-list${isCompact ? ' compact' : ''}`}>
                    <div className="article-column">
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
                                isCompact={isCompact}
                                onToggle={toggleExpand}
                                onMarkRead={setItemRead}
                                isSavingRead={isSavingBulkRead || pendingReadItems.has(articleKey(item.id, item.feedId))}
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
                            <fieldset className="appearance-options" disabled={isSavingSettings}>
                                <label className="appearance-label" htmlFor="design-theme">Theme</label>
                                <select
                                    id="design-theme"
                                    className="theme-select"
                                    value={settings.designTheme}
                                    onChange={e => handleSaveSettings({ designTheme: e.target.value })}
                                >
                                    {DESIGN_THEMES.map(design => (
                                        <option key={design.id} value={design.id}>{design.label}</option>
                                    ))}
                                </select>
                                <p className="appearance-description">Modern uses sans serif text, a focused reading column, and neutral colors.</p>
                                <p className="appearance-label" id="color-mode-label">Color mode</p>
                                <div className="modal-actions" role="group" aria-labelledby="color-mode-label">
                                    {['light', 'dark', 'system'].map(t => (
                                        <button key={t}
                                            aria-pressed={settings.theme === t}
                                            className={`modal-btn ${settings.theme === t ? 'primary' : 'secondary'}`}
                                            onClick={() => handleSaveSettings({ theme: t })}>
                                            {t[0].toUpperCase() + t.slice(1)}
                                        </button>
                                    ))}
                                </div>
                                <p className="appearance-label" id="font-size-label">Font size</p>
                                <div className="modal-actions" role="group" aria-labelledby="font-size-label">
                                    {['small', 'medium', 'large'].map(s => (
                                        <button key={s}
                                            aria-pressed={settings.fontSize === s}
                                            className={`modal-btn ${settings.fontSize === s ? 'primary' : 'secondary'}`}
                                            onClick={() => handleSaveSettings({ fontSize: s })}>
                                            {s[0].toUpperCase() + s.slice(1)}
                                        </button>
                                    ))}
                                </div>
                            </fieldset>
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
