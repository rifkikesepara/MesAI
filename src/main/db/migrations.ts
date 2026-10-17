export interface Migration {
  version: number;
  name: string;
  upSql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: '001_initial_schema',
    upSql: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        root_path TEXT NOT NULL UNIQUE,
        repository_url TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        excluded_paths_json TEXT NOT NULL DEFAULT '[]',
        mapped_chat_names_json TEXT NOT NULL DEFAULT '[]',
        jira_project_keys_json TEXT NOT NULL DEFAULT '[]',
        current_branch TEXT,
        last_activity_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS source_records (
        id TEXT PRIMARY KEY,
        source_type TEXT NOT NULL,
        dedup_key TEXT NOT NULL UNIQUE,
        external_id TEXT,
        session_id TEXT,
        chat_name TEXT,
        sender TEXT,
        sender_resolved TEXT,
        raw_timestamp_text TEXT NOT NULL,
        resolved_timestamp_iso TEXT,
        timestamp_confidence TEXT NOT NULL,
        timezone_offset TEXT NOT NULL,
        message_type TEXT NOT NULL,
        text_content TEXT,
        links_json TEXT NOT NULL DEFAULT '[]',
        raw_payload_json TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_source_records_source_type ON source_records(source_type);
      CREATE INDEX IF NOT EXISTS idx_source_records_resolved_ts ON source_records(resolved_timestamp_iso);

      CREATE TABLE IF NOT EXISTS activities (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        source_type TEXT NOT NULL,
        category TEXT NOT NULL,
        status TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        chat_or_repo_name TEXT,
        sender TEXT,
        raw_timestamp_text TEXT NOT NULL,
        occurred_at_iso TEXT NOT NULL,
        timestamp_confidence TEXT NOT NULL DEFAULT 'exact',
        is_time_estimated INTEGER NOT NULL DEFAULT 0,
        duration_minutes INTEGER,
        confidence REAL NOT NULL DEFAULT 1.0,
        created_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_activities_occurred_at ON activities(occurred_at_iso);
      CREATE INDEX IF NOT EXISTS idx_activities_project_id ON activities(project_id);

      CREATE TABLE IF NOT EXISTS evidences (
        id TEXT PRIMARY KEY,
        activity_id TEXT NOT NULL,
        source_record_id TEXT,
        source_type TEXT NOT NULL,
        external_ref TEXT,
        title TEXT NOT NULL,
        snippet TEXT NOT NULL,
        raw_timestamp_text TEXT NOT NULL,
        resolved_timestamp_iso TEXT,
        timestamp_confidence TEXT NOT NULL DEFAULT 'exact',
        sender TEXT,
        chat_or_repo_name TEXT,
        links_json TEXT NOT NULL DEFAULT '[]',
        collected_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        FOREIGN KEY (activity_id) REFERENCES activities(id) ON DELETE CASCADE,
        FOREIGN KEY (source_record_id) REFERENCES source_records(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_evidences_activity_id ON evidences(activity_id);

      CREATE TABLE IF NOT EXISTS work_items (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        jira_key TEXT UNIQUE,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'open',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS activity_links (
        id TEXT PRIMARY KEY,
        activity_id TEXT NOT NULL,
        work_item_id TEXT,
        project_id TEXT,
        match_reason TEXT NOT NULL,
        match_type TEXT NOT NULL,
        confidence REAL NOT NULL,
        user_status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        FOREIGN KEY (activity_id) REFERENCES activities(id) ON DELETE CASCADE,
        FOREIGN KEY (work_item_id) REFERENCES work_items(id) ON DELETE CASCADE,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_activity_links_activity_id ON activity_links(activity_id);

      CREATE TABLE IF NOT EXISTS daily_reports (
        id TEXT PRIMARY KEY,
        report_date TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'draft',
        provider_used TEXT NOT NULL,
        generated_at TEXT NOT NULL,
        approved_at TEXT,
        notes TEXT
      );

      CREATE TABLE IF NOT EXISTS report_items (
        id TEXT PRIMARY KEY,
        report_id TEXT NOT NULL,
        work_item_id TEXT,
        project_id TEXT,
        category TEXT NOT NULL,
        item_status TEXT NOT NULL,
        text TEXT NOT NULL,
        is_user_edited INTEGER NOT NULL DEFAULT 0,
        is_insufficient_evidence INTEGER NOT NULL DEFAULT 0,
        insufficient_reason TEXT,
        duration_note TEXT,
        order_index INTEGER NOT NULL DEFAULT 0,
        evidence_ids_json TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL,
        FOREIGN KEY (report_id) REFERENCES daily_reports(id) ON DELETE CASCADE,
        FOREIGN KEY (work_item_id) REFERENCES work_items(id) ON DELETE SET NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_report_items_report_id ON report_items(report_id);

      CREATE TABLE IF NOT EXISTS sync_state (
        connector TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        cursor TEXT,
        last_attempt_at TEXT,
        last_success_at TEXT,
        last_error TEXT,
        records_count INTEGER NOT NULL DEFAULT 0,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `
  }
];
