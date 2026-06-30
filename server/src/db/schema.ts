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
      doc_type      TEXT CHECK(doc_type IN ('SA', 'SD', 'other')) DEFAULT 'other',
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
    } catch {
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
    db.exec("ALTER TABLE documents ADD COLUMN doc_type TEXT CHECK(doc_type IN ('SA', 'SD', 'other')) DEFAULT 'other'");
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
      db.exec(`
        PRAGMA foreign_keys = OFF;

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

        PRAGMA foreign_keys = ON;
      `);
    } catch {
      db.exec('PRAGMA foreign_keys = ON');
    }
  }

  // Migration: add 'fullstack' label + 'testing' task_type to tasks table
  const tasksInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'").get() as { sql: string } | undefined;
  if (tasksInfo?.sql && (!tasksInfo.sql.includes("'fullstack'") || !tasksInfo.sql.includes("'testing'"))) {
    try {
      db.exec(`
        PRAGMA foreign_keys = OFF;

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

        PRAGMA foreign_keys = ON;
      `);
    } catch {
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
}
