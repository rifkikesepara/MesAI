import React, { useState, useEffect, useRef } from 'react';

export interface VirtualListProps<T> {
  items: T[];
  itemHeight: number;
  renderItem: (item: T, index: number) => React.ReactNode;
  overscan?: number;
  emptyPlaceholder?: React.ReactNode;
}

/**
 * Window / Outer-scroll based VirtualList.
 * Does not create an internal scroll container.
 * Listens to window or nearest parent scrollable container (.content-scroll).
 */
export function VirtualList<T>({
  items,
  itemHeight,
  renderItem,
  overscan = 8,
  emptyPlaceholder
}: VirtualListProps<T>): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(window.innerHeight || 800);
  const [containerTop, setContainerTop] = useState(0);

  const totalCount = items.length;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // Find the scrollable ancestor (.content-scroll or window)
    const findScrollParent = (node: HTMLElement | null): HTMLElement | Window => {
      let curr = node?.parentElement;
      while (curr) {
        const overflowY = window.getComputedStyle(curr).overflowY;
        if (overflowY === 'auto' || overflowY === 'scroll') {
          return curr;
        }
        curr = curr.parentElement;
      }
      return window;
    };

    const scrollParent = findScrollParent(el);

    const updateMeasurements = () => {
      if (!el) return;
      if (scrollParent instanceof Window) {
        setScrollTop(window.scrollY);
        setViewportHeight(window.innerHeight);
        const rect = el.getBoundingClientRect();
        setContainerTop(rect.top + window.scrollY);
      } else {
        const parentRect = scrollParent.getBoundingClientRect();
        const elRect = el.getBoundingClientRect();
        setScrollTop(scrollParent.scrollTop);
        setViewportHeight(scrollParent.clientHeight);
        // Relative top of the list container relative to the scroll container's content
        setContainerTop(elRect.top - parentRect.top + scrollParent.scrollTop);
      }
    };

    updateMeasurements();

    let rafId: number | null = null;
    const onScroll = () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(updateMeasurements);
    };

    scrollParent.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });

    const ro = new ResizeObserver(onScroll);
    ro.observe(el);
    if (scrollParent instanceof HTMLElement) {
      ro.observe(scrollParent);
    }

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      scrollParent.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      ro.disconnect();
    };
  }, []);

  if (totalCount === 0 && emptyPlaceholder) {
    return <>{emptyPlaceholder}</>;
  }

  // Fallback for short lists (<= 25 items): full render directly without virtualization
  if (totalCount <= 25) {
    return (
      <div ref={containerRef} style={{ width: '100%' }}>
        {items.map((item, index) => (
          <React.Fragment key={index}>
            {renderItem(item, index)}
          </React.Fragment>
        ))}
      </div>
    );
  }

  // Calculate visible range based on scroll position of outer scroll container
  // Offset of the viewport relative to the top of this VirtualList
  const relativeScrollTop = Math.max(0, scrollTop - containerTop);
  const totalHeight = totalCount * itemHeight;

  const startIndex = Math.max(0, Math.floor(relativeScrollTop / itemHeight) - overscan);
  const visibleCount = Math.ceil(viewportHeight / itemHeight) + 2 * overscan;
  const endIndex = Math.min(totalCount, startIndex + visibleCount);

  const paddingTop = startIndex * itemHeight;
  const paddingBottom = Math.max(0, (totalCount - endIndex) * itemHeight);
  const visibleItems = items.slice(startIndex, endIndex);

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        boxSizing: 'border-box',
        paddingTop: `${paddingTop}px`,
        paddingBottom: `${paddingBottom}px`,
        minHeight: `${totalHeight}px`
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
  );
}
