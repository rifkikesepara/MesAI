import React from 'react';

export interface SkeletonProps {
  width?: string | number;
  height?: string | number;
  borderRadius?: string | number;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * Base atomic Skeleton block with smooth shimmer gradient.
 */
export const Skeleton: React.FC<SkeletonProps> = ({
  width = '100%',
  height = '16px',
  borderRadius = '4px',
  className = '',
  style = {}
}) => {
  return (
    <div
      className={`skeleton-box ${className}`.trim()}
      style={{
        width: typeof width === 'number' ? `${width}px` : width,
        height: typeof height === 'number' ? `${height}px` : height,
        borderRadius: typeof borderRadius === 'number' ? `${borderRadius}px` : borderRadius,
        ...style
      }}
      aria-hidden="true"
    />
  );
};

/**
 * Multi-line skeleton text generator.
 */
export const SkeletonText: React.FC<{
  lines?: number;
  lineHeight?: number;
  gap?: number;
  lastLineWidth?: string;
  style?: React.CSSProperties;
}> = ({ lines = 3, lineHeight = 14, gap = 8, lastLineWidth = '70%', style = {} }) => {
  return (
    <div style={{ display: 'grid', gap: `${gap}px`, width: '100%', ...style }}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton
          key={i}
          height={lineHeight}
          width={i === lines - 1 ? lastLineWidth : '100%'}
        />
      ))}
    </div>
  );
};

/**
 * Skeleton placeholder for Stat Cards (Dashboard 4-grid).
 */
export const SkeletonStatCard: React.FC = () => {
  return (
    <div className="stat-card" style={{ display: 'grid', gap: '8px' }}>
      <Skeleton width="45%" height={12} />
      <Skeleton width="60%" height={24} style={{ marginTop: '4px' }} />
      <Skeleton width="80%" height={12} style={{ marginTop: '2px' }} />
    </div>
  );
};

/**
 * Full page skeleton for Dashboard (banner + 4 stat cards + 2 main cards).
 */
