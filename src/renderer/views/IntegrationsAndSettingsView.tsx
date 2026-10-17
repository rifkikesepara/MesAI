import React, { useEffect, useState } from 'react';
import type { AppSettings, IntegrationHealth, UpdateState } from '../../shared/types';
import { ZOOM_STATUS_LABELS } from './DashboardAndProjectsView';
import { MESAI_ICON_DATA_URL } from '../assets/logo';

export const IntegrationsView: React.FC<{
  onPollZoom: () => Promise<void>;
  onPollGit: () => Promise<void>;
}> = ({ onPollZoom, onPollGit }) => {
  const [health, setHealth] = useState<IntegrationHealth | null>(null);
  const [loading, setLoading] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const [jiraUrl, setJiraUrl] = useState('');
  const [jiraEmail, setJiraEmail] = useState('');
  const [jiraToken, setJiraToken] = useState('');

  const [jenkinsUrl, setJenkinsUrl] = useState('');
  const [jenkinsUser, setJenkinsUser] = useState('');
  const [jenkinsToken, setJenkinsToken] = useState('');

  const loadHealth = async () => {
    setLoading(true);
    try {
      const h = await window.mesaiApi.getIntegrationsHealth();
      setHealth(h);
      setJiraUrl(h.jira.url || '');
      setJenkinsUrl(h.jenkins.url || '');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadHealth();
  }, []);

  const handleSaveJira = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await window.mesaiApi.saveIntegrationSecret({
        service: 'jira',
        url: jiraUrl,
        usernameOrEmail: jiraEmail,
        token: jiraToken
      });
      setJiraToken('');
      setFeedback('Jira bilgileri OS DPAPI (safeStorage) ile şifrelenerek kaydedildi.');
      await loadHealth();
    } catch (err) {
      setFeedback(`Hata: ${(err as Error).message}`);
    }
  };

  const handleTestJira = async () => {
    setFeedback('Jira bağlantısı test ediliyor...');
    const res = await window.mesaiApi.testIntegrationConnection('jira');
    setFeedback(res.message);
    await loadHealth();
  };

  const handleSaveJenkins = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await window.mesaiApi.saveIntegrationSecret({
        service: 'jenkins',
        url: jenkinsUrl,
        usernameOrEmail: jenkinsUser,
        token: jenkinsToken
      });
      setJenkinsToken('');
      setFeedback('Jenkins bilgileri OS DPAPI (safeStorage) ile şifrelenerek kaydedildi.');
      await loadHealth();
    } catch (err) {
      setFeedback(`Hata: ${(err as Error).message}`);
    }
  };

  const handleTestJenkins = async () => {
    setFeedback('Jenkins bağlantısı test ediliyor...');
    const res = await window.mesaiApi.testIntegrationConnection('jenkins');
    setFeedback(res.message);
    await loadHealth();
  };

  if (loading && !health) {
    return <div className="card">Entegrasyon sağlık durumları kontrol ediliyor...</div>;
  }

  if (!health) {
    return (
      <div className="card">
        <button className="btn btn-primary" onClick={loadHealth}>
          Yeniden Dene
        </button>
      </div>
    );
  }

  const zoomStatus = ZOOM_STATUS_LABELS[health.zoom.status] ?? ZOOM_STATUS_LABELS.idle;

  return (
    <div>
      {feedback && <div className="alert-banner">{feedback}</div>}

      <div className="grid-2">
        {/* 1. Zoom Local UIA Reader */}
        <div className="card">
          <div className="card-header">
            <h3 className="card-title">1. Yerel Zoom Team Chat UIA Okuyucu</h3>
            <span className={`badge ${zoomStatus.badge}`}>{zoomStatus.text}</span>
          </div>
          <div style={{ fontSize: '13px', display: 'grid', gap: '6px' }}>
            <div>
              <strong>Yürütülebilir Dosya:</strong> <code>{health.zoom.executablePath}</code> (
              {health.zoom.executableExists ? 'Mevcut ✓' : 'Bulunamadı ✕'})
            </div>
            <div>
              <strong>Açık Sohbet:</strong> {health.zoom.activeChatName || 'Yok'} (Pencere:{' '}
              {health.zoom.windowState || 'bilinmiyor'})
            </div>
            <div>
              <strong>Son Başarılı Okuma:</strong> {health.zoom.lastSuccessAt || 'Henüz yok'}
            </div>
            <div>
              <strong>Toplam Kayıt:</strong> {health.zoom.recordsCount}
            </div>
            {health.zoom.lastError && (
              <div style={{ color: '#fca5a5' }}>
                <strong>Durum Mesajı:</strong> {health.zoom.lastError}
              </div>
            )}
            <div style={{ marginTop: '8px' }}>
              <button
                className="btn btn-primary btn-sm"
                onClick={async () => {
                  await onPollZoom();
                  await loadHealth();
                }}
              >
                🔄 Şimdi Zoom Penceresini Oku
              </button>
            </div>
          </div>
        </div>

        {/* 2. Git & File Watcher */}
        <div className="card">
          <div className="card-header">
            <h3 className="card-title">2. Git CLI & Dosya İzleyici</h3>
            <span className={`badge ${health.git.gitVersion ? 'badge-success' : 'badge-danger'}`}>
              {health.git.gitVersion ? 'Hazır ✓' : 'Git Bulunamadı'}
            </span>
          </div>
          <div style={{ fontSize: '13px', display: 'grid', gap: '6px' }}>
            <div>
              <strong>Kurulu Git Sürümü:</strong> <code>{health.git.gitVersion || 'Yok'}</code>
            </div>
            <div>
              <strong>İzlenen Etkin Proje Sayısı:</strong> {health.git.watchedProjectsCount}
            </div>
            <div>
              <strong>Son Tarama Zamanı:</strong> {health.git.lastSuccessAt || 'Henüz yok'}
            </div>
            {health.git.lastError && (
              <div style={{ color: '#fca5a5' }}>
                <strong>Son Hata:</strong> {health.git.lastError}
              </div>
            )}
            <div style={{ marginTop: '8px' }}>
              <button
                className="btn btn-primary btn-sm"
                onClick={async () => {
                  await onPollGit();
                  await loadHealth();
                }}
              >
                🔄 Şimdi Git Depolarını Tara
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* 3. AI Provider Layer */}
      <div className="card">
        <div className="card-header">
          <h3 className="card-title">3. Raporlama ve AI Sağlayıcı Katmanı</h3>
          <span className="badge badge-success">
            Aktif: {health.ai.activeProvider === 'local_rule' ? 'Yerel Kurallı Motor' : 'Gemini CLI'}
          </span>
        </div>
        <div style={{ fontSize: '13px', display: 'grid', gap: '6px' }}>
          <div>
            <strong>Yerel Kurallı Motor (LocalRuleProvider):</strong> Hazır (%100 çevrimdışı, veri dışarı
            çıkmaz)
          </div>
          <div>
            <strong>Gemini CLI Durumu:</strong>{' '}
            {health.ai.geminiCliInstalled
              ? `Kurulu (Sürüm: ${health.ai.geminiCliVersion})`
              : 'Kurulu değil veya erişilemedi'}
          </div>
          <div>
            <strong>Uzak AI Veri Gönderim İzni:</strong>{' '}
            {health.ai.remoteAiAllowed ? 'Açık (Önizleme ile)' : 'Kapalı (Varsayılan Güvenli Mod)'}
          </div>
          {health.ai.lastError && (
            <div style={{ color: '#fbbf24' }}>
              <strong>Son AI Notu / Yedek Durumu:</strong> {health.ai.lastError}
            </div>
          )}
        </div>
      </div>

      {/* 4. Optional Jira & Jenkins */}
      <div className="grid-2">
        <div className="card">
          <div className="card-header">
            <h3 className="card-title">4. Jira Entegrasyonu (İsteğe Bağlı / Salt-Okunur)</h3>
            <span
              className={`badge ${
                health.jira.status === 'connected'
                  ? 'badge-success'
                  : health.jira.status === 'error'
                    ? 'badge-danger'
                    : 'badge-neutral'
              }`}
            >
              {health.jira.status === 'not_configured'
                ? 'Yapılandırılmadı'
                : health.jira.status === 'untested'
                  ? 'Doğrulanmadı (Test Bekliyor)'
                  : health.jira.status === 'connected'
                    ? 'Bağlantı Doğrulandı'
                    : 'Bağlantı Hatası'}
            </span>
          </div>
          <form onSubmit={handleSaveJira} style={{ display: 'grid', gap: '8px' }}>
            <input
              className="input"
              placeholder="Jira URL (Örn: https://32bitbilgisayar.atlassian.net)"
              value={jiraUrl}
              onChange={(e) => setJiraUrl(e.target.value)}
            />
            <input
              className="input"
              placeholder="Kurumsal E-posta"
              value={jiraEmail}
              onChange={(e) => setJiraEmail(e.target.value)}
            />
            <input
              type="password"
              className="input"
              placeholder="Jira API Token (DPAPI ile şifrelenir, SQLite'a düz yazılmaz)"
              value={jiraToken}
              onChange={(e) => setJiraToken(e.target.value)}
            />
            {health.jira.lastError && (
              <div style={{ fontSize: '12px', color: '#fca5a5' }}>{health.jira.lastError}</div>
            )}
            <div style={{ display: 'flex', gap: '8px' }}>
              <button type="submit" className="btn btn-sm btn-primary">
                Şifreli Kaydet
              </button>
              <button type="button" className="btn btn-sm" onClick={handleTestJira}>
                Gerçek Bağlantı Testi Yap
              </button>
            </div>
          </form>
        </div>

        <div className="card">
          <div className="card-header">
            <h3 className="card-title">5. Jenkins Entegrasyonu (İsteğe Bağlı / Salt-Okunur)</h3>
            <span
              className={`badge ${
                health.jenkins.status === 'connected'
                  ? 'badge-success'
                  : health.jenkins.status === 'error'
                    ? 'badge-danger'
                    : 'badge-neutral'
              }`}
            >
              {health.jenkins.status === 'not_configured'
                ? 'Yapılandırılmadı'
                : health.jenkins.status === 'untested'
                  ? 'Doğrulanmadı (Test Bekliyor)'
                  : health.jenkins.status === 'connected'
                    ? 'Bağlantı Doğrulandı'
                    : 'Bağlantı Hatası'}
            </span>
          </div>
          <form onSubmit={handleSaveJenkins} style={{ display: 'grid', gap: '8px' }}>
            <input
              className="input"
              placeholder="Jenkins URL (Örn: https://jenkins.sirket.local)"
              value={jenkinsUrl}
              onChange={(e) => setJenkinsUrl(e.target.value)}
            />
            <input
              className="input"
              placeholder="Kullanıcı Adı"
              value={jenkinsUser}
              onChange={(e) => setJenkinsUser(e.target.value)}
            />
            <input
              type="password"
              className="input"
              placeholder="Jenkins API Token (DPAPI ile şifrelenir)"
              value={jenkinsToken}
              onChange={(e) => setJenkinsToken(e.target.value)}
            />
            {health.jenkins.lastError && (
              <div style={{ fontSize: '12px', color: '#fca5a5' }}>{health.jenkins.lastError}</div>
            )}
            <div style={{ display: 'flex', gap: '8px' }}>
              <button type="submit" className="btn btn-sm btn-primary">
                Şifreli Kaydet
              </button>
              <button type="button" className="btn btn-sm" onClick={handleTestJenkins}>
                Gerçek Bağlantı Testi Yap
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};

