export type ZoomReaderStatus =
  | 'ok'
  | 'zoom_not_running'
  | 'window_minimized_or_hidden'
  | 'chat_panel_not_open'
  | 'error'
  | 'timeout'
  | 'idle';

export interface ZoomCallRecordInfo {
  direction: 'incoming' | 'outgoing' | 'unknown';
  iconLabel?: string | null;
  statusText?: string | null;
}

export interface ZoomChatMessageItem {
  indexInDom: number;
  occurrenceIndexInView: number;
  fingerprint: string;
  uiaRuntimeId: string;
  persistentMessageId: string | null;
  isGroupedFollowUp: boolean;
  isThreadReply?: boolean;
  isUnreadReply?: boolean;
  dateGroup: string | null;
  visibleTimestamp: string | null;
  sender: string | null;
  senderResolved: string | null;
  isSentByMe: boolean;
  messageType: 'text' | 'call';
  text: string | null;
  links: string[];
  callRecord?: ZoomCallRecordInfo | null;
  rawAccessibleLabel: string | null;
}

export interface ZoomSnapshotComparison {
  previousCapturedAt: string;
  previousTotalCount: number;
  currentTotalCount: number;
  exactSameElementCount: number;
  probableSameMessageCount: number;
  newlyVisibleCount: number;
  newlyVisibleMessages: ZoomChatMessageItem[];
}

export interface ZoomChatSnapshot {
  schemaVersion: string;
  status: ZoomReaderStatus;
  errorMessage?: string | null;
  capturedAt: string;
  windowTitle: string;
  windowState?: 'normal' | 'minimized' | 'hidden';
  chatName: string | null;
  chatType: string | null;
  sessionId: string | null;
  limitations: string[];
  messages: ZoomChatMessageItem[];
  comparison?: ZoomSnapshotComparison | null;
}

export type SourceType =
  | 'zoom_chat'
  | 'zoom_call'
  | 'git_commit'
  | 'git_working_tree'
  | 'file_change'
  | 'jira_issue'
  | 'jenkins_build'
  | 'manual_note';

export type ActivityCategory =
  | 'development'
  | 'analysis'
  | 'technical_discussion'
  | 'meeting'
  | 'research';

export type ActivityStatus =
  | 'completed'
  | 'in_progress'
  | 'decision'
  | 'blocker'
  | 'info';

export type TimestampConfidence = 'exact' | 'resolved_relative' | 'ambiguous';

export interface Project {
  id: string;
  name: string;
  rootPath: string;
  repositoryUrl: string | null;
  enabled: boolean;
  excludedPaths: string[];
  mappedChatNames: string[];
  jiraProjectKeys: string[];
  currentBranch?: string | null;
  lastActivityAt?: string | null;
  createdAt: string;
}

