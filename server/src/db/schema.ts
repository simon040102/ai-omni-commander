import type Database from 'better-sqlite3';
import { TASK_TYPES, TASK_SOURCES, TASK_LABELS, TASK_STATUSES } from '@omni/shared';

const sqlIn = (arr: readonly string[]) => arr.map(v => `'${v}'`).join(', ');

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'idle'
                      CHECK(status IN ('idle', 'setup', 'planning',
                                        'executing', 'paused', 'completed', 'failed')),
      working_dir   TEXT NOT NULL,
      frontend_path TEXT,
      backend_path  TEXT,
      asana_project_gid TEXT,
      config_json   TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS agents (
      id              TEXT PRIMARY KEY,
      project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      role            TEXT NOT NULL CHECK(role IN ('master', 'architect', 'backend',
                                                    'frontend', 'coordinator', 'integration-test', 'skill-gen', 'devops', 'testing', 'review', 'quick', 'axure')),
      status          TEXT NOT NULL DEFAULT 'idle'
                        CHECK(status IN ('idle', 'starting', 'running', 'reviewing', 'paused',
                                          'stopping', 'stopped', 'error')),
      session_id      TEXT,
      pid             INTEGER,
      current_task_id TEXT,
      system_prompt   TEXT,
      model           TEXT NOT NULL DEFAULT 'sonnet',
      allowed_tools   TEXT,
      total_cost_usd  REAL NOT NULL DEFAULT 0.0,
      total_turns     INTEGER NOT NULL DEFAULT 0,
      total_input_tokens  INTEGER NOT NULL DEFAULT 0,
      total_output_tokens INTEGER NOT NULL DEFAULT 0,
      last_heartbeat  TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id                TEXT PRIMARY KEY,
      project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title             TEXT NOT NULL,
      description       TEXT,
      label             TEXT NOT NULL CHECK(label IN (${sqlIn(TASK_LABELS)})),
      status            TEXT NOT NULL DEFAULT 'pending'
                          CHECK(status IN (${sqlIn(TASK_STATUSES)})),
      assigned_agent_id TEXT REFERENCES agents(id),
      priority          INTEGER NOT NULL DEFAULT 0,
      prompt            TEXT,
      result_summary    TEXT,
      retry_count       INTEGER NOT NULL DEFAULT 0,
      max_retries       INTEGER NOT NULL DEFAULT 2,
      task_type         TEXT NOT NULL DEFAULT 'other' CHECK(task_type IN (${sqlIn(TASK_TYPES)})),
      source            TEXT NOT NULL DEFAULT 'manual' CHECK(source IN (${sqlIn(TASK_SOURCES)})),
      source_ref        TEXT,
      branch_name       TEXT,
      due_date          TEXT,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS task_dependencies (
      task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      depends_on_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      PRIMARY KEY (task_id, depends_on_id)
    );

    CREATE TABLE IF NOT EXISTS events (
      id            TEXT PRIMARY KEY,
      project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      event_type    TEXT NOT NULL,
      source        TEXT,
      target        TEXT,
      payload_json  TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS agent_outputs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id      TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      task_id       TEXT REFERENCES tasks(id),
      stream_type   TEXT NOT NULL CHECK(stream_type IN ('text', 'tool_use',
                                                          'tool_result', 'error', 'system')),
      content       TEXT NOT NULL,
      timestamp     TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS documents (
      id            TEXT PRIMARY KEY,
      project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      filename      TEXT NOT NULL,
      file_path     TEXT NOT NULL,
      file_type     TEXT,
      doc_type      TEXT CHECK(doc_type IN ('SA', 'SD', 'other', 'verification')) DEFAULT 'other',
      parsed_text   TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS interventions (
      id              TEXT PRIMARY KEY,
      project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      agent_id        TEXT NOT NULL REFERENCES agents(id),
      task_id         TEXT REFERENCES tasks(id),
      reason          TEXT NOT NULL,
      context_json    TEXT,
      status          TEXT NOT NULL DEFAULT 'pending'
                        CHECK(status IN ('pending', 'acknowledged', 'resolved', 'dismissed')),
      user_response   TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at     TEXT
    );

    CREATE TABLE IF NOT EXISTS agent_plans (
      id              TEXT PRIMARY KEY,
      agent_id        TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      content         TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'pending'
                        CHECK(status IN ('pending', 'approved', 'rejected')),
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      approved_at     TEXT
    );

    CREATE TABLE IF NOT EXISTS recent_paths (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      path          TEXT NOT NULL UNIQUE,
      label         TEXT,
      use_count     INTEGER NOT NULL DEFAULT 1,
      last_used_at  TEXT NOT NULL DEFAULT (datetime('now')),
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS workspace_skills (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      workspace_type  TEXT NOT NULL CHECK(workspace_type IN ('frontend', 'backend')),
      path            TEXT NOT NULL,
      has_claude_md   INTEGER NOT NULL DEFAULT 0,
      has_claude_dir  INTEGER NOT NULL DEFAULT 0,
      skills_json     TEXT,
      scanned_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_ws_skills ON workspace_skills(project_id, workspace_type);
    CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_agents_project ON agents(project_id);
    CREATE INDEX IF NOT EXISTS idx_events_project ON events(project_id);
    CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
    CREATE INDEX IF NOT EXISTS idx_agent_outputs_agent ON agent_outputs(agent_id);
    CREATE INDEX IF NOT EXISTS idx_agent_outputs_task ON agent_outputs(task_id);
    CREATE INDEX IF NOT EXISTS idx_interventions_status ON interventions(status);
    CREATE INDEX IF NOT EXISTS idx_recent_paths_last_used ON recent_paths(last_used_at DESC);
  `);

  // =============================================
  // v2 Migration: projects table (remove mode, add frontend_path/backend_path/asana_project_gid)
  // =============================================
  const projectTableInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='projects'").get() as { sql: string } | undefined;
  const hasMode = projectTableInfo?.sql?.includes("mode");
  const hasFrontendPath = projectTableInfo?.sql?.includes("frontend_path");

  if (hasMode && !hasFrontendPath) {
    // v1 → v2: rebuild projects table
    try {
      db.exec('PRAGMA foreign_keys = OFF');

      db.exec(`
        CREATE TABLE projects_v2 (
          id              TEXT PRIMARY KEY,
          name            TEXT NOT NULL,
          status          TEXT NOT NULL DEFAULT 'idle'
                            CHECK(status IN ('idle','setup','planning','executing','paused','completed','failed')),
          working_dir     TEXT NOT NULL,
          frontend_path   TEXT,
          backend_path    TEXT,
          asana_project_gid TEXT,
          config_json     TEXT,
          created_at      TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
        );

        INSERT INTO projects_v2 (id, name, status, working_dir, config_json, created_at, updated_at)
          SELECT id, name,
            CASE
              WHEN status = 'interviewing' THEN 'idle'
              WHEN status = 'completed' THEN 'idle'
              ELSE status
            END,
            working_dir, config_json, created_at, updated_at
          FROM projects;

        DROP TABLE projects;
        ALTER TABLE projects_v2 RENAME TO projects;
      `);

      // JS-layer migration: extract workspace paths from config_json
      const projects = db.prepare('SELECT id, config_json FROM projects').all() as Array<{ id: string; config_json: string | null }>;
      const updateStmt = db.prepare('UPDATE projects SET frontend_path = ?, backend_path = ? WHERE id = ?');
      for (const proj of projects) {
        if (proj.config_json) {
          try {
            const config = JSON.parse(proj.config_json) as { workspaces?: Array<{ label: string; path: string }> };
            if (config.workspaces) {
              const fe = config.workspaces.find(w => w.label === 'frontend')?.path || null;
              const be = config.workspaces.find(w => w.label === 'backend')?.path || null;
              updateStmt.run(fe, be, proj.id);
            }
          } catch { /* ignore parse errors */ }
        }
      }

      db.exec('PRAGMA foreign_keys = ON');
    } catch (err) {
      // stderr only — the MCP process's stdout is the JSON-RPC channel
      process.stderr.write(`[schema] v2 projects table migration failed: ${err instanceof Error ? err.message : String(err)}\n`);
      db.exec('PRAGMA foreign_keys = ON');
    }
  }

  // =============================================
  // v2 Migration: tasks table (add task_type, source, source_ref, branch_name)
  // =============================================
  const taskCols = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
  if (!taskCols.some(c => c.name === 'task_type')) {
    db.exec("ALTER TABLE tasks ADD COLUMN task_type TEXT NOT NULL DEFAULT 'other'");
  }
  if (!taskCols.some(c => c.name === 'source')) {
    db.exec("ALTER TABLE tasks ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'");
  }
  if (!taskCols.some(c => c.name === 'source_ref')) {
    db.exec("ALTER TABLE tasks ADD COLUMN source_ref TEXT");
  }
  if (!taskCols.some(c => c.name === 'branch_name')) {
    db.exec("ALTER TABLE tasks ADD COLUMN branch_name TEXT");
  }
  if (!taskCols.some(c => c.name === 'spec_url')) {
    db.exec("ALTER TABLE tasks ADD COLUMN spec_url TEXT");
  }
  if (!taskCols.some(c => c.name === 'preferred_model')) {
    db.exec("ALTER TABLE tasks ADD COLUMN preferred_model TEXT");
  }

  // =============================================
  // v3 Migration: projects table (add db_connection_string)
  // =============================================
  const projCols = db.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>;
  if (!projCols.some(c => c.name === 'db_connection_string')) {
    db.exec("ALTER TABLE projects ADD COLUMN db_connection_string TEXT");
  }

  // =============================================
  // Legacy migrations (for DBs that predate v1 quick mode)
  // =============================================

  // Migration: add doc_type column if missing
  const docCols = db.prepare("PRAGMA table_info(documents)").all() as Array<{ name: string }>;
  if (!docCols.some(c => c.name === 'doc_type')) {
    db.exec("ALTER TABLE documents ADD COLUMN doc_type TEXT CHECK(doc_type IN ('SA', 'SD', 'other', 'verification')) DEFAULT 'other'");
  }

  // Migration: add working_dir to agents
  {
    const agentCols2 = db.prepare("PRAGMA table_info(agents)").all() as Array<{ name: string }>;
    const names2 = agentCols2.map(c => c.name);
    if (!names2.includes('working_dir')) {
      db.exec("ALTER TABLE agents ADD COLUMN working_dir TEXT");
    }
  }

  // Migration: add token tracking columns to agents
  const agentCols = db.prepare("PRAGMA table_info(agents)").all() as Array<{ name: string }>;
  if (!agentCols.some(c => c.name === 'total_input_tokens')) {
    db.exec("ALTER TABLE agents ADD COLUMN total_input_tokens INTEGER NOT NULL DEFAULT 0");
  }
  if (!agentCols.some(c => c.name === 'total_output_tokens')) {
    db.exec("ALTER TABLE agents ADD COLUMN total_output_tokens INTEGER NOT NULL DEFAULT 0");
  }
  if (!agentCols.some(c => c.name === 'review_result_json')) {
    db.exec("ALTER TABLE agents ADD COLUMN review_result_json TEXT");
  }
  if (!agentCols.some(c => c.name === 'title')) {
    db.exec("ALTER TABLE agents ADD COLUMN title TEXT");
  }
  if (!agentCols.some(c => c.name === 'flow_plan_json')) {
    db.exec("ALTER TABLE agents ADD COLUMN flow_plan_json TEXT");
  }

  // =============================================
  // v4 Migration: SVN spec auto-fetch support
  // =============================================

  // Migration: add parent_name to tasks
  if (!taskCols.some(c => c.name === 'parent_name')) {
    db.exec("ALTER TABLE tasks ADD COLUMN parent_name TEXT");
  }

  // Migration: add source tracking to documents
  if (!docCols.some(c => c.name === 'source')) {
    db.exec("ALTER TABLE documents ADD COLUMN source TEXT NOT NULL DEFAULT 'upload'");
  }
  if (!docCols.some(c => c.name === 'source_url')) {
    db.exec("ALTER TABLE documents ADD COLUMN source_url TEXT");
  }
  if (!docCols.some(c => c.name === 'svn_last_modified')) {
    db.exec("ALTER TABLE documents ADD COLUMN svn_last_modified TEXT");
  }
  if (!docCols.some(c => c.name === 'content_hash')) {
    db.exec("ALTER TABLE documents ADD COLUMN content_hash TEXT");
  }

  // Migration: create task_documents table
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_documents (
      task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      bound_at    TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (task_id, document_id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_documents_task ON task_documents(task_id);
    CREATE INDEX IF NOT EXISTS idx_task_documents_doc ON task_documents(document_id);
  `);

  // =============================================
  // v5 Migration: global_config table
  // =============================================
  db.exec(`
    CREATE TABLE IF NOT EXISTS global_config (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Migration: add 'quick'/'axure'/'coordinator' role to agents table
  const tableInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='agents'").get() as { sql: string } | undefined;
  const needsQuickRoleMigration = tableInfo?.sql && (!tableInfo.sql.includes("'quick'") || !tableInfo.sql.includes("'axure'"));
  const needsCoordinatorRoleMigration = tableInfo?.sql && (!tableInfo.sql.includes("'coordinator'") || !tableInfo.sql.includes("'integration-test'") || !tableInfo.sql.includes("'skill-gen'"));

  const needsReviewingStatusMigration = tableInfo?.sql && !tableInfo.sql.includes("'reviewing'");

  if (needsQuickRoleMigration || needsReviewingStatusMigration || needsCoordinatorRoleMigration) {
    try {
      // PRAGMA foreign_keys is a no-op inside a transaction — keep it outside.
      // BEGIN IMMEDIATE makes the whole rebuild atomic (no half-rebuilt table on
      // crash) and locks out a concurrently starting second process (Web + MCP
      // share the same SQLite file).
      db.exec('PRAGMA foreign_keys = OFF');
      db.exec(`
        BEGIN IMMEDIATE;

        CREATE TABLE IF NOT EXISTS agents_new (
          id              TEXT PRIMARY KEY,
          project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          role            TEXT NOT NULL CHECK(role IN ('master', 'architect', 'backend',
                                                        'frontend', 'coordinator', 'integration-test', 'skill-gen', 'devops', 'testing', 'review', 'quick', 'axure')),
          status          TEXT NOT NULL DEFAULT 'idle'
                            CHECK(status IN ('idle', 'starting', 'running', 'reviewing', 'paused',
                                              'stopping', 'stopped', 'error')),
          session_id      TEXT,
          pid             INTEGER,
          current_task_id TEXT,
          system_prompt   TEXT,
          model           TEXT NOT NULL DEFAULT 'sonnet',
          allowed_tools   TEXT,
          total_cost_usd  REAL NOT NULL DEFAULT 0.0,
          total_turns     INTEGER NOT NULL DEFAULT 0,
          total_input_tokens  INTEGER NOT NULL DEFAULT 0,
          total_output_tokens INTEGER NOT NULL DEFAULT 0,
          last_heartbeat  TEXT,
          created_at      TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
          review_result_json TEXT,
          title           TEXT
        );
        INSERT OR IGNORE INTO agents_new
          SELECT id, project_id, role, status, session_id, pid, current_task_id,
                 system_prompt, model, allowed_tools, total_cost_usd, total_turns,
                 total_input_tokens, total_output_tokens, last_heartbeat,
                 created_at, updated_at, review_result_json, title
          FROM agents;
        DROP TABLE agents;
        ALTER TABLE agents_new RENAME TO agents;
        CREATE INDEX IF NOT EXISTS idx_agents_project ON agents(project_id);

        COMMIT;
      `);
    } catch (err) {
      process.stderr.write(`[schema] agents role/status migration failed: ${err instanceof Error ? err.message : String(err)}\n`);
      try { db.exec('ROLLBACK'); } catch { /* no open transaction */ }
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  }

  // Migration: add 'fullstack' label + 'testing' task_type to tasks table
  const tasksInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'").get() as { sql: string } | undefined;
  if (tasksInfo?.sql && (!tasksInfo.sql.includes("'fullstack'") || !tasksInfo.sql.includes("'testing'"))) {
    try {
      db.exec('PRAGMA foreign_keys = OFF');
      db.exec(`
        BEGIN IMMEDIATE;

        CREATE TABLE IF NOT EXISTS tasks_new (
          id                TEXT PRIMARY KEY,
          project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          title             TEXT NOT NULL,
          description       TEXT,
          label             TEXT NOT NULL CHECK(label IN (${sqlIn(TASK_LABELS)})),
          status            TEXT NOT NULL DEFAULT 'pending'
                              CHECK(status IN (${sqlIn(TASK_STATUSES)})),
          assigned_agent_id TEXT REFERENCES agents(id),
          priority          INTEGER NOT NULL DEFAULT 0,
          prompt            TEXT,
          result_summary    TEXT,
          retry_count       INTEGER NOT NULL DEFAULT 0,
          max_retries       INTEGER NOT NULL DEFAULT 2,
          task_type         TEXT NOT NULL DEFAULT 'other' CHECK(task_type IN (${sqlIn(TASK_TYPES)})),
          source            TEXT NOT NULL DEFAULT 'manual' CHECK(source IN (${sqlIn(TASK_SOURCES)})),
          source_ref        TEXT,
          branch_name       TEXT,
          spec_url          TEXT,
          preferred_model   TEXT,
          parent_name       TEXT,
          created_at        TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
        );

        INSERT OR IGNORE INTO tasks_new
          SELECT id, project_id, title, description, label, status,
                 assigned_agent_id, priority, prompt, result_summary,
                 retry_count, max_retries, task_type, source, source_ref,
                 branch_name, spec_url, preferred_model, parent_name,
                 created_at, updated_at
          FROM tasks;
        DROP TABLE tasks;
        ALTER TABLE tasks_new RENAME TO tasks;
        CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);

        COMMIT;
      `);
    } catch (err) {
      process.stderr.write(`[schema] tasks fullstack/testing migration failed: ${err instanceof Error ? err.message : String(err)}\n`);
      try { db.exec('ROLLBACK'); } catch { /* no open transaction */ }
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  }

  // =============================================
  // v6 Migration: Asana classification dimensions on tasks
  // section / tags / custom_fields / assignee from Asana.
  // Added at the end so the fullstack table-rebuild above cannot drop them.
  // =============================================
  {
    const tcols = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    const names = tcols.map(c => c.name);
    if (!names.includes('section')) db.exec("ALTER TABLE tasks ADD COLUMN section TEXT");
    if (!names.includes('tags')) db.exec("ALTER TABLE tasks ADD COLUMN tags TEXT");           // JSON array of tag names
    if (!names.includes('custom_fields')) db.exec("ALTER TABLE tasks ADD COLUMN custom_fields TEXT"); // JSON object name -> display_value
    if (!names.includes('assignee')) db.exec("ALTER TABLE tasks ADD COLUMN assignee TEXT");
    if (!names.includes('assignee_gid')) db.exec("ALTER TABLE tasks ADD COLUMN assignee_gid TEXT");
  }

  // =============================================
  // v7 Migration: Flow-Gated Development state on tasks
  // flow_required — set by get_execution_plan; flow_state — FlowGateState JSON.
  // MUST stay after the fullstack table-rebuild above (its INSERT SELECT has a
  // hard-coded column list and would silently drop these columns).
  // =============================================
  {
    const tcols = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    const names = tcols.map(c => c.name);
    if (!names.includes('flow_required')) db.exec("ALTER TABLE tasks ADD COLUMN flow_required INTEGER DEFAULT 0");
    if (!names.includes('flow_state')) db.exec("ALTER TABLE tasks ADD COLUMN flow_state TEXT"); // JSON FlowGateState
  }

  // =============================================
  // v8 Migration: unique index for Asana upsert identity (project_id, source_ref).
  // If pre-existing data contains duplicates the index cannot be created —
  // warn on stderr and skip; NEVER delete existing rows here.
  // =============================================
  try {
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_project_sourceref ON tasks(project_id, source_ref) WHERE source_ref IS NOT NULL");
  } catch (err) {
    process.stderr.write(`[schema] skipped idx_tasks_project_sourceref (duplicate source_ref rows exist?): ${err instanceof Error ? err.message : String(err)}\n`);
  }

  // =============================================
  // v9 Migration: spec_gaps table — structured "規格缺少/待補" records
  // reported by MCP report_spec_gap (replaces free-text [NEEDS_CLARIFICATION]).
  // Failure is non-fatal: warn on stderr and continue (v8 pattern).
  // =============================================
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS spec_gaps (
        id              TEXT PRIMARY KEY,
        task_id         TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        category        TEXT NOT NULL CHECK(category IN ('sa_missing', 'sd_missing', 'field_undefined',
                                                          'api_undefined', 'logic_unclear', 'other', 'spec_changed', 'sa_sd_mismatch', 'ambiguous_spec')),
        description     TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'resolved')),
        resolution_note TEXT,
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        resolved_at     TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_spec_gaps_project ON spec_gaps(project_id);
      CREATE INDEX IF NOT EXISTS idx_spec_gaps_task ON spec_gaps(task_id);
      CREATE INDEX IF NOT EXISTS idx_spec_gaps_status ON spec_gaps(status);
    `);
  } catch (err) {
    process.stderr.write(`[schema] v9 spec_gaps migration failed: ${err instanceof Error ? err.message : String(err)}\n`);
  }

  // =============================================
  // v10 Migration: project_notes table — 專案經驗筆記（前人踩坑教訓）
  // saved by MCP save_project_note, injected into execution plans.
  // Failure is non-fatal: warn on stderr and continue (v9 pattern).
  // =============================================
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS project_notes (
        id          TEXT PRIMARY KEY,
        project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        category    TEXT,
        content     TEXT NOT NULL,
        active      INTEGER NOT NULL DEFAULT 1,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_project_notes_project ON project_notes(project_id);
    `);
  } catch (err) {
    process.stderr.write(`[schema] v10 project_notes migration failed: ${err instanceof Error ? err.message : String(err)}\n`);
  }

  // =============================================
  // v11 Migration: task_spec_versions — records the SVN last-modified date of
  // each spec file successfully fetched for a task (MCP fetch_svn_specs and
  // Web SvnSpecService both upsert). check_spec_changes compares against SVN.
  // =============================================
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS task_spec_versions (
        task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        file_ref      TEXT NOT NULL,
        last_modified TEXT,
        recorded_at   TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (task_id, file_ref)
      );
    `);
  } catch (err) {
    process.stderr.write(`[schema] v11 task_spec_versions migration failed: ${err instanceof Error ? err.message : String(err)}\n`);
  }

  // =============================================
  // v12 Migration: spec_gaps category CHECK 擴充 'spec_changed'.
  // Existing DBs have the 6-value CHECK — rebuild the table (CREATE new →
  // INSERT SELECT explicit columns → DROP → RENAME) so no data is lost.
  // Fresh DBs already get the 7-value CHECK from v9 above and skip this.
  // =============================================
  {
    const specGapsInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='spec_gaps'").get() as { sql: string } | undefined;
    if (specGapsInfo?.sql && !specGapsInfo.sql.includes("'spec_changed'")) {
      try {
        db.exec('PRAGMA foreign_keys = OFF');
        db.exec(`
          BEGIN IMMEDIATE;

          CREATE TABLE IF NOT EXISTS spec_gaps_new (
            id              TEXT PRIMARY KEY,
            task_id         TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            category        TEXT NOT NULL CHECK(category IN ('sa_missing', 'sd_missing', 'field_undefined',
                                                              'api_undefined', 'logic_unclear', 'other', 'spec_changed')),
            description     TEXT NOT NULL,
            status          TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'resolved')),
            resolution_note TEXT,
            created_at      TEXT NOT NULL DEFAULT (datetime('now')),
            resolved_at     TEXT
          );
          INSERT OR IGNORE INTO spec_gaps_new (id, task_id, project_id, category, description, status, resolution_note, created_at, resolved_at)
            SELECT id, task_id, project_id, category, description, status, resolution_note, created_at, resolved_at
            FROM spec_gaps;
          DROP TABLE spec_gaps;
          ALTER TABLE spec_gaps_new RENAME TO spec_gaps;
          CREATE INDEX IF NOT EXISTS idx_spec_gaps_project ON spec_gaps(project_id);
          CREATE INDEX IF NOT EXISTS idx_spec_gaps_task ON spec_gaps(task_id);
          CREATE INDEX IF NOT EXISTS idx_spec_gaps_status ON spec_gaps(status);

          COMMIT;
        `);
      } catch (err) {
        process.stderr.write(`[schema] v12 spec_gaps spec_changed migration failed: ${err instanceof Error ? err.message : String(err)}\n`);
        try { db.exec('ROLLBACK'); } catch { /* no open transaction */ }
      } finally {
        db.exec('PRAGMA foreign_keys = ON');
      }
    }
  }

  // =============================================
  // v13 Migration: documents doc_type CHECK 擴充 'verification'
  // (report_verification_evidence 寫入的驗收證據檔案).
  // Existing DBs have the 3-value CHECK — rebuild the table; fresh DBs already
  // get the 4-value CHECK from the initial CREATE above and skip this.
  // =============================================
  {
    const documentsInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='documents'").get() as { sql: string } | undefined;
    if (documentsInfo?.sql && documentsInfo.sql.includes('doc_type') && documentsInfo.sql.includes('CHECK') && !documentsInfo.sql.includes("'verification'")) {
      try {
        db.exec('PRAGMA foreign_keys = OFF');
        db.exec(`
          BEGIN IMMEDIATE;

          CREATE TABLE IF NOT EXISTS documents_new (
            id                TEXT PRIMARY KEY,
            project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            filename          TEXT NOT NULL,
            file_path         TEXT NOT NULL,
            file_type         TEXT,
            doc_type          TEXT CHECK(doc_type IN ('SA', 'SD', 'other', 'verification')) DEFAULT 'other',
            parsed_text       TEXT,
            created_at        TEXT NOT NULL DEFAULT (datetime('now')),
            source            TEXT NOT NULL DEFAULT 'upload',
            source_url        TEXT,
            svn_last_modified TEXT,
            content_hash      TEXT
          );
          INSERT OR IGNORE INTO documents_new (id, project_id, filename, file_path, file_type, doc_type, parsed_text, created_at, source, source_url, svn_last_modified, content_hash)
            SELECT id, project_id, filename, file_path, file_type, doc_type, parsed_text, created_at, source, source_url, svn_last_modified, content_hash
            FROM documents;
          DROP TABLE documents;
          ALTER TABLE documents_new RENAME TO documents;

          COMMIT;
        `);
      } catch (err) {
        process.stderr.write(`[schema] v13 documents verification doc_type migration failed: ${err instanceof Error ? err.message : String(err)}\n`);
        try { db.exec('ROLLBACK'); } catch { /* no open transaction */ }
      } finally {
        db.exec('PRAGMA foreign_keys = ON');
      }
    }
  }

  // =============================================
  // v14 Migration: spec_checklist_items — 規格回對引擎的結構化 checklist。
  // subagent 讀完 SA/SD 後用 save_spec_checklist 抽取（content 從規格逐字抄），
  // run_spec_compliance 用純程式比對 workspace 程式碼。
  // Failure is non-fatal: warn on stderr and continue (v9 pattern).
  // =============================================
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS spec_checklist_items (
        id            TEXT PRIMARY KEY,
        task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        item_type     TEXT NOT NULL CHECK(item_type IN ('ui_text', 'api', 'param',
                                                         'response_field', 'db_field', 'logic')),
        content       TEXT NOT NULL,
        side          TEXT CHECK(side IN ('frontend', 'backend', 'both')) DEFAULT 'both',
        detail_json   TEXT,
        source_ref    TEXT,
        waived        INTEGER NOT NULL DEFAULT 0,
        waive_reason  TEXT,
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_spec_checklist_items_task ON spec_checklist_items(task_id);
    `);
  } catch (err) {
    process.stderr.write(`[schema] v14 spec_checklist_items migration failed: ${err instanceof Error ? err.message : String(err)}\n`);
  }

  // =============================================
  // v15 Migration: spec_compliance_runs — run_spec_compliance 的每次比對結果。
  // update_task_status(completed) 閘門檢查最新一次 run 的 missing 是否為 0。
  // Failure is non-fatal: warn on stderr and continue (v9 pattern).
  // =============================================
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS spec_compliance_runs (
        id            TEXT PRIMARY KEY,
        task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        run_at        TEXT NOT NULL DEFAULT (datetime('now')),
        total         INTEGER NOT NULL DEFAULT 0,
        matched       INTEGER NOT NULL DEFAULT 0,
        missing       INTEGER NOT NULL DEFAULT 0,
        manual        INTEGER NOT NULL DEFAULT 0,
        waived        INTEGER NOT NULL DEFAULT 0,
        results_json  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_spec_compliance_runs_task ON spec_compliance_runs(task_id);
    `);
  } catch (err) {
    process.stderr.write(`[schema] v15 spec_compliance_runs migration failed: ${err instanceof Error ? err.message : String(err)}\n`);
  }

  // =============================================
  // v16 Migration: spec_compliance_runs.source — 'engine'（run_spec_compliance
  // 程式預檢）或 'ai_review'（save_compliance_review 獨立 AI 回對）。
  // 完成閘門只認最新一次 ai_review run 的 missing=0。
  // Idempotent: duplicate column throw is swallowed; other errors warn on stderr.
  // =============================================
  try {
    db.exec("ALTER TABLE spec_compliance_runs ADD COLUMN source TEXT NOT NULL DEFAULT 'engine'");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/duplicate column/i.test(msg)) {
      process.stderr.write(`[schema] v16 spec_compliance_runs.source migration failed: ${msg}\n`);
    }
  }

  // =============================================
  // v17 Migration: spec_gaps category CHECK 擴充 'sa_sd_mismatch'
  // (check_spec_consistency 派出的一致性檢查 agent 用 report_spec_gap 寫入).
  // Existing DBs have the 7-value CHECK — rebuild the table (CREATE new →
  // INSERT SELECT explicit columns → DROP → RENAME) so no data is lost
  // (v12 pattern). Fresh DBs already get the 8-value CHECK from v9 above
  // and skip this.
  // =============================================
  {
    const specGapsInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='spec_gaps'").get() as { sql: string } | undefined;
    if (specGapsInfo?.sql && !specGapsInfo.sql.includes("'sa_sd_mismatch'")) {
      try {
        db.exec('PRAGMA foreign_keys = OFF');
        db.exec(`
          BEGIN IMMEDIATE;

          CREATE TABLE IF NOT EXISTS spec_gaps_new (
            id              TEXT PRIMARY KEY,
            task_id         TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            category        TEXT NOT NULL CHECK(category IN ('sa_missing', 'sd_missing', 'field_undefined',
                                                              'api_undefined', 'logic_unclear', 'other', 'spec_changed', 'sa_sd_mismatch')),
            description     TEXT NOT NULL,
            status          TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'resolved')),
            resolution_note TEXT,
            created_at      TEXT NOT NULL DEFAULT (datetime('now')),
            resolved_at     TEXT
          );
          INSERT OR IGNORE INTO spec_gaps_new (id, task_id, project_id, category, description, status, resolution_note, created_at, resolved_at)
            SELECT id, task_id, project_id, category, description, status, resolution_note, created_at, resolved_at
            FROM spec_gaps;
          DROP TABLE spec_gaps;
          ALTER TABLE spec_gaps_new RENAME TO spec_gaps;
          CREATE INDEX IF NOT EXISTS idx_spec_gaps_project ON spec_gaps(project_id);
          CREATE INDEX IF NOT EXISTS idx_spec_gaps_task ON spec_gaps(task_id);
          CREATE INDEX IF NOT EXISTS idx_spec_gaps_status ON spec_gaps(status);

          COMMIT;
        `);
      } catch (err) {
        process.stderr.write(`[schema] v17 spec_gaps sa_sd_mismatch migration failed: ${err instanceof Error ? err.message : String(err)}\n`);
        try { db.exec('ROLLBACK'); } catch { /* no open transaction */ }
      } finally {
        db.exec('PRAGMA foreign_keys = ON');
      }
    }
  }

  // =============================================
  // v18 Migration: tasks.due_date — Asana 截止日期（due_on 原樣 YYYY-MM-DD，無則 NULL）。
  // 兩條同步路徑（MCP sync_asana_tasks / Web AsanaSyncService）落地，
  // next_task 排序與 list_pending_tasks overdue 標示使用。
  // MUST stay after the fullstack table-rebuild above (its INSERT SELECT has a
  // hard-coded column list and would silently drop this column). Fresh DBs get
  // the column from the initial CREATE TABLE and skip the ALTER.
  // =============================================
  {
    const tcols = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    if (!tcols.some(c => c.name === 'due_date')) db.exec("ALTER TABLE tasks ADD COLUMN due_date TEXT");
  }

  // =============================================
  // v19 Migration: spec_gaps category CHECK 擴充 'ambiguous_spec'
  // (check_spec_consistency 維度二「規格模糊點預檢」的 reviewer agent 用
  // report_spec_gap 寫入——規格找不到唯一答案的決策點，開給使用者拍板).
  // Existing DBs have the 8-value CHECK — rebuild the table (v17 pattern:
  // introspection guard → PRAGMA outside tx → BEGIN IMMEDIATE tx → CREATE new
  // → INSERT SELECT explicit columns → DROP → RENAME → recreate indexes →
  // commit; catch does best-effort ROLLBACK). Fresh DBs already get the
  // 9-value CHECK from v9 above and skip this. Idempotent.
  // =============================================
  {
    const specGapsInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='spec_gaps'").get() as { sql: string } | undefined;
    if (specGapsInfo?.sql && !specGapsInfo.sql.includes("'ambiguous_spec'")) {
      try {
        db.exec('PRAGMA foreign_keys = OFF');
        db.exec(`
          BEGIN IMMEDIATE;

          CREATE TABLE IF NOT EXISTS spec_gaps_new (
            id              TEXT PRIMARY KEY,
            task_id         TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            category        TEXT NOT NULL CHECK(category IN ('sa_missing', 'sd_missing', 'field_undefined',
                                                              'api_undefined', 'logic_unclear', 'other', 'spec_changed', 'sa_sd_mismatch', 'ambiguous_spec')),
            description     TEXT NOT NULL,
            status          TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'resolved')),
            resolution_note TEXT,
            created_at      TEXT NOT NULL DEFAULT (datetime('now')),
            resolved_at     TEXT
          );
          INSERT OR IGNORE INTO spec_gaps_new (id, task_id, project_id, category, description, status, resolution_note, created_at, resolved_at)
            SELECT id, task_id, project_id, category, description, status, resolution_note, created_at, resolved_at
            FROM spec_gaps;
          DROP TABLE spec_gaps;
          ALTER TABLE spec_gaps_new RENAME TO spec_gaps;
          CREATE INDEX IF NOT EXISTS idx_spec_gaps_project ON spec_gaps(project_id);
          CREATE INDEX IF NOT EXISTS idx_spec_gaps_task ON spec_gaps(task_id);
          CREATE INDEX IF NOT EXISTS idx_spec_gaps_status ON spec_gaps(status);

          COMMIT;
        `);
      } catch (err) {
        process.stderr.write(`[schema] v19 spec_gaps ambiguous_spec migration failed: ${err instanceof Error ? err.message : String(err)}\n`);
        try { db.exec('ROLLBACK'); } catch { /* no open transaction */ }
      } finally {
        db.exec('PRAGMA foreign_keys = ON');
      }
    }
  }
}
