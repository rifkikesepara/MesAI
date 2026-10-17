import crypto from 'node:crypto';
import type { MesaiDatabase } from './database';
import type {
  Activity,
  ActivityCategory,
  ActivityLink,
  ActivityStatus,
  AppSettings,
  DailyReport,
  Evidence,
  Project,
  ReportItem,
  SourceType,
  SyncState,
  TimestampConfidence,
  WorkItem,
  ZoomChatSnapshot
} from '../../shared/types';
import type { ActivityFilter, ManualNoteInput } from '../../shared/ipc-channels';
import {
  extractTimezoneOffset,
  resolveZoomTimestamp,
  toLocalIsoString
} from '../services/timestamp-resolver';

export const DEFAULT_SETTINGS: AppSettings = {
  watchRootPath: 'C:\\Repos',
  zoomPollIntervalSeconds: 30,
  gitPollIntervalSeconds: 60,
  trackingPaused: false,
  workdayStart: '09:00',
  workdayEnd: '18:00',
  endOfDayNotification: true,
  timezone: 'Europe/Istanbul (+03:00)',
  retentionDays: 90,
  aiProvider: 'local_rule',
  aiModel: 'gpt-4o-mini',
  aiOpenaiModel: 'gpt-4o-mini',
  aiOpenaiBaseUrl: '',
  aiOpenaiMode: 'auto',
  aiAnthropicModel: 'claude-3-5-sonnet-20241022',
  aiAnthropicMode: 'auto',
  aiCustomModel: '',
  aiCustomBaseUrl: '',
  aiCustomMode: 'auto',
  allowRemoteAiSend: false,
  autoLaunchOnStartup: false,
  globalExclusions: [
    'node_modules',
    '.git',
    'target',
    'dist',
    'dist-main',
    'dist-renderer',
    'dist-electron',
    'build',
    'bin',
    'obj',
    '.next',
    '.turbo',
    '.cache',
    '.vs',
    '.idea'
  ],
  jiraUrl: '',
  jiraEmail: '',
  jenkinsUrl: '',
  jenkinsUsername: '',
  reportMaxChars: 1000,
  autoCheckUpdatesOnStartup: true,
  theme: 'system'
};

const IGNORED_JIRA_LIKE_TOKENS = new Set([
  'UTF-8',
  'UTF-16',
  'SHA-1',
  'SHA-256',
  'SHA-512',
  'ISO-8601',
  'WIN-32',
  'X86-64',
  'NET-10',
  'AES-256',
  'RSA-2048'
]);

export function extractJiraKeysFromText(text: string | null | undefined): string[] {
  if (!text) return [];
  const matches = text.match(/\b([A-Z][A-Z0-9]{1,9}-\d{1,6})\b/g);
  if (!matches) return [];
  return matches.filter((m) => !IGNORED_JIRA_LIKE_TOKENS.has(m));
}

export function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

export class MesaiRepository {
  constructor(private readonly database: MesaiDatabase) {
    this.repairMisdatedActivities();
  }

  private get db() {
    return this.database.db;
  }

  // ==================== SETTINGS ====================
  public getSettings(): AppSettings {
    const rows = this.db.prepare('SELECT key, value_json FROM settings').all() as Array<{
      key: string;
      value_json: string;
    }>;
    const merged: Record<string, unknown> = { ...DEFAULT_SETTINGS };
    for (const row of rows) {
      try {
        merged[row.key] = JSON.parse(row.value_json);
      } catch {
        // ignore malformed setting
      }
    }
    return merged as unknown as AppSettings;
  }

