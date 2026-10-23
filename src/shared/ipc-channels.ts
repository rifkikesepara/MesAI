import type {
  Activity,
  ActivityCategory,
  ActivityStatus,
  AiPreviewPayload,
  AIProviderType,
  AppSettings,
  DailyReport,
  Evidence,
  IntegrationHealth,
  Project,
  SyncState,
  UpdateState,
  ReportProgressLog,
  WorkItem
} from './types';

export const IPC_CHANNELS = {
  DASHBOARD_GET: 'mesai:dashboard:get',
  ZOOM_POLL_NOW: 'mesai:zoom:pollNow',
  GIT_POLL_NOW: 'mesai:git:pollNow',
  TRACKING_SET_PAUSED: 'mesai:tracking:setPaused',
  TRACKING_STATE_CHANGED: 'mesai:tracking:stateChanged',

  PROJECTS_LIST: 'mesai:projects:list',
  PROJECTS_SCAN_ROOT: 'mesai:projects:scanRoot',
  PROJECTS_SELECT_FOLDER: 'mesai:projects:selectFolder',
  PROJECTS_UPDATE: 'mesai:projects:update',

  ACTIVITIES_LIST: 'mesai:activities:list',
  ACTIVITIES_ADD_NOTE: 'mesai:activities:addNote',
  EVIDENCE_GET: 'mesai:evidence:get',
  MATCH_UPDATE_LINK: 'mesai:match:updateLink',
  WORK_ITEMS_LIST: 'mesai:workItems:list',

  REPORT_GET: 'mesai:report:get',
  REPORT_PREVIEW_AI: 'mesai:report:previewAi',
  REPORT_GENERATE: 'mesai:report:generate',
  REPORT_UPDATE_ITEM: 'mesai:report:updateItem',
  REPORT_ADD_ITEM: 'mesai:report:addItem',
  REPORT_DELETE_ITEM: 'mesai:report:deleteItem',
  REPORT_APPROVE: 'mesai:report:approve',
  REPORT_EXPORT: 'mesai:report:export',
  REPORT_PROGRESS: 'mesai:report:progress',

  INTEGRATIONS_HEALTH: 'mesai:integrations:health',
  INTEGRATIONS_SAVE_SECRET: 'mesai:integrations:saveSecret',
  INTEGRATIONS_TEST_CONNECTION: 'mesai:integrations:testConnection',

  AI_SAVE_KEY: 'mesai:ai:saveKey',
  AI_TEST_CONNECTION: 'mesai:ai:testConnection',
  AI_FETCH_MODELS: 'mesai:ai:fetchModels',
  AI_INSTALL_CLI: 'mesai:ai:installCli',
  AI_AUTH_CLI: 'mesai:ai:authCli',

  SETTINGS_GET: 'mesai:settings:get',
  SETTINGS_UPDATE: 'mesai:settings:update',
  DATA_CLEAR_ALL: 'mesai:data:clearAll',

  UPDATER_GET_STATE: 'mesai:updater:getState',
  UPDATER_CHECK: 'mesai:updater:check',
  UPDATER_DOWNLOAD: 'mesai:updater:download',
  UPDATER_INSTALL: 'mesai:updater:install',

  WINDOW_MINIMIZE: 'mesai:window:minimize',
  WINDOW_MAXIMIZE: 'mesai:window:maximize',
  WINDOW_CLOSE: 'mesai:window:close',
  WINDOW_IS_MAXIMIZED: 'mesai:window:isMaximized',
  OPEN_EXTERNAL_URL: 'mesai:openExternalUrl'
} as const;

export interface DashboardSummary {
  trackingPaused: boolean;
  todayDate: string;
  todayActivitiesCount: number;
  todayZoomMessagesCount: number;
  todayGitActivitiesCount: number;
  activeProjectsCount: number;
  pendingMatchSuggestionsCount: number;
  recentActivities: Activity[];
  syncStates: SyncState[];
  zoomLimitationBanner: string[];
}

export interface ActivityFilter {
  date?: string;
  projectId?: string;
  sourceType?: string;
  category?: string;
  chatOrRepoName?: string;
  search?: string;
  limit?: number;
}

export interface ManualNoteInput {
  projectId: string | null;
  category: ActivityCategory;
  status: ActivityStatus;
  title: string;
  summary: string;
  jiraKey?: string;
  durationMinutes?: number | null;
}

