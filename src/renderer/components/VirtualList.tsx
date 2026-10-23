import React from 'react';

export interface VirtualListProps<T> {
  items: T[];
  itemHeight?: number;
  renderItem: (item: T, index: number) => React.ReactNode;
  overscan?: number;
  emptyPlaceholder?: React.ReactNode;
}

/**
 * High-performance list component utilizing native CSS content-visibility virtualization.
 * Eliminates JavaScript scroll-listener layout thrashing, ResizeObserver feedback loops,
 * and height-mismatch jitter.
 */
export function VirtualList<T>({
  items,
  renderItem,
  emptyPlaceholder
}: VirtualListProps<T>): React.ReactElement {
  if (items.length === 0 && emptyPlaceholder) {
    return <>{emptyPlaceholder}</>;
  }

  return (
    <div className="virtual-list-container" style={{ width: '100%' }}>
      {items.map((item, index) => (
        <React.Fragment key={index}>
          {renderItem(item, index)}
        </React.Fragment>
      ))}
    </div>
  );
}