  public updateSettings(partial: Partial<AppSettings>): AppSettings {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO settings (key, value_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `);
    for (const [k, v] of Object.entries(partial)) {
      if (v !== undefined) {
        stmt.run(k, JSON.stringify(v), now);
      }
    }
    return this.getSettings();
  }

  // ==================== SYNC STATE ====================
  public updateSyncState(input: {
    connector: SyncState['connector'];
    status: string;
    cursor?: string | null;
    lastAttemptAt?: string | null;
    lastSuccessAt?: string | null;
    lastError?: string | null;
    recordsCount?: number;
    metadata?: Record<string, unknown>;
  }): void {
    const existing = this.getSyncState(input.connector);
    const now = new Date().toISOString();
    const lastAttemptAt = input.lastAttemptAt !== undefined ? input.lastAttemptAt : now;
    const lastSuccessAt =
      input.lastSuccessAt !== undefined ? input.lastSuccessAt : existing?.lastSuccessAt ?? null;
    const lastError = input.lastError !== undefined ? input.lastError : existing?.lastError ?? null;
    const cursor = input.cursor !== undefined ? input.cursor : existing?.cursor ?? null;
    const recordsCount = input.recordsCount !== undefined ? input.recordsCount : existing?.recordsCount ?? 0;
    const metadata = input.metadata !== undefined ? input.metadata : existing?.metadata ?? {};

    this.db
      .prepare(`
        INSERT INTO sync_state (connector, status, cursor, last_attempt_at, last_success_at, last_error, records_count, metadata_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(connector) DO UPDATE SET
          status = excluded.status,
          cursor = excluded.cursor,
          last_attempt_at = excluded.last_attempt_at,
          last_success_at = excluded.last_success_at,
          last_error = excluded.last_error,
          records_count = excluded.records_count,
          metadata_json = excluded.metadata_json
      `)
      .run(
        input.connector,
        input.status,
        cursor,
        lastAttemptAt,
        lastSuccessAt,
        lastError,
        recordsCount,
        JSON.stringify(metadata)
      );
  }

  public getSyncState(connector: SyncState['connector']): SyncState | null {
    const row = this.db
      .prepare('SELECT * FROM sync_state WHERE connector = ?')
      .get(connector) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapSyncStateRow(row);
  }

  public listSyncStates(): SyncState[] {
    const rows = this.db.prepare('SELECT * FROM sync_state ORDER BY connector ASC').all() as Array<
      Record<string, unknown>
    >;
    return rows.map((r) => this.mapSyncStateRow(r));
  }

  private mapSyncStateRow(row: Record<string, unknown>): SyncState {
    let metadata: Record<string, unknown> = {};
    try {
      metadata = JSON.parse(String(row.metadata_json || '{}'));
    } catch {
      metadata = {};
    }
    return {
      connector: row.connector as SyncState['connector'],
      status: String(row.status),
      cursor: row.cursor ? String(row.cursor) : null,
      lastAttemptAt: row.last_attempt_at ? String(row.last_attempt_at) : null,
      lastSuccessAt: row.last_success_at ? String(row.last_success_at) : null,
      lastError: row.last_error ? String(row.last_error) : null,
      recordsCount: Number(row.records_count ?? 0),
      metadata
    };
  }

  // ==================== PROJECTS ====================
  public upsertDiscoveredProject(input: {
    name: string;
    rootPath: string;
    repositoryUrl?: string | null;
    currentBranch?: string | null;
    defaultJiraKeys?: string[];
  }): Project {
    const existing = this.db
      .prepare('SELECT * FROM projects WHERE root_path = ?')
      .get(input.rootPath) as Record<string, unknown> | undefined;

    if (existing) {
      this.db
        .prepare(`
          UPDATE projects
          SET repository_url = COALESCE(?, repository_url),
              current_branch = COALESCE(?, current_branch)
          WHERE id = ?
        `)
        .run(input.repositoryUrl ?? null, input.currentBranch ?? null, String(existing.id));
      return this.getProjectById(String(existing.id))!;
    }

    const id = `proj_${sha256Hex(input.rootPath.toLowerCase()).slice(0, 12)}`;
    const now = new Date().toISOString();
    const jiraKeys = input.defaultJiraKeys ?? [];
    const defaultEnabled = input.name.toLowerCase() === 'libv8' ? 0 : 1;
    this.db
      .prepare(`
        INSERT INTO projects (
          id, name, root_path, repository_url, enabled,
          excluded_paths_json, mapped_chat_names_json, jira_project_keys_json,
          current_branch, created_at
        ) VALUES (?, ?, ?, ?, ?, '[]', '[]', ?, ?, ?)
      `)
      .run(
        id,
        input.name,
        input.rootPath,
        input.repositoryUrl ?? null,
        defaultEnabled,
        JSON.stringify(jiraKeys),
        input.currentBranch ?? null,
        now
      );
    return this.getProjectById(id)!;
  }

  public getProjectById(id: string): Project | null {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.mapProjectRow(row) : null;
  }

  public listProjects(): Project[] {
    const rows = this.db.prepare('SELECT * FROM projects ORDER BY name ASC').all() as Array<
      Record<string, unknown>
    >;
    return rows.map((r) => this.mapProjectRow(r));
  }

  public updateProject(input: {
    id: string;
    enabled: boolean;
    excludedPaths: string[];
    mappedChatNames: string[];
    jiraProjectKeys: string[];
  }): Project[] {
    this.db
      .prepare(`
        UPDATE projects
        SET enabled = ?,
            excluded_paths_json = ?,
            mapped_chat_names_json = ?,
            jira_project_keys_json = ?
        WHERE id = ?
      `)
      .run(
        input.enabled ? 1 : 0,
        JSON.stringify(input.excludedPaths),
        JSON.stringify(input.mappedChatNames),
        JSON.stringify(input.jiraProjectKeys),
        input.id
      );
    return this.listProjects();
  }

  private mapProjectRow(row: Record<string, unknown>): Project {
    return {
      id: String(row.id),
      name: String(row.name),
      rootPath: String(row.root_path),
      repositoryUrl: row.repository_url ? String(row.repository_url) : null,
      enabled: Number(row.enabled) === 1,
      excludedPaths: JSON.parse(String(row.excluded_paths_json || '[]')),
      mappedChatNames: JSON.parse(String(row.mapped_chat_names_json || '[]')),
      jiraProjectKeys: JSON.parse(String(row.jira_project_keys_json || '[]')),
      currentBranch: row.current_branch ? String(row.current_branch) : null,
      lastActivityAt: row.last_activity_at ? String(row.last_activity_at) : null,
      createdAt: String(row.created_at)
    };
  }

  // ==================== ZOOM SNAPSHOT INGESTION & DEDUPLICATION ====================
  /**
   * Ingests a ZoomChatSnapshot without duplicating previously seen messages,
   * while preserving distinct messages that happen to have identical text sent multiple times
   * (via occurrenceIndexInView and visibleTimestamp).
   */
  public ingestZoomSnapshot(snapshot: ZoomChatSnapshot): {
    newMessagesCount: number;
    updatedMessagesCount: number;
    newActivityIds: string[];
  } {
    if (snapshot.status !== 'ok' || !Array.isArray(snapshot.messages)) {
      return { newMessagesCount: 0, updatedMessagesCount: 0, newActivityIds: [] };
    }

    let newMessagesCount = 0;
    let updatedMessagesCount = 0;
    const newActivityIds: string[] = [];

    const checkExistingStmt = this.db.prepare(
      'SELECT id FROM source_records WHERE dedup_key = ?'
    );
    const updateSeenStmt = this.db.prepare(
      'UPDATE source_records SET last_seen_at = ? WHERE id = ?'
    );
    const insertSourceStmt = this.db.prepare(`
      INSERT INTO source_records (
        id, source_type, dedup_key, external_id, session_id, chat_name,
        sender, sender_resolved, raw_timestamp_text, resolved_timestamp_iso,
        timestamp_confidence, timezone_offset, message_type, text_content,
        links_json, raw_payload_json, first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertActivityStmt = this.db.prepare(`
      INSERT INTO activities (
        id, project_id, source_type, category, status, title, summary,
        chat_or_repo_name, sender, raw_timestamp_text, occurred_at_iso,
        timestamp_confidence, is_time_estimated, duration_minutes, confidence, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertEvidenceStmt = this.db.prepare(`
      INSERT INTO evidences (
        id, activity_id, source_record_id, source_type, external_ref,
        title, snippet, raw_timestamp_text, resolved_timestamp_iso,
        timestamp_confidence, sender, chat_or_repo_name, links_json,
        collected_at, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const msg of snapshot.messages) {
      // Skip empty non-call messages
      const textBody = (msg.text ?? '').trim();
      const isCall = msg.messageType === 'call' || Boolean(msg.callRecord);
      if (!isCall && !textBody && (!msg.links || msg.links.length === 0)) {
        continue;
      }

      const resolvedTs = resolveZoomTimestamp(
        msg.dateGroup,
        msg.visibleTimestamp,
        snapshot.capturedAt
      );

      const dateAnchor = resolvedTs.resolvedDate ?? (msg.dateGroup || 'unknown-date');
      const senderKey = (msg.senderResolved || msg.sender || 'unknown-sender').trim();
      const contentSignature = sha256Hex(
        `${msg.messageType}|${textBody}|${msg.callRecord?.statusText ?? ''}|${(msg.links ?? []).join(',')}`
      ).slice(0, 16);

      const dedupKey = msg.persistentMessageId
        ? `zoom:pid:${msg.persistentMessageId}`
        : `zoom:${snapshot.sessionId || snapshot.chatName || 'chat'}:${dateAnchor}:${msg.visibleTimestamp || 'notime'}:${senderKey}:${contentSignature}:occ${msg.occurrenceIndexInView || 1}`;

      const existing = checkExistingStmt.get(dedupKey) as { id: string } | undefined;
      if (existing) {
        updateSeenStmt.run(snapshot.capturedAt, existing.id);
        updatedMessagesCount++;
        continue;
      }

      const sourceRecordId = `sr_${sha256Hex(dedupKey).slice(0, 16)}`;
      const sourceType: SourceType = isCall ? 'zoom_call' : 'zoom_chat';
      const occurredAtIso = resolvedTs.resolvedTimestampIso ?? '';

      insertSourceStmt.run(
        sourceRecordId,
        sourceType,
        dedupKey,
        msg.persistentMessageId ?? msg.uiaRuntimeId ?? null,
        snapshot.sessionId ?? null,
        snapshot.chatName ?? null,
        msg.sender ?? null,
        msg.senderResolved ?? null,
        resolvedTs.rawTimestampText,
        resolvedTs.resolvedTimestampIso,
        resolvedTs.confidence,
        resolvedTs.timezoneOffset,
        msg.messageType,
        isCall ? (msg.callRecord?.statusText ?? 'Call') : textBody,
        JSON.stringify(msg.links ?? []),
        JSON.stringify(msg),
        snapshot.capturedAt,
        snapshot.capturedAt
      );

      const activityId = `act_${sha256Hex(dedupKey).slice(0, 16)}`;
      const evidenceId = `ev_${sha256Hex(dedupKey).slice(0, 16)}`;
      const displaySender = msg.senderResolved || msg.sender || 'Bilinmeyen Gönderen';
      const chatLabel = snapshot.chatName || 'Zoom Sohbet';

      let category: ActivityCategory = 'technical_discussion';
      let status: ActivityStatus = 'info';
      let title = '';
      let summary = '';

      if (isCall) {
        category = 'meeting';
        const dirLabel =
          msg.callRecord?.direction === 'incoming'
            ? 'Gelen Arama'
            : msg.callRecord?.direction === 'outgoing'
              ? 'Giden Arama'
              : 'Arama Kaydı';
        title = `Zoom ${dirLabel} — ${chatLabel}`;
        summary = `${msg.callRecord?.statusText || 'Arama kaydı'} (${displaySender}). Not: Arama kaydından görüşme içeriği veya süre türetilmemiştir.`;
      } else {
        const lower = textBody.toLowerCase();
        if (lower.includes('analiz') || lower.includes('incele') || lower.includes('review')) {
          category = 'analysis';
        } else if (lower.includes('araştır') || lower.includes('poc') || lower.includes('test et')) {
          category = 'research';
        }
        if (lower.includes('karar') || lower.includes('onay') || lower.includes('uygundur')) {
          status = 'decision';
        } else if (lower.includes('engel') || lower.includes('hata') || lower.includes('sıkıntı') || lower.includes('sorun')) {
          status = 'blocker';
        }
        title = `${chatLabel} — ${displaySender}`;
        summary = textBody;
      }

      insertActivityStmt.run(
        activityId,
        null,
        sourceType,
        category,
        status,
        title,
        summary,
        chatLabel,
        displaySender,
        resolvedTs.rawTimestampText,
        occurredAtIso,
        resolvedTs.confidence,
        0,
        null, // Never fabricate duration from chat or call logs
        resolvedTs.confidence === 'ambiguous' ? 0.65 : 0.9,
        snapshot.capturedAt
      );

      insertEvidenceStmt.run(
        evidenceId,
        activityId,
        sourceRecordId,
        sourceType,
        msg.persistentMessageId ?? msg.fingerprint,
        title,
        summary,
        resolvedTs.rawTimestampText,
        resolvedTs.resolvedTimestampIso,
        resolvedTs.confidence,
        displaySender,
        chatLabel,
        JSON.stringify(msg.links ?? []),
        snapshot.capturedAt,
        JSON.stringify({
          uiaRuntimeId: msg.uiaRuntimeId,
          occurrenceIndexInView: msg.occurrenceIndexInView,
          isGroupedFollowUp: msg.isGroupedFollowUp,
          isThreadReply: msg.isThreadReply ?? false,
          isUnreadReply: msg.isUnreadReply ?? false,
          callRecord: msg.callRecord ?? null,
          sessionId: snapshot.sessionId
        })
      );

      newMessagesCount++;
      newActivityIds.push(activityId);
    }

    return { newMessagesCount, updatedMessagesCount, newActivityIds };
  }

  // ==================== GIT & FILE INGESTION ====================
  /**
   * Records a Git commit or uncommitted file/working-tree change.
   * BR-01: Uncommitted file changes are ALWAYS recorded as 'in_progress' and never 'completed' or given fabricated duration.
   */
  public ingestGitOrFileActivity(input: {
    projectId: string;
    projectName: string;
    sourceType: 'git_commit' | 'git_working_tree' | 'file_change' | 'jira_issue' | 'jenkins_build';
    dedupKey: string;
    externalId?: string | null;
    branchName?: string | null;
    sender?: string | null;
    occurredAtIso: string;
    rawTimestampText: string;
    title: string;
    summary: string;
    changedFiles?: string[];
    codeDiff?: string | null;
    links?: string[];
    statusOverride?: ActivityStatus;
    categoryOverride?: ActivityCategory;
  }): { created: boolean; activityId: string } {
    const existing = this.db
      .prepare('SELECT id, raw_payload_json FROM source_records WHERE dedup_key = ?')
      .get(input.dedupKey) as { id: string; raw_payload_json?: string } | undefined;

    const now = new Date().toISOString();
    if (existing) {
      if ((input.changedFiles && input.changedFiles.length > 0) || input.codeDiff) {
        let prevMeta: Record<string, unknown> = {};
        try {
          prevMeta = JSON.parse(existing.raw_payload_json || '{}');
        } catch {
          prevMeta = {};
        }
        const metaJson = JSON.stringify({
          ...prevMeta,
          changedFiles:
            input.changedFiles && input.changedFiles.length > 0
              ? input.changedFiles
              : prevMeta.changedFiles ?? [],
          branchName: input.branchName ?? prevMeta.branchName ?? null,
          codeDiff: input.codeDiff ?? prevMeta.codeDiff ?? null
        });
        this.db
          .prepare('UPDATE source_records SET last_seen_at = ?, raw_payload_json = ? WHERE id = ?')
          .run(now, metaJson, existing.id);
        this.db
          .prepare('UPDATE evidences SET metadata_json = ? WHERE source_record_id = ?')
          .run(metaJson, existing.id);
      } else {
        this.db
          .prepare('UPDATE source_records SET last_seen_at = ? WHERE id = ?')
          .run(now, existing.id);
      }
      const actRow = this.db
        .prepare('SELECT activity_id FROM evidences WHERE source_record_id = ? LIMIT 1')
        .get(existing.id) as { activity_id: string } | undefined;
      return { created: false, activityId: actRow?.activity_id ?? '' };
    }

    const sourceRecordId = `sr_${sha256Hex(input.dedupKey).slice(0, 16)}`;
    const activityId = `act_${sha256Hex(input.dedupKey).slice(0, 16)}`;
    const evidenceId = `ev_${sha256Hex(input.dedupKey).slice(0, 16)}`;
    const tz = extractTimezoneOffset(input.occurredAtIso);

    // Enforce BR-01: file_change and git_working_tree are NEVER 'completed'
    const status: ActivityStatus =
      input.sourceType === 'file_change' || input.sourceType === 'git_working_tree'
        ? 'in_progress'
        : input.statusOverride ?? 'completed';

    const category: ActivityCategory = input.categoryOverride ?? 'development';

    const payloadMetaJson = JSON.stringify({
      changedFiles: input.changedFiles ?? [],
      branchName: input.branchName ?? null,
      codeDiff: input.codeDiff ?? null
    });

    this.db
      .prepare(`
        INSERT INTO source_records (
          id, source_type, dedup_key, external_id, session_id, chat_name,
          sender, sender_resolved, raw_timestamp_text, resolved_timestamp_iso,
          timestamp_confidence, timezone_offset, message_type, text_content,
          links_json, raw_payload_json, first_seen_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'exact', ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        sourceRecordId,
        input.sourceType,
        input.dedupKey,
        input.externalId ?? null,
        input.branchName ?? null,
        input.projectName,
        input.sender ?? null,
        input.sender ?? null,
        input.rawTimestampText,
        input.occurredAtIso,
        tz,
        input.sourceType,
        input.summary,
        JSON.stringify(input.links ?? []),
        payloadMetaJson,
        now,
        now
      );

    this.db
      .prepare(`
        INSERT INTO activities (
          id, project_id, source_type, category, status, title, summary,
          chat_or_repo_name, sender, raw_timestamp_text, occurred_at_iso,
          timestamp_confidence, is_time_estimated, duration_minutes, confidence, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'exact', 0, NULL, 1.0, ?)
      `)
      .run(
        activityId,
        input.projectId,
        input.sourceType,
        category,
        status,
        input.title,
        input.summary,
        input.projectName,
        input.sender ?? null,
        input.rawTimestampText,
        input.occurredAtIso,
        now
      );

    this.db
      .prepare(`
        INSERT INTO evidences (
          id, activity_id, source_record_id, source_type, external_ref,
          title, snippet, raw_timestamp_text, resolved_timestamp_iso,
          timestamp_confidence, sender, chat_or_repo_name, links_json,
          collected_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'exact', ?, ?, ?, ?, ?)
      `)
      .run(
        evidenceId,
        activityId,
        sourceRecordId,
        input.sourceType,
        input.externalId ?? null,
        input.title,
        input.summary,
        input.rawTimestampText,
        input.occurredAtIso,
        input.sender ?? null,
        input.projectName,
        JSON.stringify(input.links ?? []),
        now,
        payloadMetaJson
      );

    this.db
      .prepare('UPDATE projects SET last_activity_at = ? WHERE id = ?')
      .run(input.occurredAtIso, input.projectId);

    return { created: true, activityId };
  }

  // ==================== MANUAL NOTE ====================
  public addManualNote(input: ManualNoteInput): Activity {
    const now = toLocalIsoString(new Date());
    const idSeed = `${now}|${input.title}|${input.summary}`;
    const activityId = `act_note_${sha256Hex(idSeed).slice(0, 12)}`;
    const evidenceId = `ev_note_${sha256Hex(idSeed).slice(0, 12)}`;
    const proj = input.projectId ? this.getProjectById(input.projectId) : null;

    this.db
      .prepare(`
        INSERT INTO activities (
          id, project_id, source_type, category, status, title, summary,
          chat_or_repo_name, sender, raw_timestamp_text, occurred_at_iso,
          timestamp_confidence, is_time_estimated, duration_minutes, confidence, created_at
        ) VALUES (?, ?, 'manual_note', ?, ?, ?, ?, ?, 'Kullanıcı Notu', ?, ?, 'exact', ?, ?, 1.0, ?)
      `)
      .run(
        activityId,
        input.projectId ?? null,
        input.category,
        input.status,
        input.title.trim(),
        input.summary.trim(),
        proj?.name ?? 'Manuel Not',
        now.slice(11, 16),
        now,
        input.durationMinutes ? 1 : 0,
        input.durationMinutes ?? null,
        now
      );

    this.db
      .prepare(`
        INSERT INTO evidences (
          id, activity_id, source_record_id, source_type, external_ref,
          title, snippet, raw_timestamp_text, resolved_timestamp_iso,
          timestamp_confidence, sender, chat_or_repo_name, links_json,
          collected_at, metadata_json
        ) VALUES (?, ?, NULL, 'manual_note', ?, ?, ?, ?, ?, 'exact', 'Kullanıcı', ?, '[]', ?, '{}')
      `)
      .run(
        evidenceId,
        activityId,
        input.jiraKey?.trim() || null,
        input.title.trim(),
        input.summary.trim(),
        now.slice(11, 16),
        now,
        proj?.name ?? 'Manuel Not',
        now
      );

    return this.getActivityById(activityId)!;
  }

  // ==================== ACTIVITIES & EVIDENCES QUERIES ====================
  public getActivityById(activityId: string): Activity | null {
    const row = this.db
      .prepare(`
        SELECT a.*, p.name AS project_name
        FROM activities a
        LEFT JOIN projects p ON p.id = a.project_id
        WHERE a.id = ?
      `)
      .get(activityId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const act = this.mapActivityRow(row);
    act.evidences = this.getEvidencesForActivity(act.id);
    act.links = this.getLinksForActivity(act.id);
    return act;
  }

  public listActivities(filter: ActivityFilter = {}): Activity[] {
    const conditions: string[] = [];
    const params: Array<string | number> = [];

    if (filter.date) {
      conditions.push('length(a.occurred_at_iso) >= 10 AND substr(a.occurred_at_iso, 1, 10) = ?');
      params.push(filter.date);
    }
    if (filter.projectId) {
      conditions.push('a.project_id = ?');
      params.push(filter.projectId);
    }
    if (filter.sourceType) {
      conditions.push('a.source_type = ?');
      params.push(filter.sourceType);
    }
    if (filter.category) {
      conditions.push('a.category = ?');
      params.push(filter.category);
    }
    if (filter.chatOrRepoName) {
      conditions.push('a.chat_or_repo_name = ?');
      params.push(filter.chatOrRepoName);
    }
    if (filter.search && filter.search.trim()) {
      conditions.push('(a.title LIKE ? OR a.summary LIKE ? OR a.chat_or_repo_name LIKE ?)');
      const q = `%${filter.search.trim()}%`;
      params.push(q, q, q);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`
        SELECT a.*, p.name AS project_name
        FROM activities a
        LEFT JOIN projects p ON p.id = a.project_id
        ${whereClause}
        ORDER BY a.occurred_at_iso DESC
        LIMIT 500
      `)
      .all(...params) as Array<Record<string, unknown>>;

    return rows.map((row) => {
      const act = this.mapActivityRow(row);
      act.evidences = this.getEvidencesForActivity(act.id);
      act.links = this.getLinksForActivity(act.id);
      return act;
    });
  }

  public getEvidencesForActivity(activityId: string): Evidence[] {
    const rows = this.db
      .prepare('SELECT * FROM evidences WHERE activity_id = ? ORDER BY collected_at ASC')
      .all(activityId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapEvidenceRow(r));
  }

  public getEvidenceById(evidenceId: string): Evidence | null {
    const row = this.db.prepare('SELECT * FROM evidences WHERE id = ?').get(evidenceId) as
      | Record<string, unknown>
      | undefined;
    return row ? this.mapEvidenceRow(row) : null;
  }

  public getEvidencesByIds(evidenceIds: string[]): Evidence[] {
    if (evidenceIds.length === 0) return [];
    const placeholders = evidenceIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT * FROM evidences WHERE id IN (${placeholders})`)
      .all(...evidenceIds) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapEvidenceRow(r));
  }

  private mapActivityRow(row: Record<string, unknown>): Activity {
    return {
      id: String(row.id),
      projectId: row.project_id ? String(row.project_id) : null,
      projectName: row.project_name ? String(row.project_name) : null,
      sourceType: row.source_type as SourceType,
      category: row.category as ActivityCategory,
      status: row.status as ActivityStatus,
      title: String(row.title),
      summary: String(row.summary),
      chatOrRepoName: row.chat_or_repo_name ? String(row.chat_or_repo_name) : null,
      sender: row.sender ? String(row.sender) : null,
      rawTimestampText: String(row.raw_timestamp_text),
      occurredAtIso: String(row.occurred_at_iso),
      timestampConfidence: (row.timestamp_confidence as TimestampConfidence) || 'exact',
      isTimeEstimated: Number(row.is_time_estimated) === 1,
      durationMinutes: row.duration_minutes !== null && row.duration_minutes !== undefined ? Number(row.duration_minutes) : null,
      confidence: Number(row.confidence ?? 1.0),
      createdAt: String(row.created_at)
    };
  }

  private mapEvidenceRow(row: Record<string, unknown>): Evidence {
    let links: string[] = [];
    let metadata: Record<string, unknown> = {};
    try {
      links = JSON.parse(String(row.links_json || '[]'));
    } catch {
      links = [];
    }
    try {
      metadata = JSON.parse(String(row.metadata_json || '{}'));
    } catch {
      metadata = {};
    }
    return {
      id: String(row.id),
      activityId: String(row.activity_id),
      sourceRecordId: row.source_record_id ? String(row.source_record_id) : null,
      sourceType: row.source_type as SourceType,
      externalRef: row.external_ref ? String(row.external_ref) : null,
      title: String(row.title),
      snippet: String(row.snippet),
      rawTimestampText: String(row.raw_timestamp_text),
      resolvedTimestampIso: row.resolved_timestamp_iso ? String(row.resolved_timestamp_iso) : null,
      timestampConfidence: (row.timestamp_confidence as TimestampConfidence) || 'exact',
      sender: row.sender ? String(row.sender) : null,
      chatOrRepoName: row.chat_or_repo_name ? String(row.chat_or_repo_name) : null,
      links,
      collectedAt: String(row.collected_at),
      metadata
    };
  }

  // ==================== WORK ITEMS & ACTIVITY LINKS ====================
  public upsertWorkItem(input: {
    jiraKey: string | null;
    projectId: string | null;
    title: string;
    description?: string | null;
    status?: string;
  }): WorkItem {
    const now = new Date().toISOString();
    if (input.jiraKey) {
      const existing = this.db
        .prepare('SELECT * FROM work_items WHERE jira_key = ?')
        .get(input.jiraKey) as Record<string, unknown> | undefined;
      if (existing) {
        const existingTitle = String(existing.title || '');
        const incomingTitle = input.title?.trim() || '';
        const isGenericIncoming =
          !incomingTitle || incomingTitle === 'Otomatik tespit edilen iş anahtarı';
        const nextTitle = isGenericIncoming && existingTitle ? existingTitle : incomingTitle || existingTitle;

        this.db
          .prepare(`
            UPDATE work_items
            SET project_id = COALESCE(?, project_id),
                title = ?,
                description = COALESCE(?, description),
                status = COALESCE(?, status),
                updated_at = ?
            WHERE id = ?
          `)
          .run(
            input.projectId,
            nextTitle,
            input.description ?? null,
            input.status ?? null,
            now,
            String(existing.id)
          );
        return this.getWorkItemById(String(existing.id))!;
      }
    }

    const idSeed = input.jiraKey || `${input.projectId}|${input.title}`;
    const id = `wi_${sha256Hex(idSeed).slice(0, 12)}`;
    const existingById = this.getWorkItemById(id);
    if (existingById) return existingById;

    this.db
      .prepare(`
        INSERT INTO work_items (id, project_id, jira_key, title, description, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        input.projectId,
        input.jiraKey,
        input.title,
        input.description ?? null,
        input.status ?? 'open',
        now,
        now
      );
    return this.getWorkItemById(id)!;
  }

  /**
   * Builds a rich context map for each Jira key by combining stored Jira issue title/description
   * with cross-date commit messages and Zoom discussions referencing that Jira key.
   */
  public getJiraContextMap(jiraKeys: string[]): Record<string, string> {
    const result: Record<string, string> = {};
    const uniqueKeys = Array.from(new Set(jiraKeys.map((k) => k.trim().toUpperCase()).filter(Boolean)));
    if (uniqueKeys.length === 0) return result;

    for (const key of uniqueKeys) {
      const parts: string[] = [];
      const wi = this.db
        .prepare('SELECT title, description, status FROM work_items WHERE jira_key = ?')
        .get(key) as { title?: string; description?: string | null; status?: string } | undefined;

      if (wi?.title && wi.title !== 'Otomatik tespit edilen iş anahtarı') {
        parts.push(`Başlık: ${wi.title}`);
      }
      if (wi?.description) {
        parts.push(`Jira Açıklaması: ${wi.description.slice(0, 500)}`);
      }

      const relatedActs = this.db
        .prepare(`
          SELECT DISTINCT a.source_type, a.title, a.summary, a.occurred_at_iso
          FROM activities a
          LEFT JOIN activity_links l ON l.activity_id = a.id
          LEFT JOIN work_items w ON w.id = l.work_item_id
          WHERE w.jira_key = ?
             OR a.title LIKE ?
             OR a.summary LIKE ?
          ORDER BY a.occurred_at_iso DESC
          LIMIT 10
        `)
        .all(key, `%${key}%`, `%${key}%`) as Array<{
        source_type: string;
        title: string;
        summary: string;
        occurred_at_iso: string;
      }>;

      const commitSubjects: string[] = [];
      const chatContexts: string[] = [];
      for (const ra of relatedActs) {
        if (ra.source_type === 'git_commit') {
          const s = ra.summary.trim();
          if (s && !/^merge\s+/i.test(s) && !commitSubjects.includes(s)) {
            commitSubjects.push(s);
          }
        } else if (ra.source_type === 'zoom_chat') {
          const s = ra.summary.trim();
          if (s && s.length > 10 && !chatContexts.includes(s)) {
            chatContexts.push(s.slice(0, 220));
          }
        }
      }

      if (commitSubjects.length > 0) {
        parts.push(`İlgili Commit Notları: ${commitSubjects.slice(0, 4).join(' | ')}`);
      }
      if (chatContexts.length > 0) {
        parts.push(`İlgili Teknik Yazışma Bağlamı: ${chatContexts.slice(0, 3).join(' | ')}`);
      }

      if (parts.length > 0) {
        result[key] = parts.join(' — ');
      }
    }

    return result;
  }

  public getWorkItemById(id: string): WorkItem | null {
    const row = this.db
      .prepare(`
        SELECT w.*, p.name AS project_name
        FROM work_items w
        LEFT JOIN projects p ON p.id = w.project_id
        WHERE w.id = ?
      `)
      .get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      projectId: row.project_id ? String(row.project_id) : null,
      projectName: row.project_name ? String(row.project_name) : null,
      jiraKey: row.jira_key ? String(row.jira_key) : null,
      title: String(row.title),
      description: row.description ? String(row.description) : null,
      status: String(row.status),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    };
  }

  public listWorkItems(): WorkItem[] {
    const rows = this.db
      .prepare(`
        SELECT w.*, p.name AS project_name
        FROM work_items w
        LEFT JOIN projects p ON p.id = w.project_id
        ORDER BY w.updated_at DESC
      `)
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      projectId: row.project_id ? String(row.project_id) : null,
      projectName: row.project_name ? String(row.project_name) : null,
      jiraKey: row.jira_key ? String(row.jira_key) : null,
      title: String(row.title),
      description: row.description ? String(row.description) : null,
      status: String(row.status),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    }));
  }

  public upsertActivityLink(input: {
    activityId: string;
    workItemId: string | null;
    projectId: string | null;
    matchReason: string;
    matchType: 'deterministic' | 'suggested';
    confidence: number;
    userStatus: 'accepted' | 'pending' | 'rejected';
  }): ActivityLink {
    const idSeed = `${input.activityId}|${input.workItemId ?? ''}|${input.projectId ?? ''}`;
    const id = `link_${sha256Hex(idSeed).slice(0, 14)}`;
    const existing = this.db
      .prepare('SELECT * FROM activity_links WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;

    if (!existing) {
      this.db
        .prepare(`
          INSERT INTO activity_links (
            id, activity_id, work_item_id, project_id,
            match_reason, match_type, confidence, user_status, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          id,
          input.activityId,
          input.workItemId,
          input.projectId,
          input.matchReason,
          input.matchType,
          input.confidence,
          input.userStatus,
          new Date().toISOString()
        );
    }

    if (input.userStatus === 'accepted' && input.projectId) {
      this.db
        .prepare('UPDATE activities SET project_id = COALESCE(project_id, ?) WHERE id = ?')
        .run(input.projectId, input.activityId);
    }

    return this.getLinksForActivity(input.activityId).find((l) => l.id === id)!;
  }

  public getLinksForActivity(activityId: string): ActivityLink[] {
    const rows = this.db
      .prepare(`
        SELECT l.*, w.jira_key AS work_item_jira_key, w.title AS work_item_title, p.name AS project_name
        FROM activity_links l
        LEFT JOIN work_items w ON w.id = l.work_item_id
        LEFT JOIN projects p ON p.id = l.project_id
        WHERE l.activity_id = ?
        ORDER BY l.confidence DESC
      `)
      .all(activityId) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: String(row.id),
      activityId: String(row.activity_id),
      workItemId: row.work_item_id ? String(row.work_item_id) : null,
      projectId: row.project_id ? String(row.project_id) : null,
      workItemJiraKey: row.work_item_jira_key ? String(row.work_item_jira_key) : null,
      workItemTitle: row.work_item_title ? String(row.work_item_title) : null,
      projectName: row.project_name ? String(row.project_name) : null,
      matchReason: String(row.match_reason),
      matchType: row.match_type as 'deterministic' | 'suggested',
      confidence: Number(row.confidence),
      userStatus: row.user_status as 'accepted' | 'pending' | 'rejected',
      createdAt: String(row.created_at)
    }));
  }

