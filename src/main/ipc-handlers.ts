import fs from 'node:fs';
import path from 'node:path';
import {
  IPC_CHANNELS,
  type ActivityFilter,
  type ManualNoteInput
} from '../shared/ipc-channels';
import type { ActivityCategory, ActivityStatus, AIProviderType, AppSettings } from '../shared/types';
import type { HostBridge } from './host-bridge';
import type { MesaiRepository } from './db/repositories';
import type { ZoomReaderAdapter } from './services/zoom-adapter';
import type { GitFileWatcherService } from './services/git-file-watcher';
import type { MatcherService } from './services/matcher-service';
import type { ReportService } from './services/report-service';
import type { IntegrationsService } from './services/integrations-service';
import type { SchedulerService } from './services/scheduler-service';
import type { UpdateService } from './services/update-service';
import { CliInstallerService, type CliTargetProvider } from './services/cli-installer-service';
import { getTodayLocalDate } from './services/timestamp-resolver';

function assertNonEmptyString(val: unknown, fieldName: string): string {
  if (typeof val !== 'string' || !val.trim()) {
    throw new Error(`Geçersiz girdi: ${fieldName} boş olamaz.`);
  }
  return val.trim();
}

function assertDateYmd(val: unknown): string {
  const s = assertNonEmptyString(val, 'tarih');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new Error(`Geçersiz tarih formatı (YYYY-MM-DD bekleniyor): ${s}`);
  }
  return s;
}

export type RpcHandler = (...args: unknown[]) => Promise<unknown>;

