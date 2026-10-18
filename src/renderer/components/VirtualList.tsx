import React, { useState, useEffect, useRef, useMemo } from 'react';

export interface VirtualListProps<T> {
  items: T[];
  itemHeight: number;
  renderItem: (item: T, index: number) => React.ReactNode;
  maxHeight?: number | string;
  className?: string;
  overscan?: number;
  emptyPlaceholder?: React.ReactNode;
}

export function VirtualList<T>({
  items,
  itemHeight,
  renderItem,
  maxHeight = 600,
  className = '',
  overscan = 5,
  emptyPlaceholder
}: VirtualListProps<T>): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(
    typeof maxHeight === 'number' ? maxHeight : 600
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const updateHeight = () => {
      if (el.clientHeight > 0) {
        setViewportHeight(el.clientHeight);
      }
    };

    updateHeight();
    const ro = new ResizeObserver(updateHeight);
    ro.observe(el);

    return () => ro.disconnect();
  }, []);

  const totalCount = items.length;
  const totalHeight = totalCount * itemHeight;

  const { startIndex, endIndex, offsetY } = useMemo(() => {
    if (totalCount === 0) {
      return { startIndex: 0, endIndex: 0, offsetY: 0 };
    }

    const start = Math.max(0, Math.floor(scrollTop / itemHeight) - overscan);
    const visibleCount = Math.ceil(viewportHeight / itemHeight) + 2 * overscan;
    const end = Math.min(totalCount, start + visibleCount);
    const offset = start * itemHeight;

    return { startIndex: start, endIndex: end, offsetY: offset };
  }, [scrollTop, itemHeight, viewportHeight, overscan, totalCount]);

  const visibleItems = useMemo(() => {
    return items.slice(startIndex, endIndex).map((item, i) => ({
      item,
      actualIndex: startIndex + i
    }));
  }, [items, startIndex, endIndex]);

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop);
  };

  if (totalCount === 0 && emptyPlaceholder) {
    return <>{emptyPlaceholder}</>;
  }

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className={className}
      style={{
        overflowY: 'auto',
        maxHeight,
        position: 'relative',
        contain: 'strict',
        width: '100%'
      }}
    >
      <div
        style={{
          height: totalHeight,
          width: '100%',
          position: 'relative'
        }}
      >
        <div
          style={{
            transform: `translateY(${offsetY}px)`,
            willChange: 'transform',
            width: '100%'
          }}
        >
          {visibleItems.map(({ item, actualIndex }) => (
            <div key={actualIndex} style={{ minHeight: itemHeight }}>
              {renderItem(item, actualIndex)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