  public updateActivityLinkDecision(input: {
    linkId: string;
    userStatus: 'accepted' | 'rejected';
    projectId?: string | null;
    workItemId?: string | null;
  }): void {
    const row = this.db
      .prepare('SELECT * FROM activity_links WHERE id = ?')
      .get(input.linkId) as Record<string, unknown> | undefined;
    if (!row) return;

    const finalProjectId = input.projectId !== undefined ? input.projectId : (row.project_id as string | null);
    const finalWorkItemId = input.workItemId !== undefined ? input.workItemId : (row.work_item_id as string | null);

    this.db
      .prepare(`
        UPDATE activity_links
        SET user_status = ?, project_id = ?, work_item_id = ?
        WHERE id = ?
      `)
      .run(input.userStatus, finalProjectId, finalWorkItemId, input.linkId);

    if (input.userStatus === 'accepted') {
      this.db
        .prepare('UPDATE activities SET project_id = ? WHERE id = ?')
        .run(finalProjectId, String(row.activity_id));
    } else if (input.userStatus === 'rejected') {
      this.db
        .prepare('UPDATE activities SET project_id = NULL WHERE id = ? AND project_id = ?')
        .run(String(row.activity_id), String(row.project_id ?? ''));
    }
  }

  // ==================== DAILY REPORTS ====================
  public extractJiraKeysForDate(reportDate: string, items: ReportItem[] = []): string[] {
    const keys = new Set<string>();
    const reportProjectIds = new Set<string>();

    for (const item of items) {
      if (item.projectId) reportProjectIds.add(item.projectId);
      if (item.jiraKey) {
        for (const k of extractJiraKeysFromText(item.jiraKey)) keys.add(k);
      }
      for (const k of extractJiraKeysFromText(item.text)) keys.add(k);
      for (const ev of item.evidences ?? []) {
        for (const k of extractJiraKeysFromText(ev.externalRef)) keys.add(k);
        for (const k of extractJiraKeysFromText(ev.title)) keys.add(k);
        for (const k of extractJiraKeysFromText(ev.snippet)) keys.add(k);
        for (const linkUrl of ev.links ?? []) {
          for (const k of extractJiraKeysFromText(linkUrl)) keys.add(k);
        }
      }
    }

    const dayActivities = this.listActivities({ date: reportDate });
    for (const act of dayActivities) {
      // Skip background git_working_tree / file_change activities if their project isn't in the report
      if (
        (act.sourceType === 'git_working_tree' || act.sourceType === 'file_change') &&
        items.length > 0 &&
        act.projectId &&
        !reportProjectIds.has(act.projectId)
      ) {
        continue;
      }

      // Skip Jira keys mentioned only by other teammates in shared Zoom channels unless linked to a report project
      if (act.sourceType === 'zoom_chat' && items.length > 0) {
        const lowerSender = (act.sender ?? '').toLowerCase();
        const isSentByCurrentUser =
          lowerSender === 'you' ||
          lowerSender.includes('rifki') ||
          lowerSender.includes('rıfkı') ||
          lowerSender.includes('kesepara');
        const isLinkedToReportProj =
          (act.projectId && reportProjectIds.has(act.projectId)) ||
          (act.links ?? []).some(
            (l) => l.userStatus === 'accepted' && l.projectId && reportProjectIds.has(l.projectId)
          );
        if (!isSentByCurrentUser && !isLinkedToReportProj) {
          continue;
        }
      }

      for (const k of extractJiraKeysFromText(act.title)) keys.add(k);
      for (const k of extractJiraKeysFromText(act.summary)) keys.add(k);
      for (const lnk of act.links ?? []) {
        if (lnk.userStatus !== 'rejected' && lnk.workItemJiraKey) {
          for (const k of extractJiraKeysFromText(lnk.workItemJiraKey)) keys.add(k);
        }
      }
      for (const ev of act.evidences ?? []) {
        for (const k of extractJiraKeysFromText(ev.externalRef)) keys.add(k);
        for (const k of extractJiraKeysFromText(ev.title)) keys.add(k);
        for (const k of extractJiraKeysFromText(ev.snippet)) keys.add(k);
        for (const linkUrl of ev.links ?? []) {
          for (const k of extractJiraKeysFromText(linkUrl)) keys.add(k);
        }
      }
    }

    return Array.from(keys).sort();
  }

