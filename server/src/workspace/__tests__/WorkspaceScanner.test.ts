import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { WorkspaceScanner } from '../WorkspaceScanner.js';

let tmpDir: string;
let scanner: WorkspaceScanner;

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ws-scan-test-'));
}

describe('WorkspaceScanner', () => {
  beforeEach(() => {
    tmpDir = makeTmpDir();
    scanner = new WorkspaceScanner();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('scan() detects CLAUDE.md', () => {
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), '# Project');
    const result = scanner.scan(tmpDir);
    expect(result.hasClaudeMd).toBe(true);
  });

  it('scan() reports missing CLAUDE.md', () => {
    const result = scanner.scan(tmpDir);
    expect(result.hasClaudeMd).toBe(false);
  });

  it('scan() detects .claude directory', () => {
    fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true });
    const result = scanner.scan(tmpDir);
    expect(result.hasClaudeDir).toBe(true);
  });

  it('scan() detects .claude/commands/*.md skills', () => {
    const commandsDir = path.join(tmpDir, '.claude', 'commands');
    fs.mkdirSync(commandsDir, { recursive: true });
    fs.writeFileSync(path.join(commandsDir, 'deploy.md'), '# Deploy');
    fs.writeFileSync(path.join(commandsDir, 'test.md'), '# Test');
    fs.writeFileSync(path.join(commandsDir, 'not-a-skill.txt'), 'ignore');

    const result = scanner.scan(tmpDir);
    expect(result.skills).toHaveLength(2);
    const names = result.skills.map(s => s.name).sort();
    expect(names).toEqual(['deploy', 'test']);
  });

  it('scan() reads package.json scripts', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
      scripts: {
        dev: 'vite',
        build: 'vite build',
        test: 'vitest',
        custom: 'do-something', // not in standard set, should be excluded
      },
    }));

    const result = scanner.scan(tmpDir);
    expect(result.scripts).toBeTruthy();
    expect(result.scripts!['dev']).toBe('vite');
    expect(result.scripts!['build']).toBe('vite build');
    expect(result.scripts!['test']).toBe('vitest');
    expect(result.scripts!['custom']).toBeUndefined();
  });

  it('scan() detects React framework', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
      dependencies: { react: '^18.0.0', 'react-dom': '^18.0.0' },
    }));

    const result = scanner.scan(tmpDir);
    expect(result.detectedFramework).toBe('react');
  });

  it('scan() detects Express framework', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
      dependencies: { express: '^4.18.0' },
    }));

    const result = scanner.scan(tmpDir);
    expect(result.detectedFramework).toBe('express');
  });

  it('scan() detects Next.js framework (takes priority over react)', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
      dependencies: { next: '14.0.0', react: '^18.0.0' },
    }));

    const result = scanner.scan(tmpDir);
    expect(result.detectedFramework).toBe('nextjs');
  });

  it('scan() empty directory returns null framework and empty skills', () => {
    const result = scanner.scan(tmpDir);
    expect(result.hasClaudeMd).toBe(false);
    expect(result.hasClaudeDir).toBe(false);
    expect(result.skills).toEqual([]);
    expect(result.detectedFramework).toBeNull();
    expect(result.scripts).toBeNull();
  });

  it('scan() throws for non-existent directory', () => {
    expect(() => scanner.scan('/non/existent/path/abc123')).toThrow();
  });

  it('scan() returns correct path', () => {
    const result = scanner.scan(tmpDir);
    expect(result.path).toBe(tmpDir);
  });
});
