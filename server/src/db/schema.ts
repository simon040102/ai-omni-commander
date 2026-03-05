import type Database from 'better-sqlite3';

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      mode          TEXT NOT NULL CHECK(mode IN ('spec', 'creative', 'quick')),
      status        TEXT NOT NULL DEFAULT 'setup'
                      CHECK(status IN ('setup', 'interviewing', 'planning',
                                        'executing', 'paused', 'completed', 'failed')),
      working_dir   TEXT NOT NULL,
      config_json   TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS agents (
      id              TEXT PRIMARY KEY,
      project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      role            TEXT NOT NULL CHECK(role IN ('master', 'architect', 'backend',
                                                    'frontend', 'devops', 'testing', 'review')),
      status          TEXT NOT NULL DEFAULT 'idle'
                        CHECK(status IN ('idle', 'starting', 'running', 'paused',
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
      label             TEXT NOT NULL CHECK(label IN ('backend', 'frontend', 'devops',
                                                       'testing', 'review', 'architect')),
      status            TEXT NOT NULL DEFAULT 'pending'
                          CHECK(status IN ('pending', 'blocked', 'queued', 'assigned',
                                            'in_progress', 'needs_review', 'needs_intervention',
                                            'completed', 'failed')),
      assigned_agent_id TEXT REFERENCES agents(id),
      priority          INTEGER NOT NULL DEFAULT 0,
      prompt            TEXT,
      result_summary    TEXT,
      retry_count       INTEGER NOT NULL DEFAULT 0,
      max_retries       INTEGER NOT NULL DEFAULT 2,
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

    CREATE TABLE IF NOT EXISTS recent_paths (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      path          TEXT NOT NULL UNIQUE,
      label         TEXT,
      use_count     INTEGER NOT NULL DEFAULT 1,
      last_used_at  TEXT NOT NULL DEFAULT (datetime('now')),
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_agents_project ON agents(project_id);
    CREATE INDEX IF NOT EXISTS idx_events_project ON events(project_id);
    CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
    CREATE INDEX IF NOT EXISTS idx_agent_outputs_agent ON agent_outputs(agent_id);
    CREATE INDEX IF NOT EXISTS idx_interventions_status ON interventions(status);
    CREATE INDEX IF NOT EXISTS idx_recent_paths_last_used ON recent_paths(last_used_at DESC);
  `);

  // Migration: add 'quick' mode to projects table (for existing DBs)
  // SQLite doesn't support altering CHECK constraints, so we recreate the table
  const projectCols = db.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>;
  if (projectCols.length > 0) {
    // Check if we need to migrate by trying to insert a quick mode project
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS projects_new (
          id            TEXT PRIMARY KEY,
          name          TEXT NOT NULL,
          mode          TEXT NOT NULL CHECK(mode IN ('spec', 'creative', 'quick')),
          status        TEXT NOT NULL DEFAULT 'setup'
                          CHECK(status IN ('setup', 'interviewing', 'planning',
                                            'executing', 'paused', 'completed', 'failed')),
          working_dir   TEXT NOT NULL,
          config_json   TEXT,
          created_at    TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT OR IGNORE INTO projects_new SELECT * FROM projects;
        DROP TABLE projects;
        ALTER TABLE projects_new RENAME TO projects;
      `);
    } catch {
      // Table already has correct constraint or migration not needed
    }
  }

  // Migration: add doc_type column if missing (for existing DBs)
  const cols = db.prepare("PRAGMA table_info(documents)").all() as Array<{ name: string }>;
  if (!cols.some(c => c.name === 'doc_type')) {
    db.exec("ALTER TABLE documents ADD COLUMN doc_type TEXT CHECK(doc_type IN ('SA', 'SD', 'other')) DEFAULT 'other'");
  }

  // Migration: add token tracking columns to agents (for existing DBs)
  const agentCols = db.prepare("PRAGMA table_info(agents)").all() as Array<{ name: string }>;
  if (!agentCols.some(c => c.name === 'total_input_tokens')) {
    db.exec("ALTER TABLE agents ADD COLUMN total_input_tokens INTEGER NOT NULL DEFAULT 0");
  }
  if (!agentCols.some(c => c.name === 'total_output_tokens')) {
    db.exec("ALTER TABLE agents ADD COLUMN total_output_tokens INTEGER NOT NULL DEFAULT 0");
  }
}