  public getDailyReport(reportDate: string): DailyReport | null {
    const row = this.db
      .prepare('SELECT * FROM daily_reports WHERE report_date = ?')
      .get(reportDate) as Record<string, unknown> | undefined;
    if (!row) return null;

    const reportId = String(row.id);
    const itemRows = this.db
      .prepare(`
        SELECT ri.*, p.name AS project_name, w.jira_key AS jira_key
        FROM report_items ri
        LEFT JOIN projects p ON p.id = ri.project_id
        LEFT JOIN work_items w ON w.id = ri.work_item_id
        WHERE ri.report_id = ?
        ORDER BY ri.order_index ASC, ri.updated_at ASC
      `)
      .all(reportId) as Array<Record<string, unknown>>;

    const items: ReportItem[] = itemRows.map((ir) => {
      const evidenceIds: string[] = JSON.parse(String(ir.evidence_ids_json || '[]'));
      return {
        id: String(ir.id),
        reportId,
        workItemId: ir.work_item_id ? String(ir.work_item_id) : null,
        projectId: ir.project_id ? String(ir.project_id) : null,
        projectName: ir.project_name ? String(ir.project_name) : null,
        jiraKey: ir.jira_key ? String(ir.jira_key) : null,
        category: ir.category as ActivityCategory,
        itemStatus: ir.item_status as ActivityStatus,
        text: String(ir.text),
        isUserEdited: Number(ir.is_user_edited) === 1,
        isInsufficientEvidence: Number(ir.is_insufficient_evidence) === 1,
        insufficientReason: ir.insufficient_reason ? String(ir.insufficient_reason) : null,
        durationNote: ir.duration_note ? String(ir.duration_note) : null,
        orderIndex: Number(ir.order_index ?? 0),
        evidenceIds,
        evidences: this.getEvidencesByIds(evidenceIds),
        updatedAt: String(ir.updated_at)
      };
    });

    const jiraKeys = this.extractJiraKeysForDate(reportDate, items);
    const formattedSummary = items
      .map((i) => `- ${i.text.replace(/^[-•*]\s*/, '').trim()}`)
      .join('\n');
    const settings = this.getSettings();

    return {
      id: reportId,
      reportDate: String(row.report_date),
      status: row.status as DailyReport['status'],
      providerUsed: String(row.provider_used),
      generatedAt: String(row.generated_at),
      approvedAt: row.approved_at ? String(row.approved_at) : null,
      notes: row.notes ? String(row.notes) : null,
      items,
      jiraKeys,
      formattedSummary,
      maxChars: settings.reportMaxChars ?? 1000
    };
  }

