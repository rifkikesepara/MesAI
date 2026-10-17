import { app, dialog, ipcMain, shell, type BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import {
  IPC_CHANNELS,
  type ActivityFilter,
  type DashboardSummary,
  type ManualNoteInput
} from '../shared/ipc-channels';
import type { ActivityCategory, ActivityStatus, AIProviderType, AppSettings } from '../shared/types';
import type { MesaiRepository } from './db/repositories';
import type { ZoomReaderAdapter } from './services/zoom-adapter';
import type { GitFileWatcherService } from './services/git-file-watcher';
import type { MatcherService } from './services/matcher-service';
import type { ReportService } from './services/report-service';
import type { IntegrationsService } from './services/integrations-service';
import type { SchedulerService } from './services/scheduler-service';
import type { UpdateService } from './services/update-service';
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

export function registerIpcHandlers(deps: {
  getMainWindow: () => BrowserWindow | null;
  repo: MesaiRepository;
  zoomAdapter: ZoomReaderAdapter;
  gitWatcher: GitFileWatcherService;
  matcher: MatcherService;
  reportService: ReportService;
  integrations: IntegrationsService;
  scheduler: SchedulerService;
  updateService: UpdateService;
  onTrayUpdate?: () => void;
}): void {
  const {
    getMainWindow,
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

  ipcMain.handle(IPC_CHANNELS.DASHBOARD_GET, async (): Promise<DashboardSummary> => {
    const settings = repo.getSettings();
    const todayDate = getTodayLocalDate();
    const todayActivities = repo.listActivities({ date: todayDate });
    const recentActivities = repo.listActivities({}).slice(0, 20);
    const projects = repo.listProjects();
    const syncStates = repo.listSyncStates();

    const todayZoomMessagesCount = todayActivities.filter((a) =>
      a.sourceType.startsWith('zoom_')
    ).length;
    const todayGitActivitiesCount = todayActivities.filter(
      (a) => a.sourceType.startsWith('git_') || a.sourceType === 'file_change'
    ).length;

    const pendingMatchSuggestionsCount = recentActivities
      .flatMap((a) => a.links ?? [])
      .filter((l) => l.userStatus === 'pending').length;

    return {
      trackingPaused: settings.trackingPaused,
      todayDate,
      todayActivitiesCount: todayActivities.length,
      todayZoomMessagesCount,
      todayGitActivitiesCount,
      activeProjectsCount: projects.filter((p) => p.enabled).length,
      pendingMatchSuggestionsCount,
      recentActivities,
      syncStates,
      zoomLimitationBanner: zoomAdapter.getDefaultLimitations()
    };
  });

  ipcMain.handle(IPC_CHANNELS.ZOOM_POLL_NOW, async () => {
    const res = await zoomAdapter.pollOnce();
    onTrayUpdate?.();
    return res;
  });

  ipcMain.handle(IPC_CHANNELS.GIT_POLL_NOW, async () => {
    const res = await gitWatcher.pollAllProjectsGit();
    onTrayUpdate?.();
    return res;
  });

  ipcMain.handle(IPC_CHANNELS.TRACKING_SET_PAUSED, async (_e, paused: unknown) => {
    const isPaused = Boolean(paused);
    const updated = repo.updateSettings({ trackingPaused: isPaused });
    scheduler.startOrReload();
    onTrayUpdate?.();
    return updated;
  });

  ipcMain.handle(IPC_CHANNELS.PROJECTS_LIST, async () => {
    return repo.listProjects();
  });

  ipcMain.handle(IPC_CHANNELS.PROJECTS_SCAN_ROOT, async (_e, rootPath: unknown) => {
    const cleanPath = assertNonEmptyString(rootPath, 'ana proje klasörü');
    repo.updateSettings({ watchRootPath: cleanPath });
    return gitWatcher.discoverGitProjects(cleanPath);
  });

  ipcMain.handle(IPC_CHANNELS.PROJECTS_SELECT_FOLDER, async () => {
    const win = getMainWindow();
    const res = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory'] });
    if (res.canceled || res.filePaths.length === 0) return null;
    return res.filePaths[0];
  });

  ipcMain.handle(IPC_CHANNELS.PROJECTS_UPDATE, async (_e, payload: unknown) => {
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

  ipcMain.handle(IPC_CHANNELS.ACTIVITIES_LIST, async (_e, filter: unknown) => {
    const safeFilter: ActivityFilter =
      filter && typeof filter === 'object' ? (filter as ActivityFilter) : {};
    return repo.listActivities(safeFilter);
  });

  ipcMain.handle(IPC_CHANNELS.ACTIVITIES_ADD_NOTE, async (_e, input: unknown) => {
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

  ipcMain.handle(IPC_CHANNELS.EVIDENCE_GET, async (_e, evidenceId: unknown) => {
    const id = assertNonEmptyString(evidenceId, 'kanıt ID');
    return repo.getEvidenceById(id);
  });

  ipcMain.handle(IPC_CHANNELS.MATCH_UPDATE_LINK, async (_e, input: unknown) => {
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

  ipcMain.handle(IPC_CHANNELS.WORK_ITEMS_LIST, async () => {
    return repo.listWorkItems();
  });

  ipcMain.handle(IPC_CHANNELS.REPORT_GET, async (_e, reportDate: unknown) => {
    const date = assertDateYmd(reportDate);
    return repo.getDailyReport(date);
  });

  ipcMain.handle(
    IPC_CHANNELS.REPORT_PREVIEW_AI,
    async (_e, reportDate: unknown, maxChars: unknown, providerOverride: unknown) => {
      const date = assertDateYmd(reportDate);
      const parsedMax =
        typeof maxChars === 'number' && !Number.isNaN(maxChars) ? maxChars : undefined;
      const parsedProvider =
        typeof providerOverride === 'string' &&
        ['local_rule', 'gemini_cli', 'openai', 'anthropic', 'custom'].includes(providerOverride)
          ? (providerOverride as AIProviderType)
          : undefined;
      return reportService.previewAiPayload(date, parsedMax, parsedProvider);
    }
  );

  ipcMain.handle(IPC_CHANNELS.REPORT_GENERATE, async (_e, input: unknown) => {
    if (!input || typeof input !== 'object') {
      throw new Error('Geçersiz rapor üretim isteği.');
    }
    const obj = input as {
      reportDate: string;
      provider: AIProviderType;
      userConfirmedRemoteSend?: boolean;
      maxChars?: number;
    };
    const reportDate = assertDateYmd(obj.reportDate);
    const validProviders: AIProviderType[] = ['local_rule', 'gemini_cli', 'openai', 'anthropic', 'custom'];
    const provider: AIProviderType = validProviders.includes(obj.provider) ? obj.provider : 'local_rule';
    const maxChars =
      typeof obj.maxChars === 'number' && !Number.isNaN(obj.maxChars) ? obj.maxChars : undefined;
    return reportService.generateReport({
      reportDate,
      provider,
      userConfirmedRemoteSend: Boolean(obj.userConfirmedRemoteSend),
      maxChars
    });
  });

  ipcMain.handle(IPC_CHANNELS.REPORT_UPDATE_ITEM, async (_e, input: unknown) => {
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

  ipcMain.handle(IPC_CHANNELS.REPORT_ADD_ITEM, async (_e, input: unknown) => {
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

  ipcMain.handle(IPC_CHANNELS.REPORT_DELETE_ITEM, async (_e, itemId: unknown) => {
    return repo.deleteReportItem(assertNonEmptyString(itemId, 'madde ID'));
  });

  ipcMain.handle(IPC_CHANNELS.REPORT_APPROVE, async (_e, reportId: unknown, notes: unknown) => {
    return repo.approveReport(
      assertNonEmptyString(reportId, 'rapor ID'),
      typeof notes === 'string' ? notes : undefined
    );
  });

  ipcMain.handle(IPC_CHANNELS.REPORT_EXPORT, async (_e, input: unknown) => {
    if (!input || typeof input !== 'object') {
      throw new Error('Geçersiz dışa aktarma isteği.');
    }
    const obj = input as { reportId: string; format: 'md' | 'txt' | 'csv' };
    const fmt = obj.format === 'txt' || obj.format === 'csv' ? obj.format : 'md';
    const reportId = assertNonEmptyString(obj.reportId, 'rapor ID');

    // Look up report date from ID
    const datePart = reportId.replace(/^rep_/, '');
    const formattedDate =
      datePart.length === 8
        ? `${datePart.slice(0, 4)}-${datePart.slice(4, 6)}-${datePart.slice(6, 8)}`
        : new Date().toISOString().slice(0, 10);

    const report = repo.getDailyReport(formattedDate);
    if (!report) throw new Error('Dışa aktarılacak rapor bulunamadı.');

    const content = reportService.formatReportContent(report, fmt);
    const win = getMainWindow();
    const defaultFileName = `MesAI_Gunluk_Rapor_${report.reportDate}.${fmt}`;

    const saveRes = win
      ? await dialog.showSaveDialog(win, {
          title: 'Günlük Raporu Dışa Aktar',
          defaultPath: path.join(app.getPath('documents'), defaultFileName),
          filters: [{ name: fmt.toUpperCase(), extensions: [fmt] }]
        })
      : await dialog.showSaveDialog({
          title: 'Günlük Raporu Dışa Aktar',
          defaultPath: path.join(app.getPath('documents'), defaultFileName),
          filters: [{ name: fmt.toUpperCase(), extensions: [fmt] }]
        });

    if (saveRes.canceled || !saveRes.filePath) {
      return { savedPath: null, content };
    }

    const resolvedSavePath = path.resolve(saveRes.filePath);
    const ext = path.extname(resolvedSavePath).toLowerCase();
    if (!['.md', '.txt', '.csv'].includes(ext)) {
      throw new Error('Yalnızca .md, .txt veya .csv uzantılı dosyalara dışa aktarım yapılabilir.');
    }

    fs.writeFileSync(resolvedSavePath, content, 'utf8');
    return { savedPath: resolvedSavePath, content };
  });

  ipcMain.handle(IPC_CHANNELS.INTEGRATIONS_HEALTH, async () => {
    return integrations.getHealthSummary();
  });

  ipcMain.handle(IPC_CHANNELS.INTEGRATIONS_SAVE_SECRET, async (_e, input: unknown) => {
    if (!input || typeof input !== 'object') {
      throw new Error('Geçersiz entegrasyon verisi.');
    }
    const obj = input as {
      service: 'jira' | 'jenkins';
      url: string;
      usernameOrEmail: string;
      token: string;
    };
    if (obj.service !== 'jira' && obj.service !== 'jenkins') {
      throw new Error('Geçersiz servis adı.');
    }
    integrations.saveIntegrationCredential(obj);
  });

  ipcMain.handle(IPC_CHANNELS.INTEGRATIONS_TEST_CONNECTION, async (_e, service: unknown) => {
    if (service !== 'jira' && service !== 'jenkins') {
      throw new Error('Geçersiz servis adı.');
    }
    return integrations.testConnection(service);
  });

  ipcMain.handle(IPC_CHANNELS.AI_SAVE_KEY, async (_e, input: unknown) => {
    if (!input || typeof input !== 'object') {
      throw new Error('Geçersiz AI entegrasyon verisi.');
    }
    const obj = input as {
      provider: 'openai' | 'anthropic' | 'custom';
      apiKey?: string;
      model?: string;
      customBaseUrl?: string;
      mode?: 'auto' | 'cli' | 'api';
    };
    if (!['openai', 'anthropic', 'custom'].includes(obj.provider)) {
      throw new Error('Geçersiz AI sağlayıcısı.');
    }
    integrations.saveAiCredential(obj);
  });

  ipcMain.handle(IPC_CHANNELS.AI_TEST_CONNECTION, async (_e, provider: unknown) => {
    if (provider !== 'openai' && provider !== 'anthropic' && provider !== 'custom') {
      throw new Error('Geçersiz AI sağlayıcısı.');
    }
    return integrations.testAiConnection(provider);
  });

  ipcMain.handle(IPC_CHANNELS.AI_FETCH_MODELS, async (_e, input: unknown) => {
    if (!input || typeof input !== 'object') {
      throw new Error('Geçersiz istek.');
    }
    const obj = input as {
      provider: 'openai' | 'anthropic' | 'custom';
      apiKey?: string;
      customBaseUrl?: string;
    };
    if (!['openai', 'anthropic', 'custom'].includes(obj.provider)) {
      throw new Error('Geçersiz AI sağlayıcısı.');
    }
    return integrations.fetchAiModels(obj);
  });

  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET, async () => {
    return repo.getSettings();
  });

  ipcMain.handle(IPC_CHANNELS.SETTINGS_UPDATE, async (_e, partial: unknown) => {
    if (!partial || typeof partial !== 'object') {
      throw new Error('Geçersiz ayar verisi.');
    }
    const updated = repo.updateSettings(partial as Partial<AppSettings>);
    if (typeof (partial as Partial<AppSettings>).autoLaunchOnStartup === 'boolean') {
      try {
        app.setLoginItemSettings({
          openAtLogin: Boolean((partial as Partial<AppSettings>).autoLaunchOnStartup)
        });
      } catch {
        // ignore if unsupported in dev mode
      }
    }
    scheduler.startOrReload();
    onTrayUpdate?.();
    return updated;
  });

  ipcMain.handle(IPC_CHANNELS.DATA_CLEAR_ALL, async () => {
    repo.clearAllData();
  });

  ipcMain.handle(IPC_CHANNELS.UPDATER_GET_STATE, async () => {
    return updateService.getState();
  });

  ipcMain.handle(IPC_CHANNELS.UPDATER_CHECK, async () => {
    return updateService.checkForUpdates();
  });

  ipcMain.handle(IPC_CHANNELS.UPDATER_DOWNLOAD, async () => {
    return updateService.downloadUpdate();
  });

  ipcMain.handle(IPC_CHANNELS.UPDATER_INSTALL, async () => {
    return updateService.quitAndInstall();
  });

  ipcMain.handle(IPC_CHANNELS.WINDOW_MINIMIZE, async () => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) win.minimize();
  });

  ipcMain.handle(IPC_CHANNELS.WINDOW_MAXIMIZE, async () => {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return false;
    if (win.isMaximized()) {
      win.unmaximize();
      return false;
    } else {
      win.maximize();
      return true;
    }
  });

  ipcMain.handle(IPC_CHANNELS.WINDOW_CLOSE, async () => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) win.close();
  });

  ipcMain.handle(IPC_CHANNELS.WINDOW_IS_MAXIMIZED, async () => {
    const win = getMainWindow();
    return win && !win.isDestroyed() ? win.isMaximized() : false;
  });

  ipcMain.handle(IPC_CHANNELS.OPEN_EXTERNAL_URL, async (_event, url: unknown) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      await shell.openExternal(url);
    }
  });
}