export interface SourceRecord {
  id: string;
  sourceType: SourceType;
  dedupKey: string;
  externalId: string | null;
  sessionId: string | null;
  chatName: string | null;
  sender: string | null;
  senderResolved: string | null;
  rawTimestampText: string;
  resolvedTimestampIso: string | null;
  timestampConfidence: TimestampConfidence;
  timezoneOffset: string;
  messageType: string;
  textContent: string | null;
  links: string[];
  rawPayloadJson: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface Evidence {
  id: string;
  activityId: string;
  sourceRecordId: string | null;
  sourceType: SourceType;
  externalRef: string | null;
  title: string;
  snippet: string;
  rawTimestampText: string;
  resolvedTimestampIso: string | null;
  timestampConfidence: TimestampConfidence;
  sender: string | null;
  chatOrRepoName: string | null;
  links: string[];
  collectedAt: string;
  metadata: Record<string, unknown>;
}

export interface ActivityLink {
  id: string;
  activityId: string;
  workItemId: string | null;
  projectId: string | null;
  workItemJiraKey?: string | null;
  workItemTitle?: string | null;
  projectName?: string | null;
  matchReason: string;
  matchType: 'deterministic' | 'suggested';
  confidence: number;
  userStatus: 'accepted' | 'pending' | 'rejected';
  createdAt: string;
}

export interface Activity {
  id: string;
  projectId: string | null;
  projectName?: string | null;
  sourceType: SourceType;
  category: ActivityCategory;
  status: ActivityStatus;
  title: string;
  summary: string;
  chatOrRepoName: string | null;
  sender: string | null;
  rawTimestampText: string;
  occurredAtIso: string;
  timestampConfidence: TimestampConfidence;
  isTimeEstimated: boolean;
  durationMinutes: number | null;
  confidence: number;
  createdAt: string;
  evidences?: Evidence[];
  links?: ActivityLink[];
}

export interface WorkItem {
  id: string;
  projectId: string | null;
  projectName?: string | null;
  jiraKey: string | null;
  title: string;
  description: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export type ReportStatus = 'draft' | 'approved' | 'needs_reapproval';

export interface ReportItem {
  id: string;
  reportId: string;
  workItemId: string | null;
  projectId: string | null;
  projectName?: string | null;
  jiraKey?: string | null;
  category: ActivityCategory;
  itemStatus: ActivityStatus;
  text: string;
  isUserEdited: boolean;
  isInsufficientEvidence: boolean;
  insufficientReason?: string | null;
  durationNote?: string | null;
  orderIndex: number;
  evidenceIds: string[];
  evidences?: Evidence[];
  updatedAt: string;
}

export interface DailyReport {
  id: string;
  reportDate: string; // YYYY-MM-DD
  status: ReportStatus;
  providerUsed: string;
  generatedAt: string;
  approvedAt: string | null;
  notes: string | null;
  items: ReportItem[];
  jiraKeys?: string[];
  formattedSummary?: string;
  maxChars?: number;
}

export interface SyncState {
  connector: 'zoom_reader' | 'git_watcher' | 'jira' | 'jenkins' | 'ai_provider';
  status: string;
  cursor: string | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  recordsCount: number;
  metadata: Record<string, unknown>;
}

export type AIProviderType =
  | 'local_rule'
  | 'gemini_cli'
  | 'openai'
  | 'anthropic'
  | 'custom';

export interface AppSettings {
  watchRootPath: string;
  zoomPollIntervalSeconds: number;
  gitPollIntervalSeconds: number;
  trackingPaused: boolean;
  workdayStart: string; // HH:mm
  workdayEnd: string;   // HH:mm
  endOfDayNotification: boolean;
  timezone: string;
  retentionDays: number;
  aiProvider: AIProviderType;
  aiModel?: string;
  aiOpenaiModel?: string;
  aiOpenaiBaseUrl?: string;
  aiAnthropicModel?: string;
  aiCustomModel?: string;
  aiCustomBaseUrl?: string;
  allowRemoteAiSend: boolean;
  autoLaunchOnStartup: boolean;
  globalExclusions: string[];
  jiraUrl: string;
  jiraEmail: string;
  jenkinsUrl: string;
  jenkinsUsername: string;
  reportMaxChars?: number;
  autoCheckUpdatesOnStartup?: boolean;
  theme?: 'light' | 'dark' | 'system';
}

export interface AiPreviewPayload {
  reportDate: string;
  provider: AIProviderType;
  activityCount: number;
  sanitizedPromptPreview: string;
  warnings: string[];
  maxChars?: number;
}

export interface IntegrationHealth {
  zoom: {
    status: ZoomReaderStatus;
    lastSuccessAt: string | null;
    lastAttemptAt: string | null;
    lastError: string | null;
    activeChatName: string | null;
    windowState: string | null;
    recordsCount: number;
    executablePath: string;
    executableExists: boolean;
    limitations: string[];
  };
  git: {
    status: string;
    gitVersion: string | null;
    watchedProjectsCount: number;
    lastSuccessAt: string | null;
    lastError: string | null;
  };
  ai: {
    activeProvider: AIProviderType;
    localRuleAvailable: boolean;
    geminiCliInstalled: boolean;
    geminiCliVersion: string | null;
    openaiConfigured: boolean;
    openaiModel: string;
    openaiBaseUrl?: string;
    anthropicConfigured: boolean;
    anthropicModel: string;
    customConfigured: boolean;
    customModel: string;
    customBaseUrl: string;
    remoteAiAllowed: boolean;
    lastError: string | null;
  };
  jira: {
    configured: boolean;
    url: string;
    status: 'not_configured' | 'connected' | 'error' | 'untested';
    lastTestedAt: string | null;
    lastError: string | null;
  };
  jenkins: {
    configured: boolean;
    url: string;
    status: 'not_configured' | 'connected' | 'error' | 'untested';
    lastTestedAt: string | null;
    lastError: string | null;
  };
}

export type UpdateCheckStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not_available'
  | 'downloading'
  | 'downloaded'
  | 'error';

export interface UpdateInfo {
  version: string;
  releaseDate?: string;
  releaseNotes?: string;
  releaseName?: string;
  downloadUrl?: string;
}

export interface UpdateProgress {
  percent: number;
  transferredBytes: number;
  totalBytes: number;
  bytesPerSecond: number;
}

export interface UpdateState {
  status: UpdateCheckStatus;
  currentVersion: string;
  updateInfo: UpdateInfo | null;
  progress: UpdateProgress | null;
  errorMessage: string | null;
  lastCheckedAt: string | null;
}

