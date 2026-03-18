import fs from 'node:fs';
import path from 'node:path';

export interface WorkspaceScanResult {
  path: string;
  hasClaudeMd: boolean;
  hasClaudeDir: boolean;
  skills: Array<{ name: string; filename: string; path: string }>;
  detectedFramework: string | null;
  scripts: Record<string, string> | null;
}

/**
 * Scans a workspace directory for Claude skills, framework detection, and project metadata.
 */
export class WorkspaceScanner {
  /**
   * Scan a directory for CLAUDE.md, .claude/commands/ skills, package.json info.
   */
  scan(dirPath: string): WorkspaceScanResult {
    if (!fs.existsSync(dirPath)) {
      throw new Error(`Directory does not exist: ${dirPath}`);
    }

    const hasClaudeMd = fs.existsSync(path.join(dirPath, 'CLAUDE.md'));

    const claudeDir = path.join(dirPath, '.claude');
    const hasClaudeDir = fs.existsSync(claudeDir) && fs.statSync(claudeDir).isDirectory();

    const skills = this.scanSkills(dirPath);
    const { framework, scripts } = this.detectFrameworkAndScripts(dirPath);

    return {
      path: dirPath,
      hasClaudeMd,
      hasClaudeDir,
      skills,
      detectedFramework: framework,
      scripts,
    };
  }

  private scanSkills(dirPath: string): Array<{ name: string; filename: string; path: string }> {
    const skills: Array<{ name: string; filename: string; path: string }> = [];
    const commandsDir = path.join(dirPath, '.claude', 'commands');

    if (!fs.existsSync(commandsDir)) return skills;

    try {
      const entries = fs.readdirSync(commandsDir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isFile() && e.name.endsWith('.md')) {
          skills.push({
            name: e.name.replace(/\.md$/, ''),
            filename: e.name,
            path: path.join(commandsDir, e.name),
          });
        }
      }
    } catch { /* ignore read errors */ }

    return skills;
  }

  private detectFrameworkAndScripts(dirPath: string): {
    framework: string | null;
    scripts: Record<string, string> | null;
  } {
    const pkgPath = path.join(dirPath, 'package.json');
    if (!fs.existsSync(pkgPath)) {
      return { framework: null, scripts: null };
    }

    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        scripts?: Record<string, string>;
      };

      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
      let framework: string | null = null;

      // Detect framework
      if (allDeps['next']) framework = 'nextjs';
      else if (allDeps['react']) framework = 'react';
      else if (allDeps['vue']) framework = 'vue';
      else if (allDeps['svelte'] || allDeps['@sveltejs/kit']) framework = 'svelte';
      else if (allDeps['@angular/core']) framework = 'angular';
      else if (allDeps['@nestjs/core']) framework = 'nestjs';
      else if (allDeps['express']) framework = 'express';
      else if (allDeps['fastify']) framework = 'fastify';
      else if (allDeps['hono']) framework = 'hono';

      // Extract useful scripts
      const scripts: Record<string, string> = {};
      if (pkg.scripts) {
        for (const key of ['dev', 'build', 'start', 'test', 'lint', 'typecheck']) {
          if (pkg.scripts[key]) scripts[key] = pkg.scripts[key];
        }
      }

      return {
        framework,
        scripts: Object.keys(scripts).length > 0 ? scripts : null,
      };
    } catch {
      return { framework: null, scripts: null };
    }
  }
}