  /**
   * Saves generated report items while strictly preserving any existing user-edited items
   * (is_user_edited = 1). If the report was previously 'approved', regenerating marks it 'needs_reapproval'.
   */
  public saveGeneratedReport(input: {
    reportDate: string;
    providerUsed: string;
    generatedItems: Array<{
      workItemId: string | null;
      projectId: string | null;
      category: ActivityCategory;
      itemStatus: ActivityStatus;
      text: string;
      isInsufficientEvidence: boolean;
      insufficientReason?: string | null;
      durationNote?: string | null;
      evidenceIds: string[];
    }>;
  }): DailyReport {
    const now = toLocalIsoString(new Date());
    const existing = this.getDailyReport(input.reportDate);
    const reportId = existing?.id ?? `rep_${input.reportDate.replace(/-/g, '')}`;

    const newStatus: DailyReport['status'] =
      existing?.status === 'approved' ? 'needs_reapproval' : existing?.status ?? 'draft';

    this.db.exec('BEGIN;');
    try {
      if (!existing) {
        this.db
          .prepare(`
            INSERT INTO daily_reports (id, report_date, status, provider_used, generated_at, approved_at, notes)
            VALUES (?, ?, 'draft', ?, ?, NULL, NULL)
          `)
          .run(reportId, input.reportDate, input.providerUsed, now);
      } else {
        this.db
          .prepare(`
            UPDATE daily_reports
            SET status = ?, provider_used = ?, generated_at = ?
            WHERE id = ?
          `)
          .run(newStatus, input.providerUsed, now, reportId);
      }

      // Preserve user-edited items! Delete only non-user-edited items.
      const userEditedItems = existing?.items.filter((i) => i.isUserEdited) ?? [];
      const coveredEvidenceIds = new Set<string>();
      for (const uItem of userEditedItems) {
        for (const eid of uItem.evidenceIds) {
          coveredEvidenceIds.add(eid);
        }
      }

      this.db
        .prepare('DELETE FROM report_items WHERE report_id = ? AND is_user_edited = 0')
        .run(reportId);

      let orderIdx = userEditedItems.length;
      const insertItemStmt = this.db.prepare(`
        INSERT INTO report_items (
          id, report_id, work_item_id, project_id, category, item_status,
          text, is_user_edited, is_insufficient_evidence, insufficient_reason,
          duration_note, order_index, evidence_ids_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)
      `);

      for (const gen of input.generatedItems) {
        // If all evidences of this generated item are already covered by a user-edited item, skip duplicating it
        const hasUncoveredEvidence =
          gen.evidenceIds.length === 0 || gen.evidenceIds.some((eid) => !coveredEvidenceIds.has(eid));
        if (!hasUncoveredEvidence && userEditedItems.length > 0) {
          continue;
        }

        orderIdx++;
        const cleanText = gen.text.replace(/^[-•*]\s*/, '').trim();
        const itemId = `ri_${sha256Hex(`${reportId}|${orderIdx}|${cleanText}|${now}`).slice(0, 14)}`;
        insertItemStmt.run(
          itemId,
          reportId,
          gen.workItemId,
          gen.projectId,
          gen.category,
          gen.itemStatus,
          cleanText,
          gen.isInsufficientEvidence ? 1 : 0,
          gen.insufficientReason ?? null,
          gen.durationNote ?? null,
          orderIdx,
          JSON.stringify(gen.evidenceIds),
          now
        );
      }

      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }

    return this.getDailyReport(input.reportDate)!;
  }

