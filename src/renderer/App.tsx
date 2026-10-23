import React, { Suspense, useEffect, useState } from 'react';
import type { DashboardSummary } from '../shared/ipc-channels';
import type { AppSettings, Evidence, Project, UpdateState } from '../shared/types';
import {
  DashboardView,
  ProjectsView,
  SOURCE_LABELS,
  ZOOM_STATUS_LABELS
} from './views/DashboardAndProjectsView';
import {
  SkeletonActivityList,
  SkeletonIntegrations,
  SkeletonReport,
  SkeletonSettings
} from './components/Skeleton';
import { CustomMenuBar } from './components/CustomMenuBar';
import { MESAI_ICON_DATA_URL } from './assets/logo';

const TimelineView = React.lazy(() =>
  import('./views/TimelineAndReportView').then((m) => ({ default: m.TimelineView }))
);
const DailyReportView = React.lazy(() =>
  import('./views/TimelineAndReportView').then((m) => ({ default: m.DailyReportView }))
);
const IntegrationsView = React.lazy(() =>
  import('./views/IntegrationsAndSettingsView').then((m) => ({ default: m.IntegrationsView }))
);
const SettingsView = React.lazy(() =>
  import('./views/IntegrationsAndSettingsView').then((m) => ({ default: m.SettingsView }))
);
import {
  DashboardIcon,
  ProjectsIcon,
  ActivityIcon,
  ReportIcon,
  IntegrationsIcon,
  SettingsIcon,
  PlayIcon,
  PauseIcon,
  RefreshIcon,
  CloseIcon,
  ExternalLinkIcon,
  MessageSquareIcon,
  GitCommitIcon
} from './components/Icons';

type TabKey = 'dashboard' | 'projects' | 'timeline' | 'report' | 'integrations' | 'settings';

