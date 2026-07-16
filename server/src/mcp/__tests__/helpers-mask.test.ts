import { describe, it, expect } from 'vitest';
import { maskProjectConfig, maskConnectionString } from '../helpers.js';

describe('maskProjectConfig (also used by GET /api/db/:table for projects rows)', () => {
  it('masks dbConnections password and connectionString passwords', () => {
    const masked = maskProjectConfig({
      dbConnections: [
        { id: 'c1', label: 'main', password: 'hunter2', connectionString: 'Server=x;Password=hunter2;Database=y' },
      ],
    }) as { dbConnections: Array<{ password: string; connectionString: string }> };
    expect(masked.dbConnections[0]!.password).toBe('***');
    expect(masked.dbConnections[0]!.connectionString).not.toContain('hunter2');
    expect(masked.dbConnections[0]!.connectionString).toContain('Password=***');
  });

  it('masks legacy svnConfig.password', () => {
    const masked = maskProjectConfig({
      svnConfig: { frontendSpecPath: 'https://svn/fe', backendSpecPath: 'https://svn/be', password: 'svnsecret' },
    }) as { svnConfig: Record<string, string> };
    expect(masked.svnConfig['password']).toBe('***');
    expect(masked.svnConfig['frontendSpecPath']).toBe('https://svn/fe'); // non-secrets untouched
  });

  it('leaves configs without credentials unchanged and never mutates the input', () => {
    const input = { maxConcurrentAgents: 2, svnConfig: { frontendSpecPath: 'a', backendSpecPath: 'b' } };
    const masked = maskProjectConfig(input);
    expect(masked).toEqual(input);
    const withSecret = { dbConnections: [{ password: 'p' }] };
    maskProjectConfig(withSecret);
    expect(withSecret.dbConnections[0]!.password).toBe('p'); // deep clone, input untouched
  });

  it('handles null / non-object inputs', () => {
    expect(maskProjectConfig(null)).toBeNull();
    expect(maskProjectConfig('str')).toBe('str');
  });

  it('maskConnectionString masks pwd= variants case-insensitively', () => {
    expect(maskConnectionString('server=x;PWD=abc;db=y')).toBe('server=x;PWD=***;db=y');
  });
});
