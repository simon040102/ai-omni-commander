import { useState, useEffect, useCallback } from 'react';
import type { DbConnectionConfig, DbType } from '@omni/shared';
import { DB_DEFAULT_PORTS } from '@omni/shared';

interface DbConnectionModalProps {
  connection?: DbConnectionConfig;
  onSave: (connection: DbConnectionConfig) => void;
  onClose: () => void;
}

interface Fields {
  host: string;
  port: string;
  database: string;
  username: string;
  password: string;
}

const DB_TYPES: { type: DbType; label: string; color: string }[] = [
  { type: 'postgresql', label: 'PostgreSQL', color: 'bg-blue-500/15 text-blue-600 border-blue-500/30' },
  { type: 'mysql', label: 'MySQL', color: 'bg-orange-500/15 text-orange-600 border-orange-500/30' },
  { type: 'mssql', label: 'MSSQL', color: 'bg-gray-500/15 text-gray-400 border-gray-500/30' },
];

function parseConnectionString(str: string, dbType: DbType): Fields {
  try {
    if (dbType === 'mssql') {
      // JDBC format: jdbc:sqlserver://host[:port];databaseName=db;user=u;password=p;...
      if (/^jdbc:sqlserver:\/\//i.test(str)) {
        const rest = str.replace(/^jdbc:sqlserver:\/\//i, '');
        const semiIdx = rest.indexOf(';');
        const hostPart = semiIdx >= 0 ? rest.slice(0, semiIdx) : rest;
        const propStr = semiIdx >= 0 ? rest.slice(semiIdx + 1) : '';
        const props: Record<string, string> = {};
        for (const seg of propStr.split(';')) {
          const eq = seg.indexOf('=');
          if (eq >= 0) props[seg.slice(0, eq).toLowerCase().trim()] = seg.slice(eq + 1).trim();
        }
        const colonIdx = hostPart.lastIndexOf(':');
        let host = hostPart;
        let port = String(props['portnumber'] || DB_DEFAULT_PORTS.mssql);
        if (colonIdx >= 0 && /^\d+$/.test(hostPart.slice(colonIdx + 1))) {
          host = hostPart.slice(0, colonIdx);
          port = hostPart.slice(colonIdx + 1);
        }
        return {
          host,
          port,
          database: props['databasename'] || props['database'] || '',
          username: props['user'] || props['username'] || props['userid'] || props['user id'] || '',
          password: props['password'] || '',
        };
      }
      // ADO.NET format: Server=host,port;Database=db;User Id=user;Password=pass;
      const server = str.match(/Server=([^;,]+)[,;]?(\d+)?/i);
      const db = str.match(/Database=([^;]+)/i);
      const user = str.match(/User\s*Id=([^;]+)/i);
      const pass = str.match(/Password=([^;]+)/i);
      const port = server?.[2] || str.match(/[,;](\d+)/)?.[1] || '';
      return {
        host: server?.[1] || '',
        port: port || String(DB_DEFAULT_PORTS.mssql),
        database: db?.[1] || '',
        username: user?.[1] || '',
        password: pass?.[1] || '',
      };
    }
    const url = new URL(str);
    return {
      host: url.hostname,
      port: url.port || String(DB_DEFAULT_PORTS[dbType]),
      database: url.pathname.slice(1),
      username: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
    };
  } catch {
    return { host: '', port: String(DB_DEFAULT_PORTS[dbType]), database: '', username: '', password: '' };
  }
}

function buildConnectionString(fields: Fields, dbType: DbType): string {
  if (dbType === 'mssql') {
    const parts = [`Server=${fields.host}`];
    if (fields.port && fields.port !== '1433') parts[0] += `,${fields.port}`;
    parts.push(`Database=${fields.database}`);
    parts.push(`User Id=${fields.username}`);
    parts.push(`Password=${fields.password}`);
    return parts.join(';') + ';';
  }
  const pass = fields.password ? `:${encodeURIComponent(fields.password)}` : '';
  const user = fields.username ? `${encodeURIComponent(fields.username)}${pass}@` : '';
  const port = fields.port ? `:${fields.port}` : '';
  return `${dbType}://${user}${fields.host}${port}/${fields.database}`;
}

export function DbConnectionModal({ connection, onSave, onClose }: DbConnectionModalProps) {
  const [dbType, setDbType] = useState<DbType>(connection?.dbType || 'postgresql');
  const [label, setLabel] = useState(connection?.label || '');
  const [connStr, setConnStr] = useState(connection?.connectionString || '');
  const [fields, setFields] = useState<Fields>(() =>
    connection ? parseConnectionString(connection.connectionString, connection.dbType) : {
      host: 'localhost', port: String(DB_DEFAULT_PORTS['postgresql']), database: '', username: '', password: '',
    }
  );
  const [inputMode, setInputMode] = useState<'string' | 'fields'>('fields');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; error?: string } | null>(null);

  // Sync connStr → fields when in string mode
  const syncFromString = useCallback((str: string) => {
    setConnStr(str);
    setFields(parseConnectionString(str, dbType));
  }, [dbType]);

  // Sync fields → connStr when in fields mode
  const syncFromFields = useCallback((f: Fields) => {
    setFields(f);
    setConnStr(buildConnectionString(f, dbType));
  }, [dbType]);

  // When dbType changes, update port and rebuild string
  useEffect(() => {
    setFields(f => {
      const updated = { ...f, port: String(DB_DEFAULT_PORTS[dbType]) };
      setConnStr(buildConnectionString(updated, dbType));
      return updated;
    });
    setTestResult(null);
  }, [dbType]);

  const handleTestConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch('/api/schema/test-connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectionString: connStr, dbType }),
      });
      const data = await res.json();
      setTestResult(data);
    } catch (err) {
      setTestResult({ success: false, error: (err as Error).message });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = () => {
    onSave({
      id: connection?.id || crypto.randomUUID(),
      label: label.trim() || `${dbType} connection`,
      connectionString: connStr,
      dbType,
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-lg p-6 space-y-4" onClick={e => e.stopPropagation()}>
        <h3 className="text-lg font-semibold">{connection ? 'Edit Connection' : 'New Connection'}</h3>

        {/* DB Type */}
        <div>
          <label className="block text-xs text-muted-foreground mb-2">Database Type</label>
          <div className="flex gap-2">
            {DB_TYPES.map(({ type, label: l, color }) => (
              <button
                key={type}
                onClick={() => setDbType(type)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                  dbType === type ? `${color} ring-2 ring-primary` : 'bg-muted border-border text-muted-foreground hover:text-foreground'
                }`}
              >
                {l}
              </button>
            ))}
          </div>
        </div>

        {/* Input Mode Tabs */}
        <div>
          <div className="flex gap-1 mb-3">
            <button
              onClick={() => setInputMode('fields')}
              className={`px-3 py-1 rounded text-xs font-medium transition-colors ${inputMode === 'fields' ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}
            >
              Field Input
            </button>
            <button
              onClick={() => setInputMode('string')}
              className={`px-3 py-1 rounded text-xs font-medium transition-colors ${inputMode === 'string' ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}
            >
              Connection String
            </button>
          </div>

          {inputMode === 'fields' ? (
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <label className="block text-xs text-muted-foreground mb-1">Host</label>
                <input value={fields.host} onChange={e => syncFromFields({ ...fields, host: e.target.value })}
                  className="w-full bg-muted border border-border rounded-md px-3 py-2 text-sm outline-none focus:border-primary" placeholder="localhost" />
              </div>
              <div>
                <label className="block text-xs text-muted-foreground mb-1">Port</label>
                <input value={fields.port} onChange={e => syncFromFields({ ...fields, port: e.target.value })}
                  className="w-full bg-muted border border-border rounded-md px-3 py-2 text-sm outline-none focus:border-primary" placeholder={String(DB_DEFAULT_PORTS[dbType])} />
              </div>
              <div>
                <label className="block text-xs text-muted-foreground mb-1">Database</label>
                <input value={fields.database} onChange={e => syncFromFields({ ...fields, database: e.target.value })}
                  className="w-full bg-muted border border-border rounded-md px-3 py-2 text-sm outline-none focus:border-primary" placeholder="mydb" />
              </div>
              <div>
                <label className="block text-xs text-muted-foreground mb-1">Username</label>
                <input value={fields.username} onChange={e => syncFromFields({ ...fields, username: e.target.value })}
                  className="w-full bg-muted border border-border rounded-md px-3 py-2 text-sm outline-none focus:border-primary" placeholder="user" />
              </div>
              <div>
                <label className="block text-xs text-muted-foreground mb-1">Password</label>
                <input type="password" value={fields.password} onChange={e => syncFromFields({ ...fields, password: e.target.value })}
                  className="w-full bg-muted border border-border rounded-md px-3 py-2 text-sm outline-none focus:border-primary" placeholder="••••••" />
              </div>
            </div>
          ) : (
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Connection String</label>
              <textarea
                value={connStr}
                onChange={e => syncFromString(e.target.value)}
                rows={3}
                className="w-full bg-muted border border-border rounded-md px-3 py-2 text-sm font-mono outline-none focus:border-primary resize-y"
                placeholder={dbType === 'mssql' ? 'Server=host,1433;Database=mydb;User Id=user;Password=pass;' : `${dbType}://user:pass@host:${DB_DEFAULT_PORTS[dbType]}/mydb`}
              />
            </div>
          )}
        </div>

        {/* Label */}
        <div>
          <label className="block text-xs text-muted-foreground mb-1">Connection Name</label>
          <input value={label} onChange={e => setLabel(e.target.value)}
            className="w-full bg-muted border border-border rounded-md px-3 py-2 text-sm outline-none focus:border-primary" placeholder="e.g. Production DB" />
        </div>

        {/* Test Result */}
        {testResult && (
          <div className={`text-xs px-3 py-2 rounded-lg ${testResult.success ? 'bg-green-500/10 text-green-500' : 'bg-red-500/10 text-red-500'}`}>
            {testResult.success ? 'Connection successful!' : `Failed: ${testResult.error}`}
          </div>
        )}

        {/* Buttons */}
        <div className="flex gap-2 justify-end pt-2">
          <button onClick={handleTestConnection} disabled={!connStr.trim() || testing}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-muted text-muted-foreground hover:text-foreground disabled:opacity-40 transition-colors">
            {testing ? 'Testing...' : 'Test Connection'}
          </button>
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm font-medium bg-muted text-muted-foreground hover:text-foreground transition-colors">
            Cancel
          </button>
          <button onClick={handleSave} disabled={!connStr.trim()}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40 transition-colors">
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