export function createRpcHandlers(deps: {
  host: HostBridge;
  repo: MesaiRepository;
  zoomAdapter: ZoomReaderAdapter;
  gitWatcher: GitFileWatcherService;
  matcher: MatcherService;
  reportService: ReportService;
  integrations: IntegrationsService;
  scheduler: SchedulerService;
  updateService: UpdateService;
  onTrayUpdate?: () => void;
}): Map<string, RpcHandler> {
  const {
    host,
    repo,
    zoomAdapter,
    gitWatcher,
    matcher,
    reportService,
    integrations,
    scheduler,
    updateService,
    onTrayUpdate
  } = deps;

  const handlers = new Map<string, RpcHandler>();
  const cliInstaller = new CliInstallerService();

  handlers.set(IPC_CHANNELS.DASHBOARD_GET, async () => {
    const settings = repo.getSettings();
    const todayDate = getTodayLocalDate();
    const metrics = repo.getDashboardMetrics(todayDate);
    const recentActivities = repo.listActivities({ limit: 20 });
    const projects = repo.listProjects();
    const syncStates = repo.listSyncStates();

    const pendingMatchSuggestionsCount = recentActivities
      .flatMap((a) => a.links ?? [])
      .filter((l) => l.userStatus === 'pending').length;

    return {
      trackingPaused: settings.trackingPaused,
      todayDate,
      todayActivitiesCount: metrics.todayActivitiesCount,
      todayZoomMessagesCount: metrics.todayZoomMessagesCount,
      todayGitActivitiesCount: metrics.todayGitActivitiesCount,
      activeProjectsCount: projects.filter((p) => p.enabled).length,
      pendingMatchSuggestionsCount,
      recentActivities,
      syncStates,
      zoomLimitationBanner: zoomAdapter.getDefaultLimitations()
    };
  });

  handlers.set(IPC_CHANNELS.ZOOM_POLL_NOW, async () => {
    const res = await zoomAdapter.pollOnce();
    onTrayUpdate?.();
    return res;
  });

  handlers.set(IPC_CHANNELS.GIT_POLL_NOW, async () => {
    const res = await gitWatcher.pollAllProjectsGit();
    onTrayUpdate?.();
    return res;
  });

  handlers.set(IPC_CHANNELS.TRACKING_SET_PAUSED, async (paused: unknown) => {
    const isPaused = Boolean(paused);
    const updated = repo.updateSettings({ trackingPaused: isPaused });
    scheduler.startOrReload();
    onTrayUpdate?.();
    return updated;
  });

  handlers.set(IPC_CHANNELS.PROJECTS_LIST, async () => {
    return repo.listProjects();
  });

  handlers.set(IPC_CHANNELS.PROJECTS_SCAN_ROOT, async (rootPath: unknown) => {
    const cleanPath = assertNonEmptyString(rootPath, 'ana proje klasörü');
    repo.updateSettings({ watchRootPath: cleanPath });
    return gitWatcher.discoverGitProjects(cleanPath);
  });

  handlers.set(IPC_CHANNELS.PROJECTS_SELECT_FOLDER, async () => {
    return host.selectFolderDialog();
  });

  handlers.set(IPC_CHANNELS.PROJECTS_UPDATE, async (payload: unknown) => {
    if (!payload || typeof payload !== 'object') {
      throw new Error('Geçersiz proje güncelleme verisi.');
    }
    const obj = payload as Record<string, unknown>;
    const id = assertNonEmptyString(obj.id, 'proje ID');
    const updated = repo.updateProject({
      id,
      enabled: Boolean(obj.enabled),
      excludedPaths: Array.isArray(obj.excludedPaths) ? obj.excludedPaths.map(String) : [],
      mappedChatNames: Array.isArray(obj.mappedChatNames) ? obj.mappedChatNames.map(String) : [],
      jiraProjectKeys: Array.isArray(obj.jiraProjectKeys) ? obj.jiraProjectKeys.map(String) : []
    });
    gitWatcher.refreshFileWatchers();
    return updated;
  });

  handlers.set(IPC_CHANNELS.ACTIVITIES_LIST, async (filter: unknown) => {
    const safeFilter: ActivityFilter =
      filter && typeof filter === 'object' ? (filter as ActivityFilter) : {};
    return repo.listActivities(safeFilter);
  });

  handlers.set(IPC_CHANNELS.ACTIVITIES_ADD_NOTE, async (input: unknown) => {
    if (!input || typeof input !== 'object') {
      throw new Error('Geçersiz not verisi.');
    }
    const obj = input as ManualNoteInput;
    const title = assertNonEmptyString(obj.title, 'not başlığı');
    const summary = assertNonEmptyString(obj.summary, 'not içeriği');
    const act = repo.addManualNote({
      projectId: obj.projectId ?? null,
      category: obj.category ?? 'research',
      status: obj.status ?? 'info',
      title,
      summary,
      jiraKey: obj.jiraKey,
      durationMinutes:
        typeof obj.durationMinutes === 'number' && obj.durationMinutes > 0
          ? obj.durationMinutes
          : null
    });
    matcher.matchActivityById(act.id);
    return repo.getActivityById(act.id)!;
  });

  handlers.set(IPC_CHANNELS.ACTIVITIES_ADD_COMMENT, async (input: unknown) => {
    if (!input || typeof input !== 'object') {
      throw new Error('Geçersiz yorum verisi.');
    }
    const obj = input as { activityId?: unknown; content?: unknown };
    const activityId = assertNonEmptyString(obj.activityId, 'aktivite ID');
    const content = assertNonEmptyString(obj.content, 'yorum metni');
    const updated = repo.addActivityComment(activityId, content);
    matcher.matchActivityById(updated.id);
    return repo.getActivityById(updated.id)!;
  });

  handlers.set(IPC_CHANNELS.ACTIVITIES_UPDATE_COMMENT, async (input: unknown) => {
    if (!input || typeof input !== 'object') {
      throw new Error('Geçersiz yorum güncelleme verisi.');
    }
    const obj = input as { commentId?: unknown; content?: unknown };
    const commentId = assertNonEmptyString(obj.commentId, 'yorum ID');
    const content = assertNonEmptyString(obj.content, 'yorum metni');
    const updated = repo.updateActivityComment(commentId, content);
    matcher.matchActivityById(updated.id);
    return repo.getActivityById(updated.id)!;
  });

  handlers.set(IPC_CHANNELS.ACTIVITIES_DELETE_COMMENT, async (commentId: unknown) => {
    const id = assertNonEmptyString(commentId, 'yorum ID');
    const updated = repo.deleteActivityComment(id);
    matcher.matchActivityById(updated.id);
    return repo.getActivityById(updated.id)!;
  });

  handlers.set(IPC_CHANNELS.EVIDENCE_GET, async (evidenceId: unknown) => {
    const id = assertNonEmptyString(evidenceId, 'kanıt ID');
    return repo.getEvidenceById(id);
  });

  handlers.set(IPC_CHANNELS.MATCH_UPDATE_LINK, async (input: unknown) => {
    if (!input || typeof input !== 'object') {
      throw new Error('Geçersiz eşleştirme verisi.');
    }
    const obj = input as {
      linkId: string;
      userStatus: 'accepted' | 'rejected';
      projectId?: string | null;
      workItemId?: string | null;
    };
    const linkId = assertNonEmptyString(obj.linkId, 'link ID');
    if (obj.userStatus !== 'accepted' && obj.userStatus !== 'rejected') {
      throw new Error('Geçersiz eşleştirme durumu.');
    }
    repo.updateActivityLinkDecision({
      linkId,
      userStatus: obj.userStatus,
      projectId: obj.projectId,
      workItemId: obj.workItemId
    });
  });

  handlers.set(IPC_CHANNELS.WORK_ITEMS_LIST, async () => {
    return repo.listWorkItems();
  });

  handlers.set(IPC_CHANNELS.REPORT_GET, async (reportDate: unknown) => {
    const date = assertDateYmd(reportDate);
    return repo.getDailyReport(date);
  });

  handlers.set(
    IPC_CHANNELS.REPORT_PREVIEW_AI,
    async (
      reportDate: unknown,
      maxChars: unknown,
      providerOverride: unknown,
      modelOverride: unknown,
      fastLocal: unknown
    ) => {
      const date = assertDateYmd(reportDate);
      const parsedMax =
        typeof maxChars === 'number' && !Number.isNaN(maxChars) ? maxChars : undefined;
      const parsedProvider =
        typeof providerOverride === 'string' &&
        ['local_rule', 'gemini_cli', 'openai', 'anthropic', 'custom'].includes(providerOverride)
          ? (providerOverride as AIProviderType)
          : undefined;
      const parsedModel =
        typeof modelOverride === 'string' && modelOverride.trim() ? modelOverride.trim() : undefined;
      return reportService.previewAiPayload(date, parsedMax, parsedProvider, parsedModel, Boolean(fastLocal));
    }
  );

  handlers.set(IPC_CHANNELS.REPORT_GENERATE, async (input: unknown) => {
    if (!input || typeof input !== 'object') {
      throw new Error('Geçersiz rapor üretim isteği.');
    }
    const obj = input as {
      reportDate: string;
      provider: AIProviderType;
      model?: string;
      userConfirmedRemoteSend?: boolean;
      maxChars?: number;
      promptOverride?: string;
    };
    const reportDate = assertDateYmd(obj.reportDate);
    const validProviders: AIProviderType[] = ['local_rule', 'gemini_cli', 'openai', 'anthropic', 'custom'];
    const provider: AIProviderType = validProviders.includes(obj.provider) ? obj.provider : 'local_rule';
    const model = typeof obj.model === 'string' && obj.model.trim() ? obj.model.trim() : undefined;
    const maxChars =
      typeof obj.maxChars === 'number' && !Number.isNaN(obj.maxChars) ? obj.maxChars : undefined;
    const promptOverride =
      typeof obj.promptOverride === 'string' && obj.promptOverride.trim()
        ? obj.promptOverride.trim()
        : undefined;
    return reportService.generateReport({
      reportDate,
      provider,
      model,
      userConfirmedRemoteSend: Boolean(obj.userConfirmedRemoteSend),
      maxChars,
      promptOverride,
      onProgress: (log) => {
        host.emitEvent(IPC_CHANNELS.REPORT_PROGRESS, log);
      }
    });
  });

  handlers.set(IPC_CHANNELS.REPORT_UPDATE_ITEM, async (input: unknown) => {
    if (!input || typeof input !== 'object') {
      throw new Error('Geçersiz rapor maddesi verisi.');
    }
    const obj = input as {
      itemId: string;
      text: string;
      category: ActivityCategory;
      itemStatus: ActivityStatus;
      projectId: string | null;
    };
    return repo.updateReportItem({
      itemId: assertNonEmptyString(obj.itemId, 'madde ID'),
      text: assertNonEmptyString(obj.text, 'madde metni'),
      category: obj.category,
      itemStatus: obj.itemStatus,
      projectId: obj.projectId ?? null
    });
  });

  handlers.set(IPC_CHANNELS.REPORT_ADD_ITEM, async (input: unknown) => {
    if (!input || typeof input !== 'object') {
      throw new Error('Geçersiz yeni madde verisi.');
    }
    const obj = input as {
      reportId: string;
      text: string;
      category: ActivityCategory;
      itemStatus: ActivityStatus;
      projectId: string | null;
    };
    return repo.addReportItem({
      reportId: assertNonEmptyString(obj.reportId, 'rapor ID'),
      text: assertNonEmptyString(obj.text, 'madde metni'),
      category: obj.category,
      itemStatus: obj.itemStatus,
      projectId: obj.projectId ?? null
    });
  });

  handlers.set(IPC_CHANNELS.REPORT_DELETE_ITEM, async (itemId: unknown) => {
    return repo.deleteReportItem(assertNonEmptyString(itemId, 'madde ID'));
  });

  handlers.set(IPC_CHANNELS.REPORT_REMOVE_JIRA_KEY, async (reportDate: unknown, jiraKey: unknown) => {
    const date = assertDateYmd(reportDate);
    const key = assertNonEmptyString(jiraKey, 'Jira anahtarı');
    return repo.removeReportJiraKey(date, key);
  });

  handlers.set(IPC_CHANNELS.REPORT_RESET_JIRA_KEYS, async (reportDate: unknown) => {
    const date = assertDateYmd(reportDate);
    return repo.resetReportJiraKeys(date);
  });

  handlers.set(IPC_CHANNELS.REPORT_APPROVE, async (reportId: unknown, notes: unknown) => {
    return repo.approveReport(
      assertNonEmptyString(reportId, 'rapor ID'),
      typeof notes === 'string' ? notes : undefined
    );
  });

  handlers.set(IPC_CHANNELS.REPORT_EXPORT, async (input: unknown) => {
    if (!input || typeof input !== 'object') {
      throw new Error('Geçersiz dışa aktarma isteği.');
    }
    const obj = input as { reportId: string; format: 'md' | 'txt' | 'csv' };
    const fmt = obj.format === 'txt' || obj.format === 'csv' ? obj.format : 'md';
    const reportId = assertNonEmptyString(obj.reportId, 'rapor ID');

    const datePart = reportId.replace(/^rep_/, '');
    const formattedDate =
      datePart.length === 8
        ? `${datePart.slice(0, 4)}-${datePart.slice(4, 6)}-${datePart.slice(6, 8)}`
        : new Date().toISOString().slice(0, 10);

    const report = repo.getDailyReport(formattedDate);
    if (!report) throw new Error('Dışa aktarılacak rapor bulunamadı.');

    const content = reportService.formatReportContent(report, fmt);
    const defaultFileName = `MesAI_Gunluk_Rapor_${report.reportDate}.${fmt}`;

    const selectedPath = await host.saveFileDialog({
      title: 'Günlük Raporu Dışa Aktar',
      defaultPath: path.join(host.getDocumentsDir(), defaultFileName),
      filters: [{ name: fmt.toUpperCase(), extensions: [fmt] }]
    });

    if (!selectedPath) {
      return { savedPath: null, content };
    }

    const resolvedSavePath = path.resolve(selectedPath);
    const ext = path.extname(resolvedSavePath).toLowerCase();
    if (!['.md', '.txt', '.csv'].includes(ext)) {
      throw new Error('Yalnızca .md, .txt veya .csv uzantılı dosyalara dışa aktarım yapılabilir.');
    }

    fs.writeFileSync(resolvedSavePath, content, 'utf8');
    return { savedPath: resolvedSavePath, content };
  });

  handlers.set(IPC_CHANNELS.INTEGRATIONS_HEALTH, async () => {
    return integrations.getHealthSummary();
  });

  handlers.set(IPC_CHANNELS.INTEGRATIONS_SAVE_SECRET, async (input: unknown) => {
    if (!input || typeof input !== 'object') {
      throw new Error('Geçersiz entegrasyon verisi.');
    }
    const obj = input as {
      service: 'jira' | 'gitlab' | 'jenkins';
      url: string;
      usernameOrEmail: string;
      token: string;
    };
    if (obj.service !== 'jira' && obj.service !== 'gitlab' && obj.service !== 'jenkins') {
      throw new Error('Geçersiz servis adı.');
    }
    integrations.saveIntegrationCredential(obj);
  });

  handlers.set(IPC_CHANNELS.INTEGRATIONS_TEST_CONNECTION, async (service: unknown) => {
    if (service !== 'jira' && service !== 'gitlab' && service !== 'jenkins') {
      throw new Error('Geçersiz servis adı.');
    }
    return integrations.testConnection(service);
  });

  handlers.set(IPC_CHANNELS.GITLAB_SYNC_REVIEWS, async (days?: unknown) => {
    const parsedDays =
      typeof days === 'number' && Number.isFinite(days) ? Math.floor(days) : 30;
    return integrations.syncGitLabReviewsHistory(parsedDays);
  });

  handlers.set(IPC_CHANNELS.AI_SAVE_KEY, async (input: unknown) => {
    if (!input || typeof input !== 'object') {
      throw new Error('Geçersiz AI entegrasyon verisi.');
    }
    const obj = input as {
      provider: 'gemini_cli' | 'openai' | 'anthropic' | 'custom';
      apiKey?: string;
      model?: string;
      customBaseUrl?: string;
      mode?: 'auto' | 'cli' | 'api';
    };
    if (!['gemini_cli', 'openai', 'anthropic', 'custom'].includes(obj.provider)) {
      throw new Error('Geçersiz AI sağlayıcısı.');
    }
    integrations.saveAiCredential(obj);
  });

  handlers.set(IPC_CHANNELS.AI_TEST_CONNECTION, async (provider: unknown) => {
    if (provider !== 'openai' && provider !== 'anthropic' && provider !== 'custom') {
      throw new Error('Geçersiz AI sağlayıcısı.');
    }
    return integrations.testAiConnection(provider);
  });

  handlers.set(IPC_CHANNELS.AI_FETCH_MODELS, async (input: unknown) => {
    if (!input || typeof input !== 'object') {
      throw new Error('Geçersiz istek.');
    }
    const obj = input as {
      provider: 'gemini_cli' | 'openai' | 'anthropic' | 'custom';
      apiKey?: string;
      customBaseUrl?: string;
    };
    if (!['gemini_cli', 'openai', 'anthropic', 'custom'].includes(obj.provider)) {
      throw new Error('Geçersiz AI sağlayıcısı.');
    }
    return integrations.fetchAiModels(obj);
  });

  handlers.set(IPC_CHANNELS.AI_INSTALL_CLI, async (provider: unknown) => {
    if (!['gemini', 'openai', 'anthropic', 'custom'].includes(provider as string)) {
      throw new Error('Geçersiz AI sağlayıcısı.');
    }
    return cliInstaller.installCli(provider as CliTargetProvider);
  });

  handlers.set(IPC_CHANNELS.AI_AUTH_CLI, async (provider: unknown) => {
    if (!['gemini', 'openai', 'anthropic', 'custom'].includes(provider as string)) {
      throw new Error('Geçersiz AI sağlayıcısı.');
    }
    return cliInstaller.launchCliAuth(provider as CliTargetProvider);
  });

  handlers.set(IPC_CHANNELS.SETTINGS_GET, async () => {
    return repo.getSettings();
  });

  handlers.set(IPC_CHANNELS.SETTINGS_UPDATE, async (partial: unknown) => {
    if (!partial || typeof partial !== 'object') {
      throw new Error('Geçersiz ayar verisi.');
    }
    const updated = repo.updateSettings(partial as Partial<AppSettings>);
    if (typeof (partial as Partial<AppSettings>).autoLaunchOnStartup === 'boolean') {
      await host.setAutoLaunch(Boolean((partial as Partial<AppSettings>).autoLaunchOnStartup));
    }
    scheduler.startOrReload();
    onTrayUpdate?.();
    return updated;
  });

  handlers.set(IPC_CHANNELS.DATA_CLEAR_ALL, async () => {
    repo.clearAllData();
    gitWatcher.clearCaches();
    zoomAdapter.clearCaches();
  });

  handlers.set(IPC_CHANNELS.UPDATER_GET_STATE, async () => {
    return updateService.getState();
  });

  handlers.set(IPC_CHANNELS.UPDATER_CHECK, async () => {
    return updateService.checkForUpdates();
  });

  handlers.set(IPC_CHANNELS.UPDATER_DOWNLOAD, async () => {
    return updateService.downloadUpdate();
  });

  handlers.set(IPC_CHANNELS.UPDATER_INSTALL, async () => {
    return updateService.quitAndInstall();
  });

  handlers.set(IPC_CHANNELS.OPEN_EXTERNAL_URL, async (url: unknown) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      await host.openExternalUrl(url);
    }
  });

  return handlers;
}
