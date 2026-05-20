import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger('SessionResolver');

/**
 * Resolves Claude Code session IDs and JSONL file paths.
 * Claude stores sessions at: ~/.claude/projects/{project-hash}/{session-id}.jsonl
 */
export class SessionResolver {
  /**
   * Convert a working directory path to Claude's project hash.
   * e.g., "d:\暫存檔\claude code\ai-omni-commander" → "d------claude-code-ai-omni-commander"
   * e.g., "/Users/simon/projects/myapp" → "-Users-simon-projects-myapp"
   */
  static getProjectHash(cwd: string): string {
    // Claude CLI uses this exact algorithm:
    // 1. Replace path separators with dashes
    // 2. Replace non-alphanumeric (except dash) with dash
    // 3. Lowercase everything
    // 4. Do NOT collapse consecutive dashes (Claude keeps them)
    // 5. Trim leading/trailing dashes
    // e.g., "D:\fork\ofeinvoice-ui" → "d--fork-ofeinvoice-ui"
    // e.g., "d:\暫存檔\claude code\ai-omni-commander" → "d------claude-code-ai-omni-commander"
    return cwd
      .replace(/\\/g, '-')
      .replace(/[^a-zA-Z0-9-]/g, '-')
      .toLowerCase()
      .replace(/^-+|-+$/g, '');
  }

  /** Get the Claude projects directory for a given working directory */
  static getProjectDir(cwd: string): string {
    const claudeDir = path.join(os.homedir(), '.claude', 'projects');
    const hash = this.getProjectHash(cwd);
    return path.join(claudeDir, hash);
  }

  /** Get the JSONL file path for a known session ID */
  static getJsonlPath(cwd: string, sessionId: string): string {
    return path.join(this.getProjectDir(cwd), `${sessionId}.jsonl`);
  }

  /** Read sessions-index.json to find all known sessions */
  static getSessionsIndex(cwd: string): Array<{
    sessionId: string;
    fullPath: string;
    firstPrompt: string;
    messageCount: number;
    created: string;
    modified: string;
  }> {
    const indexPath = path.join(this.getProjectDir(cwd), 'sessions-index.json');
    if (!fs.existsSync(indexPath)) return [];
    try {
      const data = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
      return data.entries || [];
    } catch {
      return [];
    }
  }

  /**
   * Wait for a new session JSONL file to appear after spawning claude CLI.
   * Compares current files against a snapshot taken before spawn.
   */
  static async waitForNewSession(
    cwd: string,
    knownSessionIds: Set<string>,
    timeoutMs = 15000,
  ): Promise<{ sessionId: string; jsonlPath: string }> {
    const projectDir = this.getProjectDir(cwd);
    const startTime = Date.now();
    let pollInterval = 200; // Start fast, increase

    while (Date.now() - startTime < timeoutMs) {
      try {
        if (fs.existsSync(projectDir)) {
          const files = fs.readdirSync(projectDir)
            .filter(f => f.endsWith('.jsonl') && !f.includes('/'));

          // Find the newest unknown session with content
          let bestSession: { sessionId: string; jsonlPath: string; mtime: number } | null = null;
          for (const file of files) {
            const sessionId = file.replace('.jsonl', '');
            if (!knownSessionIds.has(sessionId)) {
              const jsonlPath = path.join(projectDir, file);
              const stat = fs.statSync(jsonlPath);
              if (stat.size > 0 && (!bestSession || stat.mtimeMs > bestSession.mtime)) {
                bestSession = { sessionId, jsonlPath, mtime: stat.mtimeMs };
              }
            }
          }
          if (bestSession) {
            logger.info({ sessionId: bestSession.sessionId, jsonlPath: bestSession.jsonlPath }, 'New session detected');
            return { sessionId: bestSession.sessionId, jsonlPath: bestSession.jsonlPath };
          }
        }
      } catch (err) {
        logger.warn({ err }, 'Error scanning for new session');
      }

      await new Promise(r => setTimeout(r, pollInterval));
      // Increase interval: 200 → 400 → 800 → 1000 (cap)
      pollInterval = Math.min(pollInterval * 2, 1000);
    }

    throw new Error(`Timed out waiting for new session (${timeoutMs}ms). Project dir: ${projectDir}`);
  }

  /**
   * Snapshot current session IDs in a project directory.
   * Call before spawn to know which sessions already exist.
   */
  static snapshotSessions(cwd: string): Set<string> {
    const projectDir = this.getProjectDir(cwd);
    const sessions = new Set<string>();
    try {
      if (fs.existsSync(projectDir)) {
        const files = fs.readdirSync(projectDir)
          .filter(f => f.endsWith('.jsonl'));
        for (const file of files) {
          sessions.add(file.replace('.jsonl', ''));
        }
      }
    } catch {
      // Ignore errors
    }
    return sessions;
  }

  /**
   * Remove a session's JSONL file and its entry from sessions-index.json.
   * Used for cleaning up temporary sessions (e.g., SaFlowAnalyzer).
   */
  static cleanupSession(cwd: string, sessionId: string): void {
    const jsonlPath = this.getJsonlPath(cwd, sessionId);

    // Delete JSONL file
    try {
      if (fs.existsSync(jsonlPath)) {
        fs.unlinkSync(jsonlPath);
        logger.info({ sessionId }, 'Deleted session JSONL file');
      }
    } catch (err) {
      logger.warn({ err, sessionId }, 'Failed to delete session JSONL');
    }

    // Delete subagent directory if exists
    const subagentDir = path.join(this.getProjectDir(cwd), sessionId, 'subagents');
    try {
      if (fs.existsSync(subagentDir)) {
        fs.rmSync(path.join(this.getProjectDir(cwd), sessionId), { recursive: true, force: true });
      }
    } catch (err) {
      logger.warn({ err, sessionId }, 'Failed to delete subagent directory');
    }

    // Remove from sessions-index.json
    const indexPath = path.join(this.getProjectDir(cwd), 'sessions-index.json');
    try {
      if (fs.existsSync(indexPath)) {
        const data = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
        if (Array.isArray(data.entries)) {
          data.entries = data.entries.filter((e: { sessionId: string }) => e.sessionId !== sessionId);
          fs.writeFileSync(indexPath, JSON.stringify(data, null, 2));
          logger.info({ sessionId }, 'Removed session from sessions-index.json');
        }
      }
    } catch (err) {
      logger.warn({ err, sessionId }, 'Failed to update sessions-index.json');
    }
  }
}
