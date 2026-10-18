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
  maxHeight = 650,
  className = '',
  overscan = 6,
  emptyPlaceholder
}: VirtualListProps<T>): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(
    typeof maxHeight === 'number' ? maxHeight : 650
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const measure = () => {
      const h = el.clientHeight;
      if (h > 0) {
        setViewportHeight(h);
      }
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const totalCount = items.length;

  if (totalCount === 0 && emptyPlaceholder) {
    return <>{emptyPlaceholder}</>;
  }

  // If items list is small (e.g. <= 25 items), render directly without virtualization
  // This guarantees 100% reliability, zero layout quirks or flickering for small/medium lists
  if (totalCount <= 25) {
    return (
      <div className={className} style={{ width: '100%' }}>
        {items.map((item, index) => (
          <React.Fragment key={index}>
            {renderItem(item, index)}
          </React.Fragment>
        ))}
      </div>
    );
  }

  const effectiveViewport = Math.max(viewportHeight, 400);
  const totalHeight = totalCount * itemHeight;

  const startIndex = Math.max(0, Math.floor(scrollTop / itemHeight) - overscan);
  const visibleCount = Math.ceil(effectiveViewport / itemHeight) + 2 * overscan;
  const endIndex = Math.min(totalCount, startIndex + visibleCount);

  const paddingTop = startIndex * itemHeight;
  const paddingBottom = Math.max(0, (totalCount - endIndex) * itemHeight);
  const visibleItems = items.slice(startIndex, endIndex);

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop);
  };

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className={className}
      style={{
        overflowY: 'auto',
        maxHeight,
        width: '100%',
        position: 'relative'
      }}
    >
      <div
        style={{
          boxSizing: 'border-box',
          paddingTop: `${paddingTop}px`,
          paddingBottom: `${paddingBottom}px`,
          minHeight: `${totalHeight}px`,
          width: '100%'
        }}
      >
        {visibleItems.map((item, i) => {
          const actualIndex = startIndex + i;
          return (
            <React.Fragment key={actualIndex}>
              {renderItem(item, actualIndex)}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}