  public updateReportItem(input: {
    itemId: string;
    text: string;
    category: ActivityCategory;
    itemStatus: ActivityStatus;
    projectId: string | null;
  }): DailyReport {
    const row = this.db
      .prepare('SELECT report_id FROM report_items WHERE id = ?')
      .get(input.itemId) as { report_id: string } | undefined;
    if (!row) throw new Error('Rapor maddesi bulunamadı.');

    const now = toLocalIsoString(new Date());
    const cleanText = input.text.replace(/^[-•*]\s*/, '').trim();
    this.db
      .prepare(`
        UPDATE report_items
        SET text = ?, category = ?, item_status = ?, project_id = ?, is_user_edited = 1, updated_at = ?
        WHERE id = ?
      `)
      .run(cleanText, input.category, input.itemStatus, input.projectId, now, input.itemId);

    this.markReportNeedsReapprovalIfApproved(row.report_id);
    const repRow = this.db
      .prepare('SELECT report_date FROM daily_reports WHERE id = ?')
      .get(row.report_id) as { report_date: string };
    return this.getDailyReport(repRow.report_date)!;
  }

  public addReportItem(input: {
    reportId: string;
    text: string;
    category: ActivityCategory;
    itemStatus: ActivityStatus;
    projectId: string | null;
  }): DailyReport {
    const repRow = this.db
      .prepare('SELECT report_date FROM daily_reports WHERE id = ?')
      .get(input.reportId) as { report_date: string } | undefined;
    if (!repRow) throw new Error('Rapor bulunamadı.');

    const maxOrder = this.db
      .prepare('SELECT COALESCE(MAX(order_index), 0) AS m FROM report_items WHERE report_id = ?')
      .get(input.reportId) as { m: number };

    const now = toLocalIsoString(new Date());
    const cleanText = input.text.replace(/^[-•*]\s*/, '').trim();
    const itemId = `ri_manual_${sha256Hex(`${input.reportId}|${now}|${cleanText}`).slice(0, 12)}`;
    this.db
      .prepare(`
        INSERT INTO report_items (
          id, report_id, work_item_id, project_id, category, item_status,
          text, is_user_edited, is_insufficient_evidence, insufficient_reason,
          duration_note, order_index, evidence_ids_json, updated_at
        ) VALUES (?, ?, NULL, ?, ?, ?, ?, 1, 0, NULL, NULL, ?, '[]', ?)
      `)
      .run(
        itemId,
        input.reportId,
        input.projectId,
        input.category,
        input.itemStatus,
        cleanText,
        maxOrder.m + 1,
        now
      );

    this.markReportNeedsReapprovalIfApproved(input.reportId);
    return this.getDailyReport(repRow.report_date)!;
  }

