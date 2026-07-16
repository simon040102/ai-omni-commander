import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Regression guard for the SVN credential leak: SpecFetcher used to put
 * `--password "<secret>"` on argv (visible in process lists) and shell out via
 * execSync, whose thrown err.message embeds the full command line — leaking
 * the password into logs. It must now use SvnSpecService's runCommand (spawn
 * array args) + buildSvnAuth (--password-from-stdin).
 */
describe('SpecFetcher — SVN credential hygiene (source assertions)', () => {
  const srcPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'SpecFetcher.ts');
  const src = fs.readFileSync(srcPath, 'utf-8');

  it('never puts --password/--username values on argv', () => {
    expect(src).not.toMatch(/--password\s*["'`]/);
    expect(src).not.toMatch(/--password"/);
    expect(src).not.toMatch(/push\(`--password/);
    expect(src).not.toMatch(/push\(`--username/);
  });

  it('uses buildSvnAuth (stdin password) + runCommand (spawn array args) for svn', () => {
    expect(src).toContain('buildSvnAuth');
    expect(src).toContain('runCommand');
  });

  it('no shell execSync of svn subcommands (only the credential-free svn path lookup remains)', () => {
    // Shell-quoted svn invocations looked like: execSync(`"${svn}" info "${url}" ...`)
    expect(src).not.toMatch(/execSync\(`"\$\{svn\}"/);
    expect(src).not.toMatch(/execSync\([^)]*info/);
    expect(src).not.toMatch(/execSync\([^)]*export/);
    expect(src).not.toMatch(/execSync\([^)]*list -R/);
    // The remaining execSync usages must all be the `where svn` / `which svn` lookup
    const execSyncUses = src.match(/execSync\(/g) || [];
    expect(execSyncUses.length).toBe(1); // the credential-free `where svn` lookup is the only call
  });

  it('does not import raw SVN credentials directly', () => {
    expect(src).not.toContain('getSvnCredentials');
  });
});