export const SkeletonDashboard: React.FC = () => {
  return (
    <div style={{ display: 'grid', gap: '16px' }} aria-busy="true" aria-label="Yükleniyor">
      {/* Banner */}
      <div className="card" style={{ padding: '14px 16px' }}>
        <Skeleton width="30%" height={14} style={{ marginBottom: '10px' }} />
        <Skeleton width="90%" height={12} style={{ marginBottom: '6px' }} />
        <Skeleton width="75%" height={12} />
      </div>

      {/* 4 Stat Cards */}
      <div className="grid-4">
        <SkeletonStatCard />
        <SkeletonStatCard />
        <SkeletonStatCard />
        <SkeletonStatCard />
      </div>

      {/* 2 Main Cards */}
      <div className="grid-2">
        <div className="card">
          <div className="card-header" style={{ marginBottom: '16px' }}>
            <Skeleton width="40%" height={16} />
            <Skeleton width="20%" height={16} />
          </div>
          <div style={{ display: 'grid', gap: '12px' }}>
            {Array.from({ length: 4 }).map((_, i) => (
              <div
                key={i}
                style={{
                  display: 'flex',
                  gap: '12px',
                  alignItems: 'center',
                  padding: '10px 0',
                  borderBottom: '1px solid var(--border-color)'
                }}
              >
                <Skeleton width={32} height={32} borderRadius="50%" />
                <div style={{ flex: 1, display: 'grid', gap: '6px' }}>
                  <Skeleton width="60%" height={14} />
                  <Skeleton width="40%" height={11} />
                </div>
                <Skeleton width={60} height={20} borderRadius={12} />
              </div>
            ))}
          </div>
        </div>

        <div className="card">
          <div className="card-header" style={{ marginBottom: '16px' }}>
            <Skeleton width="45%" height={16} />
            <Skeleton width="25%" height={16} />
          </div>
          <div style={{ display: 'grid', gap: '12px' }}>
            {Array.from({ length: 4 }).map((_, i) => (
              <div
                key={i}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '10px 0',
                  borderBottom: '1px solid var(--border-color)'
                }}
              >
                <div style={{ display: 'grid', gap: '6px', width: '60%' }}>
                  <Skeleton width="70%" height={14} />
                  <Skeleton width="90%" height={11} />
                </div>
                <Skeleton width={80} height={22} borderRadius={12} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

/**
 * Skeleton placeholder for Timeline activity cards.
 */
export const SkeletonActivityList: React.FC<{ count?: number }> = ({ count = 5 }) => {
  return (
    <div style={{ display: 'grid', gap: '10px' }} aria-busy="true" aria-label="Aktiviteler yükleniyor">
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="card"
          style={{
            padding: '14px 16px',
            display: 'flex',
            gap: '14px',
            alignItems: 'flex-start'
          }}
        >
          <Skeleton width={36} height={36} borderRadius={8} style={{ flexShrink: 0 }} />
          <div style={{ flex: 1, display: 'grid', gap: '8px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <Skeleton width="45%" height={15} />
              <Skeleton width="18%" height={12} />
            </div>
            <Skeleton width="85%" height={13} />
            <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
              <Skeleton width={70} height={20} borderRadius={10} />
              <Skeleton width={90} height={20} borderRadius={10} />
              <Skeleton width={60} height={20} borderRadius={10} />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
};

/**
 * Skeleton placeholder for Daily Report view.
 */
export const SkeletonReport: React.FC = () => {
  return (
    <div style={{ display: 'grid', gap: '16px' }} aria-busy="true" aria-label="Rapor yükleniyor">
      {/* Report summary grid */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '2fr 1fr',
          gap: '16px'
        }}
      >
        <div className="card">
          <div className="card-header" style={{ marginBottom: '14px' }}>
            <Skeleton width="50%" height={18} />
            <Skeleton width={80} height={22} borderRadius={12} />
          </div>
          <div style={{ display: 'grid', gap: '8px' }}>
            <Skeleton width="95%" height={14} />
            <Skeleton width="90%" height={14} />
            <Skeleton width="80%" height={14} />
            <Skeleton width="60%" height={14} />
          </div>
        </div>

        <div className="card">
          <Skeleton width="60%" height={16} style={{ marginBottom: '14px' }} />
          <div style={{ display: 'grid', gap: '10px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <Skeleton width="40%" height={12} />
              <Skeleton width="30%" height={12} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <Skeleton width="50%" height={12} />
              <Skeleton width="25%" height={12} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <Skeleton width="35%" height={12} />
              <Skeleton width="35%" height={12} />
            </div>
          </div>
        </div>
      </div>

      {/* Report draft items */}
      <div className="card">
        <div className="card-header" style={{ marginBottom: '16px' }}>
          <Skeleton width="35%" height={18} />
          <Skeleton width="20%" height={18} />
        </div>
        <div style={{ display: 'grid', gap: '12px' }}>
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              style={{
                padding: '14px',
                background: 'var(--bg-primary)',
                borderRadius: '8px',
                border: '1px solid var(--border-color)',
                display: 'grid',
                gap: '8px'
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <Skeleton width={80} height={20} borderRadius={10} />
                  <Skeleton width={90} height={20} borderRadius={10} />
                </div>
                <Skeleton width={60} height={18} borderRadius={4} />
              </div>
              <Skeleton width="92%" height={14} />
              <Skeleton width="75%" height={14} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

/**
 * Skeleton placeholder for Integrations View.
 */
export const SkeletonIntegrations: React.FC = () => {
  return (
    <div style={{ display: 'grid', gap: '16px' }} aria-busy="true" aria-label="Entegrasyonlar yükleniyor">
      <div className="grid-2">
        <div className="card">
          <div className="card-header" style={{ marginBottom: '14px' }}>
            <Skeleton width="50%" height={18} />
            <Skeleton width={70} height={22} borderRadius={12} />
          </div>
          <SkeletonText lines={3} />
          <Skeleton width={120} height={32} borderRadius={6} style={{ marginTop: '16px' }} />
        </div>
        <div className="card">
          <div className="card-header" style={{ marginBottom: '14px' }}>
            <Skeleton width="45%" height={18} />
            <Skeleton width={70} height={22} borderRadius={12} />
          </div>
          <SkeletonText lines={3} />
          <Skeleton width={120} height={32} borderRadius={6} style={{ marginTop: '16px' }} />
        </div>
      </div>

      <div className="card">
        <div className="card-header" style={{ marginBottom: '16px' }}>
          <Skeleton width="40%" height={20} />
          <Skeleton width={100} height={24} borderRadius={12} />
        </div>
        <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
          <Skeleton width={140} height={32} borderRadius={6} />
          <Skeleton width={120} height={32} borderRadius={6} />
          <Skeleton width={130} height={32} borderRadius={6} />
          <Skeleton width={140} height={32} borderRadius={6} />
        </div>
        <div style={{ padding: '16px', background: 'var(--bg-primary)', borderRadius: '8px' }}>
          <Skeleton width="30%" height={16} style={{ marginBottom: '12px' }} />
          <Skeleton width="100%" height={40} borderRadius={6} style={{ marginBottom: '12px' }} />
          <Skeleton width="100%" height={40} borderRadius={6} style={{ marginBottom: '16px' }} />
          <Skeleton width={140} height={34} borderRadius={6} />
        </div>
      </div>
    </div>
  );
};

/**
 * Skeleton placeholder for Settings View.
 */
export const SkeletonSettings: React.FC = () => {
  return (
    <div style={{ display: 'grid', gap: '16px' }} aria-busy="true" aria-label="Ayarlar yükleniyor">
      <div className="card">
        <Skeleton width="35%" height={20} style={{ marginBottom: '16px' }} />
        <div style={{ display: 'grid', gap: '14px' }}>
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} style={{ display: 'grid', gap: '6px' }}>
              <Skeleton width="25%" height={14} />
              <Skeleton width="100%" height={38} borderRadius={6} />
              <Skeleton width="50%" height={11} />
            </div>
          ))}
          <Skeleton width={140} height={36} borderRadius={6} style={{ marginTop: '8px' }} />
        </div>
      </div>
    </div>
  );
};