  public deleteReportItem(itemId: string): DailyReport {
    const row = this.db
      .prepare('SELECT report_id FROM report_items WHERE id = ?')
      .get(itemId) as { report_id: string } | undefined;
    if (!row) throw new Error('Rapor maddesi bulunamadı.');

    this.db.prepare('DELETE FROM report_items WHERE id = ?').run(itemId);
    this.markReportNeedsReapprovalIfApproved(row.report_id);

    const repRow = this.db
      .prepare('SELECT report_date FROM daily_reports WHERE id = ?')
      .get(row.report_id) as { report_date: string };
    return this.getDailyReport(repRow.report_date)!;
  }

  public approveReport(reportId: string, notes?: string): DailyReport {
    const now = toLocalIsoString(new Date());
    this.db
      .prepare(`
        UPDATE daily_reports
        SET status = 'approved', approved_at = ?, notes = COALESCE(?, notes)
        WHERE id = ?
      `)
      .run(now, notes ?? null, reportId);

    const repRow = this.db
      .prepare('SELECT report_date FROM daily_reports WHERE id = ?')
      .get(reportId) as { report_date: string };
    return this.getDailyReport(repRow.report_date)!;
  }

  private markReportNeedsReapprovalIfApproved(reportId: string): void {
    this.db
      .prepare(`
        UPDATE daily_reports
        SET status = 'needs_reapproval'
        WHERE id = ? AND status = 'approved'
      `)
      .run(reportId);
  }

