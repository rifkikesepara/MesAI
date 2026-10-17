import React, { useEffect, useState } from 'react';
import type { DashboardSummary } from '../shared/ipc-channels';
import type { AppSettings, Evidence, Project, UpdateState } from '../shared/types';
import {
  DashboardView,
  ProjectsView,
  SOURCE_LABELS,
  ZOOM_STATUS_LABELS
} from './views/DashboardAndProjectsView';
import { DailyReportView, TimelineView } from './views/TimelineAndReportView';
import { IntegrationsView, SettingsView } from './views/IntegrationsAndSettingsView';

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

  const refreshCoreData = async () => {
    setLoading(true);
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
      setLoading(false);
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
    const interval = setInterval(() => {
      void refreshCoreData();
    }, 15_000);
    return () => {
      clearInterval(interval);
      unsub?.();
    };
  }, []);

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
    <div className="app-shell">
      {/* Left Navigation Sidebar */}
      <aside className="sidebar">
        <div className="brand-box">
          <div className="brand-title" style={{ display: 'flex', alignItems: 'center', gap: '9px' }}>
            <img
              src="/icon.png"
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
            <span>📊</span>
            <span>Gösterge Paneli</span>
          </button>
          <button
            className={`nav-btn ${activeTab === 'projects' ? 'active' : ''}`}
            onClick={() => setActiveTab('projects')}
          >
            <span>📁</span>
            <span>Projeler ({projects.filter((p) => p.enabled).length})</span>
          </button>
          <button
            className={`nav-btn ${activeTab === 'timeline' ? 'active' : ''}`}
            onClick={() => setActiveTab('timeline')}
          >
            <span>🕒</span>
            <span>Aktivite Akışı</span>
          </button>
          <button
            className={`nav-btn ${activeTab === 'report' ? 'active' : ''}`}
            onClick={() => setActiveTab('report')}
          >
            <span>📝</span>
            <span>Günlük Rapor</span>
          </button>
          <button
            className={`nav-btn ${activeTab === 'integrations' ? 'active' : ''}`}
            onClick={() => setActiveTab('integrations')}
          >
            <span>🔌</span>
            <span>Entegrasyonlar</span>
          </button>
          <button
            className={`nav-btn ${activeTab === 'settings' ? 'active' : ''}`}
            onClick={() => setActiveTab('settings')}
          >
            <span>⚙️</span>
            <span>Ayarlar</span>
          </button>
        </nav>

        <div className="sidebar-footer">
          <div style={{ fontSize: '11.5px', color: 'var(--text-secondary)' }}>
            ⚡ MesAI v{updateState?.currentVersion || '1.0.1'}
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
            >
              {isPaused ? '▶ Takibi Devam Ettir' : '⏸ Takibi Duraklat'}
            </button>
            <button
              className="btn btn-sm btn-primary"
              onClick={handlePollZoomNow}
              disabled={pollingZoom}
            >
              {pollingZoom ? 'Zoom Okunuyor...' : '💬 Şimdi Zoom Oku'}
            </button>
            <button
              className="btn btn-sm"
              onClick={handlePollGitNow}
              disabled={pollingGit}
            >
              {pollingGit ? 'Git Taranıyor...' : '🌿 Şimdi Git Oku'}
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
            <TimelineView
              projects={projects}
              onInspectEvidence={(ev) => setInspectedEvidence(ev)}
            />
          )}

          {activeTab === 'report' && (
            <DailyReportView
              projects={projects}
              onInspectEvidence={(ev) => setInspectedEvidence(ev)}
            />
          )}

          {activeTab === 'integrations' && (
            <IntegrationsView
              onPollZoom={handlePollZoomNow}
              onPollGit={handlePollGitNow}
            />
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
              <h3 className="card-title">🔍 Kaynak Kanıt Detayı (Evidence)</h3>
              <button className="btn btn-sm" onClick={() => setInspectedEvidence(null)}>
                Kapat ✕
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
                        <span className="activity-link-icon">↗</span>
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
  );
};
