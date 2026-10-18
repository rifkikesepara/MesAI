import React, { useState } from 'react';
import type { DashboardSummary } from '../../shared/ipc-channels';
import type { AppSettings, Evidence, Project } from '../../shared/types';
import {
  ProjectsIcon,
  SearchIcon,
  SettingsIcon,
  ActivityIcon,
  ReportIcon
} from '../components/Icons';
import { SkeletonDashboard } from '../components/Skeleton';
import { VirtualList } from '../components/VirtualList';

export const SOURCE_LABELS: Record<string, string> = {
  zoom_chat: 'Zoom Sohbet',
  zoom_call: 'Zoom Arama Kaydı',
  git_commit: 'Git Commit',
  git_working_tree: 'Git Çalışma Ağacı (Commit Edilmemiş)',
  file_change: 'Dosya Değişikliği (Debounced)',
  jira_issue: 'Jira Kaydı',
  jenkins_build: 'Jenkins Build',
  manual_note: 'Manuel Not'
};

export const CATEGORY_LABELS: Record<string, string> = {
  development: 'Geliştirme',
  analysis: 'Analiz',
  technical_discussion: 'Teknik Görüşme',
  meeting: 'Toplantı / Görüşme',
  research: 'Araştırma'
};

export const STATUS_LABELS: Record<string, string> = {
  completed: 'Tamamlandı',
  in_progress: 'Devam Ediyor',
  decision: 'Karar',
  blocker: 'Engel / Risk',
  info: 'Bilgi'
};

export const ZOOM_STATUS_LABELS: Record<string, { text: string; badge: string }> = {
  ok: { text: 'Çalışıyor (Açık Sohbet Okundu)', badge: 'badge-success' },
  zoom_not_running: { text: 'Zoom Kapalı (Çalışmıyor)', badge: 'badge-danger' },
  window_minimized_or_hidden: { text: 'Zoom Küçültülmüş / Gizli', badge: 'badge-warning' },
  chat_panel_not_open: { text: 'Team Chat Paneli Açık Değil', badge: 'badge-warning' },
  timeout: { text: 'Okuma Zaman Aşımı', badge: 'badge-danger' },
  error: { text: 'Okuma Hatası', badge: 'badge-danger' },
  idle: { text: 'Beklemede', badge: 'badge-neutral' }
};