  /**
   * Repairs previously collected activities whose relative/month-day timestamps (e.g. "Sep 1, 09:50", "Oct 6, 15:09")
   * were earlier stamped with capturedAt, and removes false-positive directory file_change / UTC git_working_tree rows.
   */
  public repairMisdatedActivities(): void {
    try {
      // 1. Re-resolve Zoom timestamps using updated month-day & relative parser
      const zoomSources = this.db
        .prepare(`
          SELECT id, raw_payload_json, first_seen_at, resolved_timestamp_iso
          FROM source_records
          WHERE source_type IN ('zoom_chat', 'zoom_call')
        `)
        .all() as Array<{
        id: string;
        raw_payload_json: string;
        first_seen_at: string;
        resolved_timestamp_iso: string | null;
      }>;

      const updateSr = this.db.prepare(`
        UPDATE source_records
        SET resolved_timestamp_iso = ?, timestamp_confidence = ?
        WHERE id = ?
      `);
      const updateEv = this.db.prepare(`
        UPDATE evidences
        SET resolved_timestamp_iso = ?, timestamp_confidence = ?
        WHERE source_record_id = ?
      `);
      const updateAct = this.db.prepare(`
        UPDATE activities
        SET occurred_at_iso = ?, timestamp_confidence = ?
        WHERE id IN (SELECT activity_id FROM evidences WHERE source_record_id = ?)
      `);

      for (const row of zoomSources) {
        try {
          const payload = JSON.parse(row.raw_payload_json) as {
            dateGroup?: string | null;
            visibleTimestamp?: string | null;
          };
          const resolved = resolveZoomTimestamp(
            payload.dateGroup,
            payload.visibleTimestamp,
            row.first_seen_at
          );
          const targetIso = resolved.resolvedTimestampIso ?? '';
          updateSr.run(resolved.resolvedTimestampIso, resolved.confidence, row.id);
          updateEv.run(resolved.resolvedTimestampIso, resolved.confidence, row.id);
          updateAct.run(targetIso, resolved.confidence, row.id);
        } catch {
          // ignore malformed payload
        }
      }

      // 2. Remove false-positive directory file_change, old UTC-stamped working tree activities, upstream remote-tracking pulls, and teammate git commits
      const bogusActs = this.db
        .prepare(`
          SELECT id FROM activities
          WHERE (source_type = 'file_change' AND summary LIKE '%Commit edilmemiş çalışma; iş tamamlandı veya kesin süre anlamına gelmez%')
             OR (source_type = 'git_working_tree' AND occurred_at_iso LIKE '%Z' AND summary LIKE '%(Devam eden çalışma; tamamlandı sayılmaz.)%')
             OR (source_type = 'git_commit' AND lower(summary) LIKE 'merge remote-tracking branch%')
             OR (source_type = 'git_commit' AND sender IS NOT NULL AND NOT (
                  lower(sender) LIKE '%rifki%'
                  OR lower(sender) LIKE '%rıfkı%'
                  OR lower(sender) LIKE '%kesepara%'
                  OR lower(summary) LIKE '%''rifki''%'
                  OR lower(summary) LIKE '%/rifki%'
                  OR lower(sender) LIKE '%test%'
                  OR lower(sender) LIKE '%developer%'
                ))
        `)
        .all() as Array<{ id: string }>;

      if (bogusActs.length > 0) {
        const delLink = this.db.prepare('DELETE FROM activity_links WHERE activity_id = ?');
        const getSr = this.db.prepare(
          'SELECT source_record_id FROM evidences WHERE activity_id = ?'
        );
        const delEv = this.db.prepare('DELETE FROM evidences WHERE activity_id = ?');
        const delSr = this.db.prepare('DELETE FROM source_records WHERE id = ?');
        const delAct = this.db.prepare('DELETE FROM activities WHERE id = ?');

        for (const b of bogusActs) {
          const srs = getSr.all(b.id) as Array<{ source_record_id: string | null }>;
          delLink.run(b.id);
          delEv.run(b.id);
          delAct.run(b.id);
          for (const sr of srs) {
            if (sr.source_record_id) delSr.run(sr.source_record_id);
          }
        }

        // Clean up any orphaned work_items that belonged solely to teammate commits
        this.db
          .prepare(`
            DELETE FROM work_items
            WHERE id NOT IN (SELECT work_item_id FROM activity_links WHERE work_item_id IS NOT NULL)
          `)
          .run();

        // Also clear non-user-edited report items that were generated from those bogus records
        this.db
          .prepare('DELETE FROM report_items WHERE is_user_edited = 0')
          .run();
      }

      // 3. Clean up any legacy verbose AI error string that echoed the full command-line prompt
      this.db
        .prepare(`
          UPDATE sync_state
          SET last_error = 'Gemini CLI bireysel OAuth oturumu Google tarafından desteklenmemektedir (IneligibleTierError). Yerel Kurallı Motor kullanıldı.'
          WHERE connector = 'ai_provider' AND last_error LIKE '%Command failed: powershell.exe%'
        `)
        .run();
    } catch {
      // ignore if tables are not yet initialized
    }
  }

  public clearAllData(): void {
    this.db.exec(`
      DELETE FROM report_items;
      DELETE FROM daily_reports;
      DELETE FROM activity_links;
      DELETE FROM evidences;
      DELETE FROM activities;
      DELETE FROM work_items;
      DELETE FROM source_records;
      DELETE FROM sync_state;
    `);
  }
}