export interface MesaiApi {
  getDashboard(): Promise<DashboardSummary>;
  pollZoomNow(): Promise<{ ok: boolean; status: string; newMessages: number; totalVisible: number; error?: string | null }>;
  pollGitNow(): Promise<{ ok: boolean; scannedProjects: number; newActivities: number; error?: string | null }>;
  setTrackingPaused(paused: boolean): Promise<AppSettings>;

  listProjects(): Promise<Project[]>;
  scanRootForProjects(rootPath: string): Promise<Project[]>;
  selectFolderDialog(): Promise<string | null>;
  updateProject(project: {
    id: string;
    enabled: boolean;
    excludedPaths: string[];
    mappedChatNames: string[];
    jiraProjectKeys: string[];
  }): Promise<Project[]>;

  listActivities(filter: ActivityFilter): Promise<Activity[]>;
  addManualNote(input: ManualNoteInput): Promise<Activity>;
  getEvidenceById(evidenceId: string): Promise<Evidence | null>;
  updateActivityLink(input: {
    linkId: string;
    userStatus: 'accepted' | 'rejected';
    projectId?: string | null;
    workItemId?: string | null;
  }): Promise<void>;
  listWorkItems(): Promise<WorkItem[]>;

  getDailyReport(reportDate: string): Promise<DailyReport | null>;
  previewAiPayload(reportDate: string, maxChars?: number, providerOverride?: AIProviderType): Promise<AiPreviewPayload>;
  generateDailyReport(input: {
    reportDate: string;
    provider: AIProviderType;
    userConfirmedRemoteSend?: boolean;
    maxChars?: number;
    promptOverride?: string;
  }): Promise<DailyReport>;
  updateReportItem(input: {
    itemId: string;
    text: string;
    category: ActivityCategory;
    itemStatus: ActivityStatus;
    projectId: string | null;
  }): Promise<DailyReport>;
  addReportItem(input: {
    reportId: string;
    text: string;
    category: ActivityCategory;
    itemStatus: ActivityStatus;
    projectId: string | null;
  }): Promise<DailyReport>;
  deleteReportItem(itemId: string): Promise<DailyReport>;
  approveReport(reportId: string, notes?: string): Promise<DailyReport>;
  onReportProgress(callback: (log: ReportProgressLog) => void): () => void;
  exportReport(input: {
    reportId: string;
    format: 'md' | 'txt' | 'csv';
  }): Promise<{ savedPath: string | null; content: string }>;

  getIntegrationsHealth(): Promise<IntegrationHealth>;
  saveIntegrationSecret(input: {
    service: 'jira' | 'gitlab' | 'jenkins';
    url: string;
    usernameOrEmail: string;
    token: string;
  }): Promise<void>;
  testIntegrationConnection(service: 'jira' | 'gitlab' | 'jenkins'): Promise<{ ok: boolean; message: string }>;

  saveAiApiKey(input: {
    provider: 'openai' | 'anthropic' | 'custom';
    apiKey?: string;
    model?: string;
    customBaseUrl?: string;
    mode?: 'auto' | 'cli' | 'api';
  }): Promise<void>;
  testAiConnection(provider: 'openai' | 'anthropic' | 'custom'): Promise<{ ok: boolean; message: string }>;
  fetchAiModels(input: {
    provider: 'openai' | 'anthropic' | 'custom';
    apiKey?: string;
    customBaseUrl?: string;
  }): Promise<{ ok: boolean; models: string[]; error?: string }>;
  installCli(provider: 'gemini' | 'openai' | 'anthropic' | 'custom'): Promise<{ ok: boolean; message: string; output?: string }>;
  authCli(provider: 'gemini' | 'openai' | 'anthropic' | 'custom'): Promise<{ ok: boolean; message: string }>;

  getSettings(): Promise<AppSettings>;
  updateSettings(partial: Partial<AppSettings>): Promise<AppSettings>;
  clearAllData(): Promise<void>;

  getUpdateState(): Promise<UpdateState>;
  checkForUpdates(): Promise<UpdateState>;
  downloadUpdate(): Promise<void>;
  quitAndInstallUpdate(): Promise<void>;
  onUpdateStateChanged(callback: (state: UpdateState) => void): () => void;

  minimizeWindow(): Promise<void>;
  maximizeWindow(): Promise<boolean>;
  closeWindow(): Promise<void>;
  isWindowMaximized(): Promise<boolean>;
  onMaximizeChanged(callback: (isMaximized: boolean) => void): () => void;
  onTrackingStateChanged(callback: (isPaused: boolean) => void): () => void;
  openExternalUrl(url: string): Promise<void>;
}

