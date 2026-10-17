import React, { useEffect, useState } from 'react';
import type { ActivityFilter, ManualNoteInput } from '../../shared/ipc-channels';
import type {
  Activity,
  ActivityCategory,
  ActivityStatus,
  AiPreviewPayload,
  AIProviderType,
  DailyReport,
  Evidence,
  Project,
  ReportItem
} from '../../shared/types';
import { CATEGORY_LABELS, SOURCE_LABELS, STATUS_LABELS } from './DashboardAndProjectsView';
import {
  PlusIcon,
  SearchIcon,
  CheckIcon,
  CloseIcon,
  CopyIcon,
  SparklesIcon,
  RefreshIcon,
  DownloadIcon,
  TrashIcon,
  ExternalLinkIcon
} from '../components/Icons';

export const TimelineView: React.FC<{
  projects: Project[];
  onInspectEvidence: (ev: Evidence) => void;
}> = ({ projects, onInspectEvidence }) => {
  const [activities, setActivities] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<ActivityFilter>({
    date: '',
    projectId: '',
    sourceType: '',
    category: '',
    chatOrRepoName: '',
    search: ''
  });

  const [showNoteForm, setShowNoteForm] = useState(false);
  const [noteTitle, setNoteTitle] = useState('');
  const [noteSummary, setNoteSummary] = useState('');
  const [noteCategory, setNoteCategory] = useState<ActivityCategory>('meeting');
  const [noteStatus, setNoteStatus] = useState<ActivityStatus>('info');
  const [noteProjectId, setNoteProjectId] = useState<string>('');
  const [noteJiraKey, setNoteJiraKey] = useState('');

  const loadActivities = async () => {
    setLoading(true);
    try {
      const list = await window.mesaiApi.listActivities(filter);
      setActivities(list);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadActivities();
  }, [filter.date, filter.projectId, filter.sourceType, filter.category, filter.chatOrRepoName]);

  const handleAddNote = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!noteTitle.trim() || !noteSummary.trim()) return;
    const payload: ManualNoteInput = {
      projectId: noteProjectId || null,
      category: noteCategory,
      status: noteStatus,
      title: noteTitle.trim(),
      summary: noteSummary.trim(),
      jiraKey: noteJiraKey.trim() || undefined
    };
    await window.mesaiApi.addManualNote(payload);
    setNoteTitle('');
    setNoteSummary('');
    setNoteJiraKey('');
    setShowNoteForm(false);
    await loadActivities();
  };

  const handleLinkDecision = async (
    linkId: string,
    userStatus: 'accepted' | 'rejected',
    projectId?: string | null
  ) => {
    await window.mesaiApi.updateActivityLink({ linkId, userStatus, projectId });
    await loadActivities();
  };

  const uniqueChatsOrRepos = Array.from(
    new Set(activities.map((a) => a.chatOrRepoName).filter(Boolean) as string[])
  );

  return (
    <div>
      <div className="card">
        <div className="card-header">
          <h3 className="card-title">Aktivite Akışı (Timeline) & Kanıt Filtreleri</h3>
          <button
            className="btn btn-primary btn-sm"
            onClick={() => setShowNoteForm(!showNoteForm)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
          >
            {showNoteForm ? <CloseIcon size={14} /> : <PlusIcon size={14} />}
            <span>{showNoteForm ? 'Kapat' : 'Hızlı Toplantı / Teknik Not Ekle'}</span>
          </button>
        </div>

        {showNoteForm && (
          <form
            onSubmit={handleAddNote}
            style={{
              background: 'var(--bg-primary)',
              padding: '14px',
              borderRadius: '8px',
              marginBottom: '16px',
              display: 'grid',
              gap: '10px'
            }}
          >
            <div className="filter-bar" style={{ marginBottom: 0 }}>
              <input
                className="input"
                placeholder="Başlık (Örn: BAM-4066 Mimari Değerlendirme)"
                value={noteTitle}
                onChange={(e) => setNoteTitle(e.target.value)}
                required
              />
              <select
                className="select"
                value={noteCategory}
                onChange={(e) => setNoteCategory(e.target.value as ActivityCategory)}
              >
                <option value="meeting">Toplantı / Görüşme</option>
                <option value="technical_discussion">Teknik Görüşme</option>
                <option value="analysis">Analiz</option>
                <option value="research">Araştırma</option>
                <option value="development">Geliştirme</option>
              </select>
              <select
                className="select"
                value={noteStatus}
                onChange={(e) => setNoteStatus(e.target.value as ActivityStatus)}
              >
                <option value="info">Bilgi / Not</option>
                <option value="decision">Alınan Karar</option>
                <option value="in_progress">Devam Eden İş</option>
                <option value="completed">Tamamlanan İş</option>
                <option value="blocker">Engel / Risk</option>
              </select>
              <select
                className="select"
                value={noteProjectId}
                onChange={(e) => setNoteProjectId(e.target.value)}
              >
                <option value="">Proje Seçin (İsteğe Bağlı)</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <input
                className="input"
                placeholder="Jira Anahtarı (Örn: BAM-4066)"
                value={noteJiraKey}
                onChange={(e) => setNoteJiraKey(e.target.value)}
              />
            </div>
            <textarea
              className="textarea"
              placeholder="Görüşme / araştırma özeti veya alınan karar..."
              value={noteSummary}
              onChange={(e) => setNoteSummary(e.target.value)}
              required
            />
            <div>
              <button type="submit" className="btn btn-primary btn-sm">
                Notu Kaydet
              </button>
            </div>
          </form>
        )}

        <div className="filter-bar">
          <input
            type="date"
            className="input"
            value={filter.date || ''}
            onChange={(e) => setFilter({ ...filter, date: e.target.value })}
          />
          <select
            className="select"
            value={filter.projectId || ''}
            onChange={(e) => setFilter({ ...filter, projectId: e.target.value })}
          >
            <option value="">Tüm Projeler</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <select
            className="select"
            value={filter.sourceType || ''}
            onChange={(e) => setFilter({ ...filter, sourceType: e.target.value })}
          >
            <option value="">Tüm Kaynaklar</option>
            <option value="zoom_chat">Zoom Sohbet</option>
            <option value="zoom_call">Zoom Arama Kaydı</option>
            <option value="git_commit">Git Commit</option>
            <option value="git_working_tree">Git Çalışma Ağacı</option>
            <option value="file_change">Dosya Değişikliği</option>
            <option value="manual_note">Manuel Not</option>
          </select>
          <select
            className="select"
            value={filter.category || ''}
            onChange={(e) => setFilter({ ...filter, category: e.target.value })}
          >
            <option value="">Tüm Türler</option>
            <option value="development">Geliştirme</option>
            <option value="analysis">Analiz</option>
            <option value="technical_discussion">Teknik Görüşme</option>
            <option value="meeting">Toplantı / Görüşme</option>
            <option value="research">Araştırma</option>
          </select>
          <select
            className="select"
            value={filter.chatOrRepoName || ''}
            onChange={(e) => setFilter({ ...filter, chatOrRepoName: e.target.value })}
          >
            <option value="">Tüm Sohbet / Depolar</option>
            {uniqueChatsOrRepos.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <div style={{ display: 'flex', gap: '6px' }}>
            <input
              className="input"
              placeholder="Metin ara..."
              value={filter.search || ''}
              onChange={(e) => setFilter({ ...filter, search: e.target.value })}
              onKeyDown={(e) => e.key === 'Enter' && loadActivities()}
            />
            <button
              className="btn btn-sm"
              onClick={loadActivities}
              style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
            >
              <SearchIcon size={13} />
              <span>Ara</span>
            </button>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <h3 className="card-title">Kayıtlı Aktiviteler ({activities.length})</h3>
          {filter.date && (
            <button className="btn btn-sm" onClick={() => setFilter({ ...filter, date: '' })}>
              Tarih Filtresini Temizle
            </button>
          )}
        </div>

        {loading ? (
          <div style={{ padding: '16px 0', color: 'var(--text-secondary)' }}>Yükleniyor...</div>
        ) : activities.length === 0 ? (
          <div style={{ padding: '16px 0', color: 'var(--text-secondary)' }}>
            Seçilen filtrelere uygun aktivite bulunamadı.
          </div>
        ) : (
          activities.map((act) => (
            <div key={act.id} className="item-row">
              <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                  <span className="badge badge-info">
                    {SOURCE_LABELS[act.sourceType] ?? act.sourceType}
                  </span>
                  <span className="badge badge-neutral">
                    {CATEGORY_LABELS[act.category] ?? act.category}
                  </span>
                  <span
                    className={`badge ${
                      act.status === 'completed'
                        ? 'badge-success'
                        : act.status === 'blocker'
                          ? 'badge-danger'
                          : 'badge-warning'
                    }`}
                  >
                    {STATUS_LABELS[act.status] ?? act.status}
                  </span>
                  {act.projectName && (
                    <span className="badge badge-success">Proje: {act.projectName}</span>
                  )}
                  <strong>{act.title}</strong>
                </div>

                <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                  Kaynaktaki Tarih: <code>{act.rawTimestampText}</code> | Çözümlenen:{' '}
                  <code>{act.occurredAtIso.slice(0, 16).replace('T', ' ')}</code> (
                  {act.timestampConfidence === 'exact'
                    ? 'Kesin'
                    : act.timestampConfidence === 'resolved_relative'
                      ? 'Göreli Çözümlendi'
                      : 'Belirsiz'}
                  )
                </div>
              </div>

              <div className="activity-summary">
                {act.summary}
              </div>

              {/* Detected external URL links (from Zoom / Git / Jira) */}
              {(() => {
                const detectedUrls = Array.from(
                  new Set((act.evidences ?? []).flatMap((e) => e.links ?? []).filter(Boolean))
                );
                if (detectedUrls.length === 0) return null;
                return (
                  <div className="activity-links-box">
                    <div className="activity-links-header">
                      <span>🔗</span>
                      <span>Tespit Edilen Bağlantılar ({detectedUrls.length})</span>
                    </div>
                    <div className="activity-links-list">
                      {detectedUrls.map((url, uIdx) => (
                        <a
                          key={uIdx}
                          href={url}
                          target="_blank"
                          rel="noreferrer"
                          className="activity-link-item"
                          title={url}
                        >
                          <span className="activity-link-icon">
                            <ExternalLinkIcon size={12} />
                          </span>
                          <span className="activity-link-text">{url}</span>
                        </a>
                      ))}
                    </div>
                  </div>
                );
              })()}

              {/* Match links & suggestions */}
              {act.links && act.links.length > 0 && (
                <div style={{ marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  {act.links.map((lnk) => (
                    <div key={lnk.id} className="match-link-row">
                      <div className="match-link-content">
                        <span
                          className={`badge ${
                            lnk.userStatus === 'accepted'
                              ? 'badge-success'
                              : lnk.userStatus === 'rejected'
                                ? 'badge-danger'
                                : 'badge-warning'
                          }`}
                          style={{ marginRight: '8px', flexShrink: 0 }}
                        >
                          {lnk.matchType === 'deterministic' ? 'Kesin Eşleşme' : 'Öneri'} (
                          %{Math.round(lnk.confidence * 100)}) —{' '}
                          {lnk.userStatus === 'accepted'
                            ? 'Kabul Edildi'
                            : lnk.userStatus === 'rejected'
                              ? 'Ayrıldı'
                              : 'Onay Bekliyor'}
                        </span>
                        {lnk.workItemJiraKey && <strong>[{lnk.workItemJiraKey}] </strong>}
                        {lnk.projectName && <span>({lnk.projectName}) </span>}
                        <span style={{ color: 'var(--text-secondary)' }}>{lnk.matchReason}</span>
                      </div>

                      <div className="match-link-actions">
                        {lnk.userStatus !== 'accepted' && (
                          <button
                            className="btn btn-sm btn-success"
                            onClick={() => handleLinkDecision(lnk.id, 'accepted', lnk.projectId)}
                            style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                          >
                            <CheckIcon size={12} />
                            <span>Kabul Et</span>
                          </button>
                        )}
                        {lnk.userStatus !== 'rejected' && (
                          <button
                            className="btn btn-sm btn-danger"
                            onClick={() => handleLinkDecision(lnk.id, 'rejected', lnk.projectId)}
                            style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                          >
                            <CloseIcon size={12} />
                            <span>Ayır</span>
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Evidence links */}
              {act.evidences && act.evidences.length > 0 && (
                <div style={{ marginTop: '8px', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                  {act.evidences.map((ev) => (
                    <button
                      key={ev.id}
                      className="btn btn-sm"
                      onClick={() => onInspectEvidence(ev)}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                    >
                      <SearchIcon size={13} />
                      <span>Kanıtı Aç ({ev.sourceType} — {ev.rawTimestampText})</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
};

function getLocalTodayYmd(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export const DailyReportView: React.FC<{
  projects: Project[];
  onInspectEvidence: (ev: Evidence) => void;
}> = ({ projects, onInspectEvidence }) => {
  const todayStr = getLocalTodayYmd();
  const [reportDate, setReportDate] = useState(todayStr);
  const [report, setReport] = useState<DailyReport | null>(null);
  const [provider, setProvider] = useState<AIProviderType>('local_rule');
  const [maxChars, setMaxChars] = useState<number>(1000);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [statusBanner, setStatusBanner] = useState<string | null>(null);

  const [aiPreview, setAiPreview] = useState<AiPreviewPayload | null>(null);
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [editCategory, setEditCategory] = useState<ActivityCategory>('development');
  const [editStatus, setEditStatus] = useState<ActivityStatus>('completed');
  const [editProjectId, setEditProjectId] = useState<string>('');

  const [newItemText, setNewItemText] = useState('');
  const [newItemCategory, setNewItemCategory] = useState<ActivityCategory>('development');
  const [newItemStatus, setNewItemStatus] = useState<ActivityStatus>('completed');
  const [newItemProjectId, setNewItemProjectId] = useState<string>('');

  useEffect(() => {
    void window.mesaiApi.getSettings().then((s) => {
      if (s.reportMaxChars && s.reportMaxChars >= 120) {
        setMaxChars(s.reportMaxChars);
      }
      if (s.aiProvider) {
        setProvider(s.aiProvider);
      }
    });
  }, []);

  const loadReport = async (date: string) => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const r = await window.mesaiApi.getDailyReport(date);
      setReport(r);
      if (r?.maxChars && r.maxChars >= 120) {
        setMaxChars(r.maxChars);
      }
    } catch (err) {
      setErrorMsg((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadReport(reportDate);
  }, [reportDate]);

  const handleGenerateClick = async () => {
    setErrorMsg(null);
    setStatusBanner(null);
    const validMaxChars = Math.max(120, Number(maxChars) || 1000);

    if (provider !== 'local_rule') {
      const preview = await window.mesaiApi.previewAiPayload(reportDate, validMaxChars);
      setAiPreview(preview);
      return;
    }

    await executeGenerate('local_rule', false);
  };

  const executeGenerate = async (
    selectedProvider: AIProviderType,
    confirmedRemote: boolean
  ) => {
    setAiPreview(null);
    setLoading(true);
    setErrorMsg(null);
    const validMaxChars = Math.max(120, Number(maxChars) || 1000);
    try {
      const generated = await window.mesaiApi.generateDailyReport({
        reportDate,
        provider: selectedProvider,
        userConfirmedRemoteSend: confirmedRemote,
        maxChars: validMaxChars
      });
      setReport(generated);
      setStatusBanner(
        `Rapor yalnızca ${reportDate} tarihindeki aktivitelerden üretildi (${generated.providerUsed}, maks. ${validMaxChars} karakter).`
      );
    } catch (err) {
      setErrorMsg((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const startEditItem = (item: ReportItem) => {
    setEditingItemId(item.id);
    setEditText(item.text);
    setEditCategory(item.category);
    setEditStatus(item.itemStatus);
    setEditProjectId(item.projectId ?? '');
  };

  const saveEditItem = async (itemId: string) => {
    if (!editText.trim()) return;
    const updated = await window.mesaiApi.updateReportItem({
      itemId,
      text: editText.trim(),
      category: editCategory,
      itemStatus: editStatus,
      projectId: editProjectId || null
    });
    setReport(updated);
    setEditingItemId(null);
  };

  const handleDeleteItem = async (itemId: string) => {
    const updated = await window.mesaiApi.deleteReportItem(itemId);
    setReport(updated);
  };

  const handleAddItem = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!report || !newItemText.trim()) return;
    const updated = await window.mesaiApi.addReportItem({
      reportId: report.id,
      text: newItemText.trim(),
      category: newItemCategory,
      itemStatus: newItemStatus,
      projectId: newItemProjectId || null
    });
    setReport(updated);
    setNewItemText('');
  };

  const handleApprove = async () => {
    if (!report) return;
    const updated = await window.mesaiApi.approveReport(report.id);
    setReport(updated);
    setStatusBanner('Günlük çalışma raporu onaylandı.');
  };

  const formattedBulletSummary = report
    ? report.items.map((i) => `- ${i.text.replace(/^[-•*]\s*/, '').trim()}`).join('\n')
    : '';

  const extractedJiraKeys = report?.jiraKeys ?? [];
  const summaryCharCount = formattedBulletSummary.length;
  const effectiveLimit = Math.max(120, Number(maxChars) || 1000);
  const isOverCharLimit = summaryCharCount > effectiveLimit;

  const handleCopySummaryClipboard = async () => {
    if (!formattedBulletSummary) return;
    await navigator.clipboard.writeText(formattedBulletSummary);
    setStatusBanner('Sisteme yüklenecek rapor özeti panoya kopyalandı.');
  };

  const handleCopyJiraKeysClipboard = async () => {
    if (extractedJiraKeys.length === 0) return;
    await navigator.clipboard.writeText(extractedJiraKeys.join(', '));
    setStatusBanner(`Jira numaraları panoya kopyalandı: ${extractedJiraKeys.join(', ')}`);
  };

  const handleExport = async (format: 'md' | 'txt' | 'csv') => {
    if (!report) return;
    const res = await window.mesaiApi.exportReport({ reportId: report.id, format });
    if (res.savedPath) {
      setStatusBanner(`Rapor dışa aktarıldı: ${res.savedPath}`);
    }
  };

  return (
    <div>
      <div className="card">
        <div className="card-header">
          <h3 className="card-title">Türkçe Günlük Çalışma Raporu Üretimi ve Onayı</h3>
          {report && (
            <span
              className={`badge ${
                report.status === 'approved'
                  ? 'badge-success'
                  : report.status === 'needs_reapproval'
                    ? 'badge-danger'
                    : 'badge-warning'
              }`}
            >
              {report.status === 'approved'
                ? '✓ ONAYLANDI'
                : report.status === 'needs_reapproval'
                  ? '⚠️ DEĞİŞİKLİK YAPILDI — YENİDEN ONAY GEREKİYOR'
                  : 'TASLAK'}
            </span>
          )}
        </div>

        <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
          <div>
            <label style={{ fontSize: '12px', color: 'var(--text-secondary)', display: 'block' }}>
              Rapor Tarihi (Sadece Bu Tarih Alınır)
            </label>
            <input
              type="date"
              className="input"
              style={{ width: '170px' }}
              value={reportDate}
              onChange={(e) => setReportDate(e.target.value)}
            />
          </div>

          <div>
            <label style={{ fontSize: '12px', color: 'var(--text-secondary)', display: 'block' }}>
              Maks. Karakter Sınırı
            </label>
            <input
              type="number"
              className="input"
              style={{ width: '140px' }}
              min={120}
              max={10000}
              step={50}
              value={maxChars}
              onChange={(e) => setMaxChars(Number(e.target.value))}
            />
          </div>

          <div>
            <label style={{ fontSize: '12px', color: 'var(--text-secondary)', display: 'block' }}>
              Rapor Üretim Sağlayıcısı
            </label>
            <select
              className="select"
              style={{ width: '290px' }}
              value={provider}
              onChange={(e) => setProvider(e.target.value as AIProviderType)}
            >
              <option value="local_rule">Yerel Kurallı Motor (Varsayılan — %100 Çevrimdışı)</option>
              <option value="gemini_cli">Gemini CLI (Veri Önizlemeli)</option>
              <option value="openai">OpenAI / Codex (GPT-4o / GPT-4o-mini)</option>
              <option value="anthropic">Anthropic Claude (Claude 3.5)</option>
              <option value="custom">Özel / Yerel LLM (OpenAI-Uyumlu)</option>
            </select>
          </div>

          <div style={{ marginTop: '18px', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <button
              className="btn btn-primary"
              onClick={handleGenerateClick}
              disabled={loading}
              style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
            >
              {loading ? (
                'Üretiliyor...'
              ) : report ? (
                <>
                  <RefreshIcon size={14} />
                  <span>Raporu Yeniden Üret</span>
                </>
              ) : (
                <>
                  <SparklesIcon size={14} />
                  <span>Günlük Rapor Taslağı Oluştur</span>
                </>
              )}
            </button>

            {report && (
              <>
                <button
                  className="btn btn-success"
                  onClick={handleApprove}
                  disabled={report.status === 'approved'}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
                >
                  <CheckIcon size={14} />
                  <span>Raporu Onayla</span>
                </button>
                <button
                  className="btn"
                  onClick={handleCopySummaryClipboard}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
                >
                  <CopyIcon size={14} />
                  <span>Rapor Özetini Kopyala</span>
                </button>
                <button
                  className="btn"
                  onClick={() => handleExport('md')}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
                >
                  <DownloadIcon size={14} />
                  <span>Markdown (.md)</span>
                </button>
                <button
                  className="btn"
                  onClick={() => handleExport('txt')}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
                >
                  <DownloadIcon size={14} />
                  <span>Metin (.txt)</span>
                </button>
                <button
                  className="btn"
                  onClick={() => handleExport('csv')}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
                >
                  <DownloadIcon size={14} />
                  <span>Timesheet (.csv)</span>
                </button>
              </>
            )}
          </div>
        </div>

        {errorMsg && (
          <div className="alert-banner alert-warning" style={{ marginTop: '12px', marginBottom: 0 }}>
            <strong>Hata:</strong> {errorMsg}
          </div>
        )}
        {statusBanner && (
          <div className="alert-banner" style={{ marginTop: '12px', marginBottom: 0 }}>
            {statusBanner}
          </div>
        )}
      </div>

      {report && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '2fr 1fr',
            gap: '16px',
            marginBottom: '16px'
          }}
        >
          {/* Ready-to-upload formatted summary card */}
          <div className="card" style={{ marginBottom: 0 }}>
            <div className="card-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                <h3 className="card-title" style={{ margin: 0 }}>
                  Sisteme Yüklenecek Rapor Özeti ({report.reportDate})
                </h3>
                <span
                  className={`badge ${isOverCharLimit ? 'badge-danger' : 'badge-success'}`}
                >
                  Karakter: {summaryCharCount} / {effectiveLimit}
                </span>
              </div>
              <button
                className="btn btn-primary btn-sm"
                onClick={handleCopySummaryClipboard}
                disabled={!formattedBulletSummary}
                style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
              >
                <CopyIcon size={13} />
                <span>Özeti Kopyala</span>
              </button>
            </div>

            {formattedBulletSummary ? (
              <pre
                style={{
                  margin: 0,
                  padding: '12px',
                  background: 'var(--bg-primary)',
                  borderRadius: '8px',
                  border: '1px solid var(--border-color)',
                  color: '#f8fafc',
                  fontSize: '13.5px',
                  lineHeight: 1.6,
                  whiteSpace: 'pre-wrap',
                  fontFamily: 'inherit'
                }}
              >
                {formattedBulletSummary}
              </pre>
            ) : (
              <div style={{ color: 'var(--text-secondary)', fontSize: '13px' }}>
                Seçilen tarih ({report.reportDate}) için rapor özeti boş.
              </div>
            )}
          </div>

          {/* Extracted Jira Numbers card */}
          <div className="card" style={{ marginBottom: 0 }}>
            <div className="card-header">
              <h3 className="card-title" style={{ margin: 0 }}>
                Raporda Kullanılan Jira Numaraları ({extractedJiraKeys.length})
              </h3>
              <button
                className="btn btn-sm"
                onClick={handleCopyJiraKeysClipboard}
                disabled={extractedJiraKeys.length === 0}
                style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
              >
                <CopyIcon size={13} />
                <span>Jira No Kopyala</span>
              </button>
            </div>

            {extractedJiraKeys.length > 0 ? (
              <div style={{ display: 'grid', gap: '10px' }}>
                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                  {extractedJiraKeys.map((jk) => (
                    <span key={jk} className="badge badge-success" style={{ fontSize: '13px' }}>
                      {jk}
                    </span>
                  ))}
                </div>
                <input
                  className="input"
                  readOnly
                  value={extractedJiraKeys.join(', ')}
                  onFocus={(e) => e.currentTarget.select()}
                  title="Kopyalamak için tıklayın"
                />
              </div>
            ) : (
              <div style={{ color: 'var(--text-secondary)', fontSize: '13px' }}>
                Bu tarihteki ({report.reportDate}) aktivitelerde Jira numarası tespit edilmedi.
              </div>
            )}
          </div>
        </div>
      )}

      {report ? (
        <div className="card">
          <div className="card-header">
            <h3 className="card-title">
              Rapor Maddeleri Düzenleme ve Kanıt İnceleme ({report.items.length}) — Üretim:{' '}
              {report.providerUsed}
            </h3>
            {report.approvedAt && (
              <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                Son Onay: {report.approvedAt}
              </span>
            )}
          </div>

          {report.items.length === 0 ? (
            <div style={{ padding: '16px 0', color: 'var(--text-secondary)' }}>
              Bu tarih için aktivite kaydı bulunamadığından rapor maddesi oluşmadı. Aşağıdan manuel
              madde ekleyebilirsiniz.
            </div>
          ) : (
            report.items.map((item) => (
              <div key={item.id} className="item-row">
                {editingItemId === item.id ? (
                  <div
                    style={{
                      background: 'var(--bg-primary)',
                      padding: '12px',
                      borderRadius: '8px',
                      display: 'grid',
                      gap: '10px'
                    }}
                  >
                    <div className="filter-bar" style={{ marginBottom: 0 }}>
                      <select
                        className="select"
                        value={editCategory}
                        onChange={(e) => setEditCategory(e.target.value as ActivityCategory)}
                      >
                        <option value="development">Geliştirme</option>
                        <option value="analysis">Analiz</option>
                        <option value="technical_discussion">Teknik Görüşme</option>
                        <option value="meeting">Toplantı / Görüşme</option>
                        <option value="research">Araştırma</option>
                      </select>
                      <select
                        className="select"
                        value={editStatus}
                        onChange={(e) => setEditStatus(e.target.value as ActivityStatus)}
                      >
                        <option value="completed">Tamamlanan İş</option>
                        <option value="in_progress">Devam Eden İş</option>
                        <option value="decision">Alınan Karar</option>
                        <option value="blocker">Engel / Risk</option>
                        <option value="info">Bilgilendirme</option>
                      </select>
                      <select
                        className="select"
                        value={editProjectId}
                        onChange={(e) => setEditProjectId(e.target.value)}
                      >
                        <option value="">Genel / Proje Yok</option>
                        {projects.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <textarea
                      className="textarea"
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                    />
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <button
                        className="btn btn-sm btn-primary"
                        onClick={() => saveEditItem(item.id)}
                      >
                        Değişikliği Kaydet
                      </button>
                      <button className="btn btn-sm" onClick={() => setEditingItemId(null)}>
                        İptal
                      </button>
                    </div>
                  </div>
                ) : (
                  <div>
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: '8px',
                        flexWrap: 'wrap'
                      }}
                    >
                      <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
                        <span
                          className={`badge ${
                            item.itemStatus === 'completed'
                              ? 'badge-success'
                              : item.itemStatus === 'blocker'
                                ? 'badge-danger'
                                : 'badge-info'
                          }`}
                        >
                          {STATUS_LABELS[item.itemStatus] ?? item.itemStatus}
                        </span>
                        <span className="badge badge-neutral">
                          {CATEGORY_LABELS[item.category] ?? item.category}
                        </span>
                        {item.projectName && (
                          <span className="badge badge-info">{item.projectName}</span>
                        )}
                        {item.jiraKey && (
                          <span className="badge badge-success">{item.jiraKey}</span>
                        )}
                        {item.isUserEdited && (
                          <span className="badge badge-warning">✎ Kullanıcı Düzenlemesi (Korunur)</span>
                        )}
                        {item.isInsufficientEvidence && (
                          <span className="badge badge-danger">⚠️ Eksik Kanıt / Tahmini Bilgi</span>
                        )}
                      </div>

                      <div style={{ display: 'flex', gap: '6px' }}>
                        <button className="btn btn-sm" onClick={() => startEditItem(item)}>
                          ✎ Düzenle
                        </button>
                        <button
                          className="btn btn-sm btn-danger"
                          onClick={() => handleDeleteItem(item.id)}
                        >
                          Sil
                        </button>
                      </div>
                    </div>

                    <div style={{ marginTop: '8px', fontSize: '14.5px', color: '#f8fafc' }}>
                      {item.text}
                    </div>

                    {item.isInsufficientEvidence && item.insufficientReason && (
                      <div style={{ marginTop: '4px', fontSize: '12px', color: '#fbbf24' }}>
                        ⚠️ Not: {item.insufficientReason}
                      </div>
                    )}

                    {item.evidences && item.evidences.length > 0 && (
                      <div style={{ marginTop: '8px', display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                        {item.evidences.map((ev) => (
                          <button
                            key={ev.id}
                            className="btn btn-sm"
                            onClick={() => onInspectEvidence(ev)}
                          >
                            🔗 Kanıt: {SOURCE_LABELS[ev.sourceType] ?? ev.sourceType} ({ev.rawTimestampText})
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))
          )}

          {/* Add manual item to report */}
          <form
            onSubmit={handleAddItem}
            style={{
              marginTop: '18px',
              paddingTop: '16px',
              borderTop: '1px solid var(--border-color)',
              display: 'grid',
              gap: '10px'
            }}
          >
            <strong>Rapora Yeni Madde Ekle</strong>
            <div className="filter-bar" style={{ marginBottom: 0 }}>
              <select
                className="select"
                value={newItemCategory}
                onChange={(e) => setNewItemCategory(e.target.value as ActivityCategory)}
              >
                <option value="development">Geliştirme</option>
                <option value="analysis">Analiz</option>
                <option value="technical_discussion">Teknik Görüşme</option>
                <option value="meeting">Toplantı / Görüşme</option>
                <option value="research">Araştırma</option>
              </select>
              <select
                className="select"
                value={newItemStatus}
                onChange={(e) => setNewItemStatus(e.target.value as ActivityStatus)}
              >
                <option value="completed">Tamamlanan İş</option>
                <option value="in_progress">Devam Eden İş</option>
                <option value="decision">Alınan Karar</option>
                <option value="blocker">Engel / Risk</option>
                <option value="info">Bilgilendirme</option>
              </select>
              <select
                className="select"
                value={newItemProjectId}
                onChange={(e) => setNewItemProjectId(e.target.value)}
              >
                <option value="">Genel / Proje Seçin</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <input
                className="input"
                placeholder="Yeni rapor maddesi metnini yazın..."
                value={newItemText}
                onChange={(e) => setNewItemText(e.target.value)}
              />
              <button
                type="submit"
                className="btn btn-primary"
                style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
              >
                <PlusIcon size={14} />
                <span>Madde Ekle</span>
              </button>
            </div>
          </form>
        </div>
      ) : (
        <div className="card" style={{ color: 'var(--text-secondary)' }}>
          Seçilen tarih ({reportDate}) için henüz oluşturulmuş bir rapor taslağı yok. Yukarıdan{' '}
          <strong>"Günlük Rapor Taslağı Oluştur"</strong> butonuna tıklayabilirsiniz.
        </div>
      )}

      {/* AI Data Preview Modal */}
      {aiPreview && (
        <div className="modal-backdrop">
          <div className="modal-panel">
            <h3 style={{ marginTop: 0 }}>
              {provider === 'gemini_cli'
                ? 'Gemini CLI'
                : provider === 'openai'
                  ? 'OpenAI / Codex API'
                  : provider === 'anthropic'
                    ? 'Anthropic Claude API'
                    : 'Özel LLM API'}{' '}
              — Gönderilecek Veri Önizlemesi ve Onayı
            </h3>
            <div className="alert-banner alert-warning">
              {aiPreview.warnings.map((w, i) => (
                <div key={i}>• {w}</div>
              ))}
            </div>
            <p style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
              Aşağıdaki yapılandırılmış veri ({aiPreview.activityCount} aktivite özeti){' '}
              {provider === 'gemini_cli' ? 'Gemini CLI sürecine' : 'seçili AI sağlayıcısına'}{' '}
              güvenli parametre olarak iletilecektir:
            </p>
            <pre className="code-pre" style={{ maxHeight: '300px' }}>
              {aiPreview.sanitizedPromptPreview}
            </pre>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '16px' }}>
              <button className="btn" onClick={() => setAiPreview(null)}>
                İptal
              </button>
              <button
                className="btn"
                onClick={() => executeGenerate('local_rule', false)}
              >
                Yerel Kurallı Motorla Üret (Uzak Gönderim Yok)
              </button>
              <button
                className="btn btn-primary"
                onClick={() => executeGenerate(provider, true)}
              >
                Onayla ve{' '}
                {provider === 'gemini_cli'
                  ? 'Gemini CLI'
                  : provider === 'openai'
                    ? 'OpenAI'
                    : provider === 'anthropic'
                      ? 'Anthropic Claude'
                      : 'Özel AI'}{' '}
                ile Üret
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