export const DashboardView: React.FC<{
  summary: DashboardSummary | null;
  loading: boolean;
  onRefresh: () => void;
  onOpenTab: (tab: 'timeline' | 'report' | 'projects' | 'integrations') => void;
  onInspectEvidence: (ev: Evidence) => void;
}> = ({ summary, loading, onRefresh, onOpenTab, onInspectEvidence }) => {
  if (loading && !summary) {
    return <SkeletonDashboard />;
  }

  if (!summary) {
    return (
      <div className="card">
        <p>Gösterge paneli verisi alınamadı.</p>
        <button className="btn btn-primary" onClick={onRefresh}>
          Tekrar Dene
        </button>
      </div>
    );
  }

  const zoomSync = summary.syncStates.find((s) => s.connector === 'zoom_reader');
  const gitSync = summary.syncStates.find((s) => s.connector === 'git_watcher');
  const zoomInfo = ZOOM_STATUS_LABELS[zoomSync?.status ?? 'idle'] ?? ZOOM_STATUS_LABELS.idle;

  return (
    <div>
      <div className="alert-banner">
        <strong>API’siz Yerel Zoom Okuyucu Kapsamı ve Sınırlamaları:</strong>
        <ul style={{ margin: '6px 0 0 0', paddingLeft: '20px' }}>
          {summary.zoomLimitationBanner.map((lim, idx) => (
            <li key={idx}>{lim}</li>
          ))}
        </ul>
      </div>

      <div className="grid-4">
        <div className="stat-card">
          <div className="stat-label">Takip Durumu</div>
          <div className="stat-value" style={{ fontSize: '20px', marginTop: '10px' }}>
            <span className={`badge ${summary.trackingPaused ? 'badge-warning' : 'badge-success'}`}>
              {summary.trackingPaused ? '⏸ Duraklatıldı' : '● Aktif İzleniyor'}
            </span>
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '8px' }}>
            Tarih: {summary.todayDate}
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-label">Bugünkü Aktiviteler</div>
          <div className="stat-value">{summary.todayActivitiesCount}</div>
          <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '4px' }}>
            Zoom: {summary.todayZoomMessagesCount} | Git/Dosya: {summary.todayGitActivitiesCount}
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-label">İzlenen Git Projesi</div>
          <div className="stat-value">{summary.activeProjectsCount}</div>
          <div style={{ marginTop: '6px' }}>
            <button className="btn btn-sm" onClick={() => onOpenTab('projects')}>
              Projeleri Yönet
            </button>
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-label">Bekleyen Eşleştirme Önerisi</div>
          <div className="stat-value">{summary.pendingMatchSuggestionsCount}</div>
          <div style={{ marginTop: '6px' }}>
            <button className="btn btn-sm" onClick={() => onOpenTab('timeline')}>
              Akışta İncele
            </button>
          </div>
        </div>
      </div>

      <div className="grid-2">
        <div className="card">
          <div className="card-header">
            <h3 className="card-title">Zoom Team Chat Okuyucu Durumu</h3>
            <span className={`badge ${zoomInfo.badge}`}>{zoomInfo.text}</span>
          </div>
          <div style={{ fontSize: '13px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <div>
              <strong>Açık Sohbet:</strong>{' '}
              {(zoomSync?.metadata?.activeChatName as string) || 'Henüz okunmadı'} (
              {(zoomSync?.metadata?.windowState as string) || 'normal'})
            </div>
            <div>
              <strong>Son Başarılı Okuma:</strong> {zoomSync?.lastSuccessAt || 'Yok'}
            </div>
            <div>
              <strong>Toplam Kaydedilen Mesaj:</strong> {zoomSync?.recordsCount ?? 0}
            </div>
            {zoomSync?.lastError && (
              <div style={{ color: 'var(--danger)' }}>
                <strong>Durum Detayı:</strong> {zoomSync.lastError}
              </div>
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <h3 className="card-title">Git & Dosya İzleyici Durumu</h3>
            <span className={`badge ${gitSync?.status === 'ok' ? 'badge-success' : 'badge-neutral'}`}>
              {gitSync?.status === 'ok' ? 'Aktif' : gitSync?.status || 'Hazır'}
            </span>
          </div>
          <div style={{ fontSize: '13px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <div>
              <strong>Son Başarılı Tarama:</strong> {gitSync?.lastSuccessAt || 'Yok'}
            </div>
            <div>
              <strong>Taranan Proje Sayısı:</strong>{' '}
              {(gitSync?.metadata?.scannedProjects as number) ?? summary.activeProjectsCount}
            </div>
            <div>
              <strong>Toplanan Git/Dosya Kaydı:</strong> {gitSync?.recordsCount ?? 0}
            </div>
            {gitSync?.lastError && (
              <div style={{ color: 'var(--danger)' }}>
                <strong>Son Hata:</strong> {gitSync.lastError}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <h3 className="card-title">Son Toplanan Aktiviteler</h3>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              className="btn btn-sm"
              onClick={() => onOpenTab('timeline')}
              style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
            >
              <ActivityIcon size={14} />
              <span>Tüm Akışı Gör</span>
            </button>
            <button
              className="btn btn-sm btn-primary"
              onClick={() => onOpenTab('report')}
              style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
            >
              <ReportIcon size={14} />
              <span>Günlük Rapor Üret</span>
            </button>
          </div>
        </div>

        {summary.recentActivities.length === 0 ? (
          <div style={{ color: 'var(--text-secondary)', padding: '16px 0' }}>
            Henüz toplanmış aktivite bulunmuyor. Üst çubuktan <strong>"Şimdi Zoom Oku"</strong> veya{' '}
            <strong>"Şimdi Git Oku"</strong> butonunu kullanabilirsiniz.
          </div>
        ) : (
          summary.recentActivities.slice(0, 10).map((act) => (
            <div key={act.id} className="item-row">
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px' }}>
                <div>
                  <span className="badge badge-info" style={{ marginRight: '8px' }}>
                    {SOURCE_LABELS[act.sourceType] ?? act.sourceType}
                  </span>
                  <span className="badge badge-neutral" style={{ marginRight: '8px' }}>
                    {CATEGORY_LABELS[act.category] ?? act.category}
                  </span>
                  <strong>{act.title}</strong>
                </div>
                <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                  Özgün Zaman: <code>{act.rawTimestampText}</code>
                </div>
              </div>
              <div style={{ marginTop: '6px', color: 'var(--text-primary)' }}>{act.summary}</div>
              {act.evidences && act.evidences.length > 0 && (
                <div style={{ marginTop: '6px' }}>
                  <button
                    className="btn btn-sm"
                    onClick={() => onInspectEvidence(act.evidences![0])}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
                  >
                    <SearchIcon size={13} />
                    <span>Kaynak Kanıtı İncele ({act.evidences.length})</span>
                  </button>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export const ProjectsView: React.FC<{
  projects: Project[];
  watchRootPath: string;
  settings?: AppSettings | null;
  onUpdateSettings?: (partial: Partial<AppSettings>) => Promise<void>;
  onScanRoot: (rootPath: string) => Promise<void>;
  onSelectFolder: () => Promise<string | null>;
  onUpdateProject: (proj: {
    id: string;
    enabled: boolean;
    excludedPaths: string[];
    mappedChatNames: string[];
    jiraProjectKeys: string[];
  }) => Promise<void>;
}> = ({ projects, watchRootPath, settings, onUpdateSettings, onScanRoot, onSelectFolder, onUpdateProject }) => {
  const [rootInput, setRootInput] = useState(watchRootPath || 'C:\\Repos');
  const [scanning, setScanning] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [chatInput, setChatInput] = useState('');
  const [jiraInput, setJiraInput] = useState('');
  const [exclInput, setExclInput] = useState('');

  // Global mapping state
  const [editingGlobal, setEditingGlobal] = useState(false);
  const [globalChatInput, setGlobalChatInput] = useState('');
  const [globalJiraInput, setGlobalJiraInput] = useState('');
  const [globalExclInput, setGlobalExclInput] = useState('');

  const startEditGlobal = () => {
    setGlobalChatInput((settings?.globalMappedChatNames || []).join(', '));
    setGlobalJiraInput((settings?.globalJiraProjectKeys || []).join(', '));
    setGlobalExclInput((settings?.globalExclusions || []).join(', '));
    setEditingGlobal(true);
  };

  const saveEditGlobal = async () => {
    if (!onUpdateSettings) return;
    await onUpdateSettings({
      globalMappedChatNames: globalChatInput
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      globalJiraProjectKeys: globalJiraInput
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean),
      globalExclusions: globalExclInput
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    });
    setEditingGlobal(false);
  };

  const handleBrowse = async () => {
    const picked = await onSelectFolder();
    if (picked) {
      setRootInput(picked);
      setScanning(true);
      try {
        await onScanRoot(picked);
      } finally {
        setScanning(false);
      }
    }
  };

  const handleScan = async () => {
    if (!rootInput.trim()) return;
    setScanning(true);
    try {
      await onScanRoot(rootInput.trim());
    } finally {
      setScanning(false);
    }
  };

  const startEdit = (p: Project) => {
    setEditingId(p.id);
    setChatInput(p.mappedChatNames.join(', '));
    setJiraInput(p.jiraProjectKeys.join(', '));
    setExclInput(p.excludedPaths.join(', '));
  };

  const saveEdit = async (p: Project) => {
    await onUpdateProject({
      id: p.id,
      enabled: p.enabled,
      mappedChatNames: chatInput
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      jiraProjectKeys: jiraInput
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean),
      excludedPaths: exclInput
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    });
    setEditingId(null);
  };

  return (
    <div>
      <div className="card">
        <div className="card-header">
          <h3 className="card-title">Ana Proje Klasörü ve Git Keşfi</h3>
        </div>
        <p style={{ color: 'var(--text-secondary)', marginTop: 0 }}>
          Seçilen ana klasör altındaki Git depoları salt-okunur olarak keşfedilir. Kaynak dosyalarda
          hiçbir değişiklik yapılmaz; <code>node_modules</code>, <code>.git</code>, <code>target</code>,{' '}
          <code>dist</code>, <code>build</code> ve gizli dosyalar otomatik hariç tutulur.
        </p>
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
          <input
            className="input"
            value={rootInput}
            onChange={(e) => setRootInput(e.target.value)}
            placeholder="Örn: C:\Repos"
          />
          <button
            className="btn"
            onClick={handleBrowse}
            style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
          >
            <ProjectsIcon size={14} />
            <span>Klasör Seç</span>
          </button>
          <button
            className="btn btn-primary"
            onClick={handleScan}
            disabled={scanning}
            style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
          >
            <SearchIcon size={14} />
            <span>{scanning ? 'Taranıyor...' : 'Git Projelerini Keşfet'}</span>
          </button>
        </div>
      </div>

      {/* Global Mappings & Exclusions Card */}
      <div className="card" style={{ borderLeft: '4px solid var(--accent)' }}>
        <div className="card-header">
          <div>
            <h3 className="card-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span>🌐 Genel (Global) Eşleştirme & Filtre Tanımları</span>
            </h3>
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px' }}>
              Burada tanımlanan kurallar tek tek projelere ek olarak tüm projelere otomatik uygulanır.
            </div>
          </div>
          {onUpdateSettings && (
            <button
              className="btn btn-sm"
              onClick={() => (editingGlobal ? setEditingGlobal(false) : startEditGlobal())}
              style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
            >
              <SettingsIcon size={13} />
              <span>{editingGlobal ? 'Kapat' : 'Genel Kuralları Düzenle'}</span>
            </button>
          )}
        </div>

        <div style={{ fontSize: '12.5px', color: 'var(--text-secondary)', display: 'grid', gap: '4px', marginTop: '4px' }}>
          <div>
            <strong>Global Zoom Sohbetleri ({settings?.globalMappedChatNames?.length || 0}):</strong>{' '}
            {settings?.globalMappedChatNames && settings.globalMappedChatNames.length > 0 ? (
              settings.globalMappedChatNames.map((c) => (
                <span key={c} className="badge badge-info" style={{ marginRight: '4px' }}>
                  {c}
                </span>
              ))
            ) : (
              <span style={{ color: 'var(--text-muted)' }}>Tanımlanmadı</span>
            )}
          </div>
          <div>
            <strong>Global Jira Önekleri ({settings?.globalJiraProjectKeys?.length || 0}):</strong>{' '}
            {settings?.globalJiraProjectKeys && settings.globalJiraProjectKeys.length > 0 ? (
              settings.globalJiraProjectKeys.map((k) => (
                <span key={k} className="badge badge-success" style={{ marginRight: '4px' }}>
                  {k}
                </span>
              ))
            ) : (
              <span style={{ color: 'var(--text-muted)' }}>Tanımlanmadı</span>
            )}
          </div>
          <div>
            <strong>Global Hariç Tutulan Filtreler ({settings?.globalExclusions?.length || 0}):</strong>{' '}
            {(settings?.globalExclusions || []).slice(0, 8).join(', ')}
            {(settings?.globalExclusions || []).length > 8 ? ` +${(settings?.globalExclusions || []).length - 8} daha...` : ''}
          </div>
        </div>

        {editingGlobal && onUpdateSettings && (
          <div
            style={{
              marginTop: '12px',
              padding: '12px',
              background: 'var(--bg-primary)',
              borderRadius: '8px',
              display: 'grid',
              gap: '10px'
            }}
          >
            <div>
              <label style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                Genel Zoom Sohbet / Kanal Adları (virgülle ayırın, örn: BAM Ekibi, Genel Duyurular)
              </label>
              <input
                className="input"
                value={globalChatInput}
                onChange={(e) => setGlobalChatInput(e.target.value)}
                placeholder="Örn: BAM Ekibi, Sprint Planning, Genel Duyurular"
              />
            </div>
            <div>
              <label style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                Genel Jira İş Anahtarı Önekleri (virgülle ayırın, örn: BAM, CORE, INFRA)
              </label>
              <input
                className="input"
                value={globalJiraInput}
                onChange={(e) => setGlobalJiraInput(e.target.value)}
                placeholder="Örn: BAM, CORE, DEVOPS"
              />
            </div>
            <div>
              <label style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                Genel Hariç Tutulan Dosya / Klasör Kalıpları (virgülle ayırın)
              </label>
              <input
                className="input"
                value={globalExclInput}
                onChange={(e) => setGlobalExclInput(e.target.value)}
                placeholder="Örn: node_modules, .git, dist, build, target"
              />
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button className="btn btn-sm btn-primary" onClick={saveEditGlobal}>
                Genel Ayarları Kaydet
              </button>
              <button className="btn btn-sm" onClick={() => setEditingGlobal(false)}>
                İptal
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-header">
          <h3 className="card-title">Keşfedilen Git Projeleri ({projects.length})</h3>
        </div>

        {projects.length === 0 ? (
          <div style={{ color: 'var(--text-secondary)', padding: '12px 0' }}>
            Bu klasör altında henüz Git projesi bulunamadı.
          </div>
        ) : (
          <VirtualList
            items={projects}
            itemHeight={105}
            renderItem={(p) => (
            <div key={p.id} className="item-row">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <strong style={{ fontSize: '15px' }}>{p.name}</strong>{' '}
                  <span className={`badge ${p.enabled ? 'badge-success' : 'badge-neutral'}`}>
                    {p.enabled ? 'İzleniyor' : 'Hariç Tutuldu'}
                  </span>
                  {p.currentBranch && (
                    <span className="badge badge-info" style={{ marginLeft: '6px' }}>
                       dal: {p.currentBranch}
                    </span>
                  )}
                  <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '3px' }}>
                    Yol: <code>{p.rootPath}</code>
                    {p.repositoryUrl ? ` | Remote: ${p.repositoryUrl}` : ''}
                  </div>
                </div>

                <div style={{ display: 'flex', gap: '8px' }}>
                  <button
                    className="btn btn-sm"
                    onClick={() =>
                      onUpdateProject({
                        id: p.id,
                        enabled: !p.enabled,
                        excludedPaths: p.excludedPaths,
                        mappedChatNames: p.mappedChatNames,
                        jiraProjectKeys: p.jiraProjectKeys
                      })
                    }
                  >
                    {p.enabled ? 'İzlemeyi Kapat' : 'İzlemeyi Aç'}
                  </button>
                  <button
                    className="btn btn-sm"
                    onClick={() => startEdit(p)}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
                  >
                    <SettingsIcon size={13} />
                    <span>Eşleştirme & Filtre</span>
                  </button>
                </div>
              </div>

              <div style={{ fontSize: '12.5px', color: 'var(--text-secondary)', marginTop: '6px' }}>
                <span>
                  <strong>Eşleşen Zoom Sohbetleri:</strong>{' '}
                  {p.mappedChatNames.length > 0 ? p.mappedChatNames.join(', ') : 'Tanımlanmadı'}
                </span>{' '}
                |{' '}
                <span>
                  <strong>Jira Önekleri:</strong>{' '}
                  {p.jiraProjectKeys.length > 0 ? p.jiraProjectKeys.join(', ') : 'Tanımlanmadı'}
                </span>{' '}
                |{' '}
                <span>
                  <strong>Ek Hariç Tutulan Klasörler:</strong>{' '}
                  {p.excludedPaths.length > 0 ? p.excludedPaths.join(', ') : 'Varsayılan koruyucu filtreler'}
                </span>
              </div>

              {editingId === p.id && (
                <div
                  style={{
                    marginTop: '12px',
                    padding: '12px',
                    background: 'var(--bg-primary)',
                    borderRadius: '8px',
                    display: 'grid',
                    gap: '10px'
                  }}
                >
                  <div>
                    <label style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                      Eşleşen Zoom Sohbet / Kanal Adları (virgülle ayırın, örn: BAM Ekibi, Yasin Kamış)
                    </label>
                    <input
                      className="input"
                      value={chatInput}
                      onChange={(e) => setChatInput(e.target.value)}
                    />
                  </div>
                  <div>
                    <label style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                      Jira İş Anahtarı Önekleri (virgülle ayırın, örn: BAM, NOVA)
                    </label>
                    <input
                      className="input"
                      value={jiraInput}
                      onChange={(e) => setJiraInput(e.target.value)}
                    />
                  </div>
                  <div>
                    <label style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                      Proje Özel Hariç Tutulan Alt Klasörler (virgülle ayırın)
                    </label>
                    <input
                      className="input"
                      value={exclInput}
                      onChange={(e) => setExclInput(e.target.value)}
                    />
                  </div>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button className="btn btn-sm btn-primary" onClick={() => saveEdit(p)}>
                      Kaydet
                    </button>
                    <button className="btn btn-sm" onClick={() => setEditingId(null)}>
                      İptal
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        />
      )}
    </div>
  </div>
);
};