export const SettingsView: React.FC<{
  settings: AppSettings | null;
  onUpdateSettings: (partial: Partial<AppSettings>) => Promise<void>;
  onClearAllData: () => Promise<void>;
}> = ({ settings, onUpdateSettings, onClearAllData }) => {
  const [form, setForm] = useState<AppSettings | null>(settings);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [updateState, setUpdateState] = useState<UpdateState | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);

  useEffect(() => {
    setForm(settings);
  }, [settings]);

  useEffect(() => {
    void window.mesaiApi.getUpdateState().then(setUpdateState);
    const cleanup = window.mesaiApi.onUpdateStateChanged((state) => {
      setUpdateState(state);
    });
    return () => {
      cleanup?.();
    };
  }, []);

  const handleCheckUpdates = async () => {
    setCheckingUpdate(true);
    try {
      const res = await window.mesaiApi.checkForUpdates();
      setUpdateState(res);
    } finally {
      setCheckingUpdate(false);
    }
  };

  const handleDownloadUpdate = async () => {
    await window.mesaiApi.downloadUpdate();
  };

  const handleInstallUpdate = async () => {
    await window.mesaiApi.quitAndInstallUpdate();
  };

  if (!form) {
    return <div className="card">Ayarlar yükleniyor...</div>;
  }

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    await onUpdateSettings({
      zoomPollIntervalSeconds: Math.max(10, Number(form.zoomPollIntervalSeconds) || 30),
      gitPollIntervalSeconds: Math.max(20, Number(form.gitPollIntervalSeconds) || 60),
      workdayStart: form.workdayStart,
      workdayEnd: form.workdayEnd,
      endOfDayNotification: form.endOfDayNotification,
      timezone: form.timezone,
      retentionDays: Math.max(7, Number(form.retentionDays) || 90),
      aiProvider: form.aiProvider,
      allowRemoteAiSend: form.allowRemoteAiSend,
      autoLaunchOnStartup: form.autoLaunchOnStartup,
      autoCheckUpdatesOnStartup: form.autoCheckUpdatesOnStartup,
      trackingPaused: form.trackingPaused
    });
    setSavedMsg('Ayarlar kaydedildi ve zamanlayıcılar güncellendi.');
    setTimeout(() => setSavedMsg(null), 3500);
  };

  return (
    <div>
      {savedMsg && <div className="alert-banner">{savedMsg}</div>}

      <form onSubmit={handleSave} className="card" style={{ display: 'grid', gap: '14px' }}>
        <h3 className="card-title">Toplama Aralıkları, Zamanlama ve Gizlilik Ayarları</h3>

        <div className="grid-2">
          <div>
            <label style={{ fontSize: '12.5px', color: 'var(--text-secondary)' }}>
              Zoom Okuma Aralığı (saniye, min 10 sn)
            </label>
            <input
              type="number"
              min={10}
              className="input"
              value={form.zoomPollIntervalSeconds}
              onChange={(e) =>
                setForm({ ...form, zoomPollIntervalSeconds: parseInt(e.target.value, 10) || 30 })
              }
            />
          </div>

          <div>
            <label style={{ fontSize: '12.5px', color: 'var(--text-secondary)' }}>
              Git Çalışma Ağacı & Commit Tarama Aralığı (saniye, min 20 sn)
            </label>
            <input
              type="number"
              min={20}
              className="input"
              value={form.gitPollIntervalSeconds}
              onChange={(e) =>
                setForm({ ...form, gitPollIntervalSeconds: parseInt(e.target.value, 10) || 60 })
              }
            />
          </div>

          <div>
            <label style={{ fontSize: '12.5px', color: 'var(--text-secondary)' }}>
              Mesai Başlangıç Saati
            </label>
            <input
              type="time"
              className="input"
              value={form.workdayStart}
              onChange={(e) => setForm({ ...form, workdayStart: e.target.value })}
            />
          </div>

          <div>
            <label style={{ fontSize: '12.5px', color: 'var(--text-secondary)' }}>
              Mesai Bitiş ve Rapor Hatırlatma Saati
            </label>
            <input
              type="time"
              className="input"
              value={form.workdayEnd}
              onChange={(e) => setForm({ ...form, workdayEnd: e.target.value })}
            />
          </div>

          <div>
            <label style={{ fontSize: '12.5px', color: 'var(--text-secondary)' }}>Saat Dilimi</label>
            <input
              className="input"
              value={form.timezone}
              onChange={(e) => setForm({ ...form, timezone: e.target.value })}
            />
          </div>

          <div>
            <label style={{ fontSize: '12.5px', color: 'var(--text-secondary)' }}>
              Yerel Veri Saklama Süresi (Gün)
            </label>
            <input
              type="number"
              min={7}
              className="input"
              value={form.retentionDays}
              onChange={(e) =>
                setForm({ ...form, retentionDays: parseInt(e.target.value, 10) || 90 })
              }
            />
          </div>
        </div>

        <div style={{ display: 'grid', gap: '8px', marginTop: '6px' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={form.endOfDayNotification}
              onChange={(e) => setForm({ ...form, endOfDayNotification: e.target.checked })}
            />
            Mesai bitiş saatinde onaylanmamış günlük rapor için Windows bildirimi göster
          </label>

          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={form.allowRemoteAiSend}
              onChange={(e) => setForm({ ...form, allowRemoteAiSend: e.target.checked })}
            />
            Uzak AI / CLI servisine (Gemini CLI) yapılandırılmış aktivite özeti gönderimine izin ver
            (Her zaman önizleme ile)
          </label>

          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={form.autoLaunchOnStartup}
              onChange={(e) => setForm({ ...form, autoLaunchOnStartup: e.target.checked })}
            />
            Windows açılışında MesAI uygulamasını otomatik başlat
          </label>

          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={form.autoCheckUpdatesOnStartup ?? true}
              onChange={(e) => setForm({ ...form, autoCheckUpdatesOnStartup: e.target.checked })}
            />
            Uygulama açılışında arka planda yeni sürüm kontrolü yap
          </label>
        </div>

        <div>
          <button type="submit" className="btn btn-primary">
            💾 Ayarları Kaydet
          </button>
        </div>
      </form>

      {/* Sürüm Kontrolü ve Güncelleme Kartı */}
      <div className="card" style={{ border: '1px solid rgba(99, 102, 241, 0.4)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
          <div>
            <h3 className="card-title" style={{ display: 'flex', alignItems: 'center', gap: '8px', margin: 0 }}>
              <img src={MESAI_ICON_DATA_URL} alt="MesAI" style={{ width: '22px', height: '22px', objectFit: 'contain' }} />
              <span>Uygulama Sürümü ve Otomatik Güncellemeler</span>
              <span className="badge badge-neutral" style={{ fontSize: '12px', fontWeight: 600 }}>
                {updateState?.currentVersion ? `v${updateState.currentVersion}` : ''}
              </span>
            </h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: '13px', margin: '4px 0 0 0' }}>
              GitHub Releases üzerinden versiyon kontrolü, sürüm notları ve uygulama içi güncelleme.
            </p>
          </div>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleCheckUpdates}
            disabled={checkingUpdate || updateState?.status === 'checking' || updateState?.status === 'downloading'}
          >
            {checkingUpdate || updateState?.status === 'checking' ? '⏳ Denetleniyor...' : '🔄 Güncellemeleri Denetle'}
          </button>
        </div>

        {/* Durum Bilgisi */}
        {updateState?.status === 'checking' && (
          <div className="alert-banner" style={{ marginTop: '12px' }}>
            🔄 GitHub Releases üzerinden yeni sürüm denetleniyor...
          </div>
        )}

        {updateState?.status === 'not_available' && (
          <div className="alert-banner" style={{ marginTop: '12px', background: 'rgba(16, 185, 129, 0.1)', borderColor: 'var(--success)' }}>
            ✅ Uygulamanız en son sürümde (v{updateState.currentVersion}). Yeni bir güncelleme bulunmuyor.
          </div>
        )}

        {updateState?.status === 'available' && updateState.updateInfo && (
          <div
            style={{
              marginTop: '12px',
              padding: '14px',
              borderRadius: '8px',
              background: 'rgba(99, 102, 241, 0.1)',
              border: '1px solid var(--accent)',
              display: 'grid',
              gap: '10px'
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ fontWeight: 600, color: 'var(--accent)', fontSize: '15px' }}>
                🎉 Yeni Sürüm Mevcut: v{updateState.updateInfo.version}
              </div>
              {updateState.updateInfo.releaseDate && (
                <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                  Yayınlanma: {new Date(updateState.updateInfo.releaseDate).toLocaleDateString('tr-TR')}
                </div>
              )}
            </div>

            {updateState.updateInfo.releaseNotes && (
              <div style={{ background: 'var(--bg-primary)', padding: '10px', borderRadius: '6px', fontSize: '13px', maxHeight: '160px', overflowY: 'auto' }}>
                <div style={{ fontWeight: 600, marginBottom: '4px', color: 'var(--text-secondary)' }}>Sürüm Notları:</div>
                <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'inherit' }}>
                  {updateState.updateInfo.releaseNotes}
                </pre>
              </div>
            )}

            <div>
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleDownloadUpdate}
              >
                ⬇️ Güncellemeyi İndir (v{updateState.updateInfo.version})
              </button>
            </div>
          </div>
        )}

        {updateState?.status === 'downloading' && (
          <div
            style={{
              marginTop: '12px',
              padding: '14px',
              borderRadius: '8px',
              background: 'var(--bg-secondary)',
              border: '1px solid var(--accent)',
              display: 'grid',
              gap: '8px'
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px' }}>
              <span>⬇️ Yeni sürüm indiriliyor...</span>
              <span style={{ fontWeight: 600 }}>{updateState.progress?.percent ?? 0}%</span>
            </div>
            <div style={{ background: 'var(--bg-tertiary)', borderRadius: '6px', height: '10px', overflow: 'hidden' }}>
              <div
                style={{
                  width: `${updateState.progress?.percent ?? 0}%`,
                  background: 'var(--accent)',
                  height: '100%',
                  transition: 'width 0.2s'
                }}
              />
            </div>
            {updateState.progress && (
              <div style={{ fontSize: '12px', color: 'var(--text-secondary)', display: 'flex', justifyContent: 'space-between' }}>
                <span>
                  {(updateState.progress.transferredBytes / 1024 / 1024).toFixed(1)} MB / {(updateState.progress.totalBytes / 1024 / 1024).toFixed(1)} MB
                </span>
                <span>
                  {((updateState.progress.bytesPerSecond || 0) / 1024 / 1024).toFixed(1)} MB/sn
                </span>
              </div>
            )}
          </div>
        )}

        {updateState?.status === 'downloaded' && (
          <div
            style={{
              marginTop: '12px',
              padding: '14px',
              borderRadius: '8px',
              background: 'rgba(16, 185, 129, 0.1)',
              border: '1px solid var(--success)',
              display: 'grid',
              gap: '10px'
            }}
          >
            <div style={{ fontWeight: 600, color: 'var(--success)', fontSize: '15px' }}>
              🎉 Güncelleme başarıyla indirildi ve kuruluma hazır!
            </div>
            <p style={{ margin: 0, fontSize: '13px', color: 'var(--text-secondary)' }}>
              Uygulamayı yeniden başlatarak yeni sürüme geçebilirsiniz.
            </p>
            <div>
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleInstallUpdate}
              >
                ⚡ Şimdi Yeniden Başlat ve Güncelle
              </button>
            </div>
          </div>
        )}

        {updateState?.status === 'error' && (
          <div
            style={{
              marginTop: '12px',
              padding: '12px',
              borderRadius: '8px',
              background: 'rgba(239, 68, 68, 0.1)',
              border: '1px solid var(--danger)',
              fontSize: '13px'
            }}
          >
            <div style={{ fontWeight: 600, color: 'var(--danger)', marginBottom: '4px' }}>
              ⚠️ Güncelleme Denetimi Hatası
            </div>
            <div style={{ color: 'var(--text-secondary)' }}>
              {updateState.errorMessage || 'Bilinmeyen bir hata oluştu.'}
            </div>
          </div>
        )}

        <div style={{ marginTop: '10px', fontSize: '11.5px', color: 'var(--text-secondary)' }}>
          {updateState?.lastCheckedAt
            ? `Son Denetleme: ${new Date(updateState.lastCheckedAt).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`
            : 'Henüz denetleme yapılmadı.'}
        </div>
      </div>

      <div className="card">
        <h3 className="card-title">Koruyucu Dosya Filtreleri (Varsayılan Hariç Tutulanlar)</h3>
        <p style={{ color: 'var(--text-secondary)', fontSize: '13px' }}>
          Aşağıdaki klasör ve dosya kalıpları dosya izleme ve Git çalışma ağacı taramalarından
          otomatik olarak hariç tutulur:
        </p>
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
          {form.globalExclusions.map((ex) => (
            <span key={ex} className="badge badge-neutral">
              {ex}
            </span>
          ))}
          <span className="badge badge-neutral">.env*</span>
          <span className="badge badge-neutral">*.tmp / *.log / *.swp</span>
        </div>
      </div>

      <div className="card" style={{ borderColor: 'rgba(239, 68, 68, 0.4)' }}>
        <h3 className="card-title" style={{ color: '#fca5a5' }}>
          Yerel Veri Yönetimi ve Temizleme
        </h3>
        <p style={{ color: 'var(--text-secondary)', fontSize: '13px' }}>
          Toplanmış tüm aktiviteleri, kaynak kanıtlarını ve rapor taslaklarını yerel SQLite
          veritabanından kalıcı olarak silebilirsiniz.
        </p>
        {!confirmClear ? (
          <button className="btn btn-danger" onClick={() => setConfirmClear(true)}>
            🗑️ Toplanan Tüm Yerel Verileri Temizle
          </button>
        ) : (
          <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
            <span style={{ color: '#fca5a5', fontSize: '13px' }}>
              Tüm aktiviteler ve raporlar silinecek. Emin misiniz?
            </span>
            <button
              className="btn btn-danger"
              onClick={async () => {
                await onClearAllData();
                setConfirmClear(false);
                setSavedMsg('Tüm yerel aktivite ve rapor kayıtları temizlendi.');
              }}
            >
              Evet, Kalıcı Olarak Sil
            </button>
            <button className="btn" onClick={() => setConfirmClear(false)}>
              Vazgeç
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
