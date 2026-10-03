import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

export interface VirtualWindow {
  start: number;
  end: number;
  offsetY: number;
  totalHeight: number;
}

/**
 * Windowed rendering for long lists: only the visible rows plus a small
 * overscan are mounted, so a 4MB task set or a 32k-event ledger costs the same
 * to scroll as a 20-row table.
 */
export function useVirtualRows(
  count: number,
  rowHeight: number,
  overscan = 8
): { ref: (node: HTMLDivElement | null) => void; window: VirtualWindow } {
  const [viewportHeight, setViewportHeight] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const nodeRef = useRef<HTMLDivElement | null>(null);

  const ref = useCallback((node: HTMLDivElement | null) => { nodeRef.current = node; }, []);

  useEffect(() => {
    const node = nodeRef.current;
    if (!node) return undefined;
    const measure = () => setViewportHeight(node.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const onScroll = useCallback(() => {
    const node = nodeRef.current;
    if (node) setScrollTop(node.scrollTop);
  }, []);

  useEffect(() => {
    const node = nodeRef.current;
    if (!node) return undefined;
    node.addEventListener('scroll', onScroll, { passive: true });
    return () => node.removeEventListener('scroll', onScroll);
  }, [onScroll]);

  const height = viewportHeight || 400;
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const visible = Math.ceil(height / rowHeight) + overscan * 2;
  const last = Math.min(count, first + visible);

  return {
    ref,
    window: {
      start: first,
      end: last,
      offsetY: first * rowHeight,
      totalHeight: count * rowHeight,
    },
  };
}

interface VirtualTableProps<T> {
  rows: T[];
  rowHeight?: number;
  height?: number | string;
  rowKey: (row: T, index: number) => string;
  renderRow: (row: T, index: number) => ReactNode;
  className?: string;
  emptyLabel?: string;
}

/** A minimal virtualised list. Use when the row count can reach thousands. */
export function VirtualTable<T>({
  rows,
  rowHeight = 28,
  height = 420,
  rowKey,
  renderRow,
  className = '',
  emptyLabel = 'Nothing to show.',
}: VirtualTableProps<T>) {
  const { ref, window: win } = useVirtualRows(rows.length, rowHeight);
  const visible = rows.slice(win.start, win.end);

  return (
    <div ref={ref} className={`vtable ${className}`} style={{ height }}>
      {rows.length === 0 ? (
        <p className="text-hud-dim text-xs py-6 px-3">{emptyLabel}</p>
      ) : (
        <div className="vtable__sizer" style={{ height: win.totalHeight }}>
          <div className="vtable__window" style={{ transform: `translateY(${win.offsetY}px)` }}>
            {visible.map((row, index) => {
              const absolute = win.start + index;
              return (
                <div key={rowKey(row, absolute)} style={{ height: rowHeight }} className="flex items-center">
                  {renderRow(row, absolute)}
                </div>
              );
            })}
          </div>
        </div>
      )}
      <div className="vtable__fade" />
    </div>
  );
}