export const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<TabKey>('dashboard');
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [updateState, setUpdateState] = useState<UpdateState | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [pollingZoom, setPollingZoom] = useState<boolean>(false);
  const [pollingGit, setPollingGit] = useState<boolean>(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [inspectedEvidence, setInspectedEvidence] = useState<Evidence | null>(null);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 4000);
  };

  const refreshCoreData = async (showLoading = true) => {
    if (showLoading) {
      setLoading(true);
    }
    try {
      const [dash, projList, cfg] = await Promise.all([
        window.mesaiApi.getDashboard(),
        window.mesaiApi.listProjects(),
        window.mesaiApi.getSettings()
      ]);
      setSummary(dash);
      setProjects(projList);
      setSettings(cfg);
    } finally {
      if (showLoading) {
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    void refreshCoreData();
    void window.mesaiApi.getUpdateState().then(setUpdateState);
    const unsub = window.mesaiApi.onUpdateStateChanged((state) => {
      setUpdateState(state);
      if (state.status === 'available') {
        showToast(`🚀 Yeni sürüm mevcut: v${state.updateInfo?.version}`);
      }
    });
    const unsubTracking = window.mesaiApi.onTrackingStateChanged?.((newPaused) => {
      setSettings((prev) => (prev ? { ...prev, trackingPaused: newPaused } : null));
      setSummary((prev) => (prev ? { ...prev, trackingPaused: newPaused } : null));
      showToast(newPaused ? '⏸ Takip duraklatıldı (Görev Çubuğu)' : '● Takip aktif (Görev Çubuğu)');
      void refreshCoreData(false);
    });
    const interval = setInterval(() => {
      void refreshCoreData(false);
    }, 15_000);
    return () => {
      clearInterval(interval);
      unsub?.();
      unsubTracking?.();
    };
  }, []);

  // Antigravity Theme Engine (Dark, Light, System)
  useEffect(() => {
    const applyTheme = () => {
      const pref = settings?.theme || 'system';
      let effective = pref;
      if (pref === 'system') {
        const isDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
        effective = isDark ? 'dark' : 'light';
      }
      document.documentElement.setAttribute('data-theme', effective);
    };

    applyTheme();

    if (window.matchMedia) {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      const listener = () => {
        if ((settings?.theme || 'system') === 'system') {
          applyTheme();
        }
      };
      mediaQuery.addEventListener('change', listener);
      return () => mediaQuery.removeEventListener('change', listener);
    }
  }, [settings?.theme]);

  const handleSetTheme = async (newTheme: 'light' | 'dark' | 'system') => {
    setSettings((prev) => (prev ? { ...prev, theme: newTheme } : null));
    await window.mesaiApi.updateSettings({ theme: newTheme });
    showToast(`Tema değiştirildi: ${newTheme === 'dark' ? 'Koyu' : newTheme === 'light' ? 'Açık' : 'Sistem'}`);
  };

  const handlePollZoomNow = async () => {
    setPollingZoom(true);
    try {
      const res = await window.mesaiApi.pollZoomNow();
      if (res.ok) {
        showToast(
          `Zoom okundu (${res.chatName || 'Sohbet'}): ${res.newMessages} yeni mesaj, görünümde ${res.totalVisible} mesaj.`
        );
      } else {
        const label = ZOOM_STATUS_LABELS[res.status]?.text ?? res.status;
        showToast(`Zoom Durumu: ${label}${res.error ? ` — ${res.error}` : ''}`);
      }
      await refreshCoreData();
    } finally {
      setPollingZoom(false);
    }
  };

  const handlePollGitNow = async () => {
    setPollingGit(true);
    try {
      const res = await window.mesaiApi.pollGitNow();
      showToast(
        `Git taraması tamamlandı (${res.scannedProjects} proje, ${res.newActivities} yeni aktivite).`
      );
      await refreshCoreData();
    } finally {
      setPollingGit(false);
    }
  };

  const handleTogglePaused = async () => {
    const currentPaused = summary?.trackingPaused ?? settings?.trackingPaused ?? false;
    const updated = await window.mesaiApi.setTrackingPaused(!currentPaused);
    setSettings(updated);
    showToast(updated.trackingPaused ? 'Takip duraklatıldı.' : 'Takip devam ettiriliyor.');
    await refreshCoreData();
  };

  const isPaused = summary?.trackingPaused ?? settings?.trackingPaused ?? false;
  const zoomSync = summary?.syncStates.find((s) => s.connector === 'zoom_reader');
  const zoomBadge = ZOOM_STATUS_LABELS[zoomSync?.status ?? 'idle'] ?? ZOOM_STATUS_LABELS.idle;

  return (
    <div className="window-frame">
      <CustomMenuBar
        activeTab={activeTab}
        onNavigateTab={(tab) => setActiveTab(tab)}
        isPaused={isPaused}
        onTogglePaused={handleTogglePaused}
        onPollZoom={handlePollZoomNow}
        onPollGit={handlePollGitNow}
        updateState={updateState}
        currentTheme={settings?.theme || 'system'}
        onSetTheme={handleSetTheme}
      />
      <div className="app-shell">
        {/* Left Navigation Sidebar */}
        <aside className="sidebar">
          <div className="brand-box">
            <div className="brand-title" style={{ display: 'flex', alignItems: 'center', gap: '9px' }}>
              <img
                src={MESAI_ICON_DATA_URL}
                alt="MesAI Logo"
                style={{ width: '26px', height: '26px', objectFit: 'contain' }}
              />
              <span>MesAI</span>
            </div>
            <div className="brand-subtitle">DevTrack AI — Kanıta Dayalı Günlük Raporlama</div>
          </div>

        <nav className="nav-list">
          <button
            className={`nav-btn ${activeTab === 'dashboard' ? 'active' : ''}`}
            onClick={() => setActiveTab('dashboard')}
          >
            <DashboardIcon size={16} />
            <span>Gösterge Paneli</span>
          </button>
          <button
            className={`nav-btn ${activeTab === 'projects' ? 'active' : ''}`}
            onClick={() => setActiveTab('projects')}
          >
            <ProjectsIcon size={16} />
            <span>Projeler ({projects.filter((p) => p.enabled).length})</span>
          </button>
          <button
            className={`nav-btn ${activeTab === 'timeline' ? 'active' : ''}`}
            onClick={() => setActiveTab('timeline')}
          >
            <ActivityIcon size={16} />
            <span>Aktivite Akışı</span>
          </button>
          <button
            className={`nav-btn ${activeTab === 'report' ? 'active' : ''}`}
            onClick={() => setActiveTab('report')}
          >
            <ReportIcon size={16} />
            <span>Günlük Rapor</span>
          </button>
          <button
            className={`nav-btn ${activeTab === 'integrations' ? 'active' : ''}`}
            onClick={() => setActiveTab('integrations')}
          >
            <IntegrationsIcon size={16} />
            <span>Entegrasyonlar</span>
          </button>
        </nav>

        <div className="sidebar-nav-bottom">
          <button
            className={`nav-btn ${activeTab === 'settings' ? 'active' : ''}`}
            onClick={() => setActiveTab('settings')}
          >
            <SettingsIcon size={16} />
            <span>Ayarlar</span>
          </button>
        </div>

        <div className="sidebar-footer">
          <div style={{ fontSize: '11.5px', color: 'var(--text-secondary)' }}>
            ⚡ MesAI {updateState?.currentVersion ? `v${updateState.currentVersion}` : ''}
          </div>
          {updateState?.status === 'available' && updateState.updateInfo && (
            <button
              className="btn btn-sm"
              style={{
                background: 'var(--accent)',
                color: '#fff',
                width: '100%',
                marginTop: '6px',
                fontSize: '11.5px',
                padding: '4px 8px'
              }}
              onClick={() => setActiveTab('settings')}
            >
              🚀 Yeni Sürüm (v{updateState.updateInfo.version})
            </button>
          )}
          <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '4px' }}>
            Yerel Veritabanı: SQLite (WAL)
          </div>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="main-area">
        <header className="top-bar">
          <div className="top-bar-status">
            <span className={`badge ${isPaused ? 'badge-warning' : 'badge-success'}`}>
              {isPaused ? '⏸ Takip Duraklatıldı' : '● Takip Aktif'}
            </span>
            <span className={`badge ${zoomBadge.badge}`}>Zoom: {zoomBadge.text}</span>
            {updateState?.status === 'available' && updateState.updateInfo && (
              <span
                className="badge badge-info"
                style={{ cursor: 'pointer', background: 'var(--accent)', color: '#fff' }}
                onClick={() => setActiveTab('settings')}
                title="Güncellemeyi görüntülemek için tıklayın"
              >
                🚀 v{updateState.updateInfo.version} Mevcut
              </span>
            )}
            {toastMessage && (
              <span className="badge badge-info" style={{ fontWeight: 500 }}>
                {toastMessage}
              </span>
            )}
          </div>

          <div className="top-bar-actions">
            <button
              className={`btn btn-sm ${isPaused ? 'btn-success' : ''}`}
              onClick={handleTogglePaused}
              style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
            >
              {isPaused ? <PlayIcon size={14} /> : <PauseIcon size={14} />}
              <span>{isPaused ? 'Takibi Devam Ettir' : 'Takibi Duraklat'}</span>
            </button>
            <button
              className="btn btn-sm btn-primary"
              onClick={handlePollZoomNow}
              disabled={pollingZoom}
              style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
            >
              <MessageSquareIcon size={14} />
              <span>{pollingZoom ? 'Zoom Okunuyor...' : 'Şimdi Zoom Oku'}</span>
            </button>
            <button
              className="btn btn-sm"
              onClick={handlePollGitNow}
              disabled={pollingGit}
              style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
            >
              <GitCommitIcon size={14} />
              <span>{pollingGit ? 'Git Taranıyor...' : 'Şimdi Git Oku'}</span>
            </button>
          </div>
        </header>

        <main className="content-scroll">
          {activeTab === 'dashboard' && (
            <DashboardView
              summary={summary}
              loading={loading}
              onRefresh={refreshCoreData}
              onOpenTab={(t) => setActiveTab(t)}
              onInspectEvidence={(ev) => setInspectedEvidence(ev)}
            />
          )}

          {activeTab === 'projects' && (
            <ProjectsView
              projects={projects}
              watchRootPath={settings?.watchRootPath ?? 'C:\\Repos'}
              settings={settings}
              onUpdateSettings={async (partial) => {
                const updated = await window.mesaiApi.updateSettings(partial);
                setSettings(updated);
                await refreshCoreData();
              }}
              onScanRoot={async (rootPath) => {
                const updated = await window.mesaiApi.scanRootForProjects(rootPath);
                setProjects(updated);
                await refreshCoreData();
              }}
              onSelectFolder={() => window.mesaiApi.selectFolderDialog()}
              onUpdateProject={async (proj) => {
                const updated = await window.mesaiApi.updateProject(proj);
                setProjects(updated);
                await refreshCoreData();
              }}
            />
          )}

          {activeTab === 'timeline' && (
            <Suspense fallback={<SkeletonActivityList count={5} />}>
              <TimelineView
                projects={projects}
                onInspectEvidence={(ev) => setInspectedEvidence(ev)}
              />
            </Suspense>
          )}

          {activeTab === 'report' && (
            <Suspense fallback={<SkeletonReport />}>
              <DailyReportView
                projects={projects}
                onInspectEvidence={(ev) => setInspectedEvidence(ev)}
              />
            </Suspense>
          )}

          {activeTab === 'integrations' && (
            <Suspense fallback={<SkeletonIntegrations />}>
              <IntegrationsView
                onPollZoom={handlePollZoomNow}
                onPollGit={handlePollGitNow}
              />
            </Suspense>
          )}

          {activeTab === 'settings' && (
            <SettingsView
              settings={settings}
              onUpdateSettings={async (partial) => {
                const updated = await window.mesaiApi.updateSettings(partial);
                setSettings(updated);
                await refreshCoreData();
              }}
              onClearAllData={async () => {
                await window.mesaiApi.clearAllData();
                await refreshCoreData();
              }}
            />
          )}
        </main>
      </div>

      {/* Evidence Detail Inspection Modal */}
      {inspectedEvidence && (
        <div className="modal-backdrop" onClick={() => setInspectedEvidence(null)}>
          <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
            <div className="card-header">
              <h3 className="card-title">Kaynak Kanıt Detayı (Evidence)</h3>
              <button
                className="btn btn-sm"
                onClick={() => setInspectedEvidence(null)}
                style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
              >
                <CloseIcon size={14} />
                <span>Kapat</span>
              </button>
            </div>

            <div style={{ display: 'grid', gap: '8px', fontSize: '13.5px' }}>
              <div>
                <strong>Kanıt Kimliği (Yerel ID):</strong> <code>{inspectedEvidence.id}</code>
              </div>
              <div>
                <strong>Kaynak Türü:</strong>{' '}
                <span className="badge badge-info">
                  {SOURCE_LABELS[inspectedEvidence.sourceType] ?? inspectedEvidence.sourceType}
                </span>
              </div>
              <div>
                <strong>Sohbet / Depo Adı:</strong> {inspectedEvidence.chatOrRepoName || '-'}
              </div>
              <div>
                <strong>Gönderen / Yazar:</strong> {inspectedEvidence.sender || '-'}
              </div>
              <div>
                <strong>Kaynaktaki Özgün Tarih/Saat İfadesi:</strong>{' '}
                <code>{inspectedEvidence.rawTimestampText}</code>
              </div>
              <div>
                <strong>Çözümlenen Yerel Tarih/Saat (ISO):</strong>{' '}
                <code>{inspectedEvidence.resolvedTimestampIso || 'Belirsiz (Çözümlenemedi)'}</code> (
                {inspectedEvidence.timestampConfidence === 'exact'
                  ? 'Kesin Zaman'
                  : inspectedEvidence.timestampConfidence === 'resolved_relative'
                    ? 'Gözlem Zamanına Göre Göreli Çözümlendi'
                    : 'Belirsiz Tarih'}
                )
              </div>
              <div>
                <strong>Toplanma Zamanı:</strong> <code>{inspectedEvidence.collectedAt}</code>
              </div>
              <div>
                <strong>Kaynak Referansı / Parmak İzi:</strong>{' '}
                <code>{inspectedEvidence.externalRef || 'Yok (Yerel Üretildi)'}</code>
              </div>

              <div style={{ marginTop: '6px' }}>
                <strong>Kanıt Metni / İçeriği:</strong>
                <pre className="code-pre" style={{ marginTop: '6px' }}>
                  {inspectedEvidence.snippet}
                </pre>
              </div>

              {inspectedEvidence.links.length > 0 && (
                <div className="activity-links-box" style={{ marginTop: '4px' }}>
                  <div className="activity-links-header">
                    <span>🔗</span>
                    <span>Tespit Edilen Bağlantılar ({inspectedEvidence.links.length})</span>
                  </div>
                  <div className="activity-links-list">
                    {inspectedEvidence.links.map((lnk, idx) => (
                      <a
                        key={idx}
                        href={lnk}
                        target="_blank"
                        rel="noreferrer"
                        className="activity-link-item"
                        title={lnk}
                      >
                        <span className="activity-link-icon">
                          <ExternalLinkIcon size={12} />
                        </span>
                        <span className="activity-link-text">{lnk}</span>
                      </a>
                    ))}
                  </div>
                </div>
              )}

              <div>
                <strong>Ek Meta Veri:</strong>
                <pre className="code-pre" style={{ marginTop: '6px' }}>
                  {JSON.stringify(inspectedEvidence.metadata, null, 2)}
                </pre>
              </div>
            </div>
          </div>
        </div>
      )}
      </div>
    </div>
  );
};
