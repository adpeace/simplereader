import { useEffect, useRef, useState } from 'react';

const WIDTH_KEY = 'simplereader.sidebarWidth';
const MIN_WIDTH = 180;
const MAX_WIDTH = 480;
const MIN_READER_WIDTH = 320;

function loadWidth() {
    try {
        const value = Number(localStorage.getItem(WIDTH_KEY));
        return Number.isFinite(value) && value >= MIN_WIDTH && value <= MAX_WIDTH ? value : null;
    } catch {
        return null;
    }
}

function saveWidth(width) {
    try {
        if (width === null) localStorage.removeItem(WIDTH_KEY);
        else localStorage.setItem(WIDTH_KEY, String(width));
    } catch {
        // Resizing remains available when browser storage is unavailable.
    }
}

export default function ResizableLayout({ children }) {
    const [preferredWidth, setPreferredWidth] = useState(loadWidth);
    const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
    const [resizing, setResizing] = useState(false);
    const drag = useRef(null);
    const maxWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, viewportWidth - MIN_READER_WIDTH));
    const defaultWidth = viewportWidth < 800 ? MIN_WIDTH : 232;
    const clamp = value => Math.round(Math.max(MIN_WIDTH, Math.min(maxWidth, value)));
    const width = clamp(preferredWidth ?? defaultWidth);

    useEffect(() => {
        const handleResize = () => setViewportWidth(window.innerWidth);
        window.addEventListener('resize', handleResize);
        return () => window.removeEventListener('resize', handleResize);
    }, []);

    const finishDrag = event => {
        if (!drag.current || event.pointerId !== drag.current.pointerId) return;
        saveWidth(drag.current.width);
        drag.current = null;
        setResizing(false);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
    };

    const resetWidth = () => {
        setPreferredWidth(null);
        saveWidth(null);
    };

    return (
        <div
            className={`dashboard-container${resizing ? ' resizing-sidebar' : ''}`}
            style={{ '--sidebar-width': `${width}px` }}
        >
            {children}
            <div
                className="sidebar-divider"
                role="separator"
                tabIndex={0}
                aria-label="Sidebar width"
                aria-orientation="vertical"
                aria-controls="feed-sidebar"
                aria-valuemin={MIN_WIDTH}
                aria-valuemax={maxWidth}
                aria-valuenow={width}
                aria-valuetext={`${width} pixels`}
                title="Drag to resize. Use Left/Right arrow keys, or double-click to reset."
                onPointerDown={event => {
                    if (event.button !== 0 || !event.isPrimary) return;
                    event.preventDefault();
                    event.currentTarget.focus();
                    event.currentTarget.setPointerCapture(event.pointerId);
                    drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width, width };
                    setResizing(true);
                }}
                onPointerMove={event => {
                    if (!drag.current || event.pointerId !== drag.current.pointerId) return;
                    const nextWidth = clamp(drag.current.startWidth + event.clientX - drag.current.startX);
                    drag.current.width = nextWidth;
                    setPreferredWidth(nextWidth);
                }}
                onPointerUp={finishDrag}
                onPointerCancel={finishDrag}
                onLostPointerCapture={finishDrag}
                onDoubleClick={resetWidth}
                onKeyDown={event => {
                    if (event.altKey || event.ctrlKey || event.metaKey) return;
                    const step = event.shiftKey ? 40 : 10;
                    let nextWidth;
                    switch (event.key) {
                        case 'ArrowLeft': nextWidth = clamp(width - step); break;
                        case 'ArrowRight': nextWidth = clamp(width + step); break;
                        case 'Home': nextWidth = MIN_WIDTH; break;
                        case 'End': nextWidth = maxWidth; break;
                        default: return;
                    }
                    event.preventDefault();
                    setPreferredWidth(nextWidth);
                    saveWidth(nextWidth);
                }}
            />
        </div>
    );
}
