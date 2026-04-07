import { useState, useMemo, useCallback, useEffect } from 'react';
import { useProjectStore } from '../../stores/projectStore';
import { useSchemaStore } from '../../stores/schemaStore';
import { IconSearch, IconRefresh } from '../ui/Icons';
import MermaidRenderer from './MermaidRenderer';
import type { DbConnectionConfig, DbSchemaColumn, DbSchemaResult, DbSchemaTable } from '@omni/shared';

// ─── DbConnectionCards ──────────────────────────────────────────────────────

const DB_TYPE_META: Record<string, { label: string; badge: string; text: string }> = {
  postgresql: { label: 'PostgreSQL', badge: 'PG', text: 'bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-400' },
  mysql:      { label: 'MySQL',      badge: 'My', text: 'bg-orange-100 text-orange-700 dark:bg-orange-500/20 dark:text-orange-400' },
  mssql:      { label: 'MSSQL',      badge: 'MS', text: 'bg-gray-100 text-gray-600 dark:bg-gray-500/20 dark:text-gray-400' },
};

function DbTypeIcon({ dbType }: { dbType: string }) {
  const meta = DB_TYPE_META[dbType] ?? { label: dbType, badge: '?', text: 'bg-muted text-muted-foreground' };
  return (
    <span className={`inline-flex items-center justify-center w-8 h-8 rounded-md text-xs font-bold flex-shrink-0 ${meta.text}`}>
      {meta.badge}
    </span>
  );
}

interface DbConnectionCardsProps {
  connections: DbConnectionConfig[];
  activeId: string | null;
  loading: Record<string, boolean>;
  errors: Record<string, string>;
  schemas: Record<string, DbSchemaResult>;
  onSelect: (id: string) => void;
  onFetch: (conn: DbConnectionConfig) => void;
}

function DbConnectionCards({ connections, activeId, loading, errors, schemas, onSelect, onFetch }: DbConnectionCardsProps) {
  return (
    <div className="flex gap-2 overflow-x-auto pb-1 flex-wrap">
      {connections.map((conn) => {
        const isActive = activeId === conn.id;
        const isLoading = loading[conn.id];
        const error = errors[conn.id];
        const schema = schemas[conn.id];
        const meta = DB_TYPE_META[conn.dbType] ?? { label: conn.dbType, badge: '?', text: 'bg-muted text-muted-foreground' };

        return (
          <div
            key={conn.id}
            onClick={() => onSelect(conn.id)}
            className={`flex-shrink-0 flex items-center gap-3 rounded-lg px-4 py-3 cursor-pointer transition-all border ${
              isActive
                ? 'bg-primary/5 border-primary/40 ring-1 ring-primary/30'
                : 'bg-card border-border hover:border-primary/30 hover:bg-muted/40'
            }`}
          >
            {/* DB type badge */}
            <span className={`inline-flex items-center justify-center w-8 h-8 rounded-md text-xs font-bold flex-shrink-0 ${meta.text}`}>
              {meta.badge}
            </span>

            {/* Label + type */}
            <div className="min-w-0">
              <div className="text-sm font-medium leading-tight truncate max-w-[140px]">{conn.label}</div>
              <div className="text-[11px] text-muted-foreground mt-1 flex items-center gap-1">
                <span>{meta.label}</span>
                {schema && <span className="text-primary/60">· {schema.tables.length} tables</span>}
              </div>
            </div>

            {/* Fetch button */}
            <button
              onClick={(e) => { e.stopPropagation(); onFetch(conn); }}
              disabled={isLoading}
              className={`flex-shrink-0 inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded-md font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                isActive
                  ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                  : 'bg-muted border border-border hover:bg-muted/80 text-foreground'
              }`}
            >
              <IconRefresh className={`w-3 h-3 ${isLoading ? 'animate-spin' : ''}`} />
              {isLoading ? 'Fetching…' : schema ? 'Refresh' : 'Fetch'}
            </button>

            {error && (
              <span className="text-[10px] text-red-500 truncate max-w-[120px]" title={error}>⚠ {error}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── SchemaTableList ────────────────────────────────────────────────────────

interface SchemaTableListProps {
  tables: DbSchemaTable[];
  columns: DbSchemaColumn[];
  selectedTable: string | null;
  onSelect: (name: string) => void;
}

function SchemaTableList({ tables, columns, selectedTable, onSelect }: SchemaTableListProps) {
  const [search, setSearch] = useState('');

  const filteredTables = useMemo(() => {
    if (!search.trim()) return tables;
    const q = search.toLowerCase();
    return tables.filter((t) => t.name.toLowerCase().includes(q));
  }, [tables, search]);

  const columnCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const col of columns) {
      counts[col.tableName] = (counts[col.tableName] || 0) + 1;
    }
    return counts;
  }, [columns]);

  return (
    <div className="flex flex-col h-full border-r border-border">
      {/* Search */}
      <div className="p-2 border-b border-border">
        <div className="relative">
          <IconSearch className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search tables..."
            className="w-full bg-muted border border-border rounded-md pl-7 pr-2 py-1.5 text-xs outline-none focus:border-primary"
          />
        </div>
      </div>

      {/* Table list */}
      <div className="flex-1 overflow-y-auto">
        {filteredTables.map((table) => (
          <button
            key={table.name}
            onClick={() => onSelect(table.name)}
            className={`w-full text-left px-3 py-2 text-xs flex items-center justify-between transition-colors ${
              selectedTable === table.name
                ? 'bg-primary/10 text-primary font-medium'
                : 'hover:bg-muted/50 text-foreground'
            }`}
          >
            <span className="truncate">{table.name}</span>
            <span className="text-[10px] text-muted-foreground ml-2 flex-shrink-0">
              ({columnCounts[table.name] || 0})
            </span>
          </button>
        ))}
        {filteredTables.length === 0 && (
          <div className="p-4 text-xs text-muted-foreground text-center">No tables found</div>
        )}
      </div>
    </div>
  );
}

// ─── SchemaColumnDetail ─────────────────────────────────────────────────────

interface SchemaColumnDetailProps {
  tableName: string;
  columns: DbSchemaColumn[];
  onNavigateToTable: (tableName: string) => void;
}

function SchemaColumnDetail({ tableName, columns, onNavigateToTable }: SchemaColumnDetailProps) {
  const tableColumns = useMemo(
    () => columns.filter((c) => c.tableName === tableName).sort((a, b) => a.ordinalPosition - b.ordinalPosition),
    [columns, tableName]
  );

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-border">
        <h3 className="text-sm font-semibold">{tableName}</h3>
        <span className="text-[10px] text-muted-foreground">{tableColumns.length} columns</span>
      </div>

      <div className="flex-1 overflow-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-muted/90 backdrop-blur-sm">
            <tr>
              <th className="text-left px-3 py-2 font-medium text-muted-foreground border-b border-border">Column</th>
              <th className="text-left px-3 py-2 font-medium text-muted-foreground border-b border-border">Type</th>
              <th className="text-left px-3 py-2 font-medium text-muted-foreground border-b border-border">Nullable</th>
              <th className="text-left px-3 py-2 font-medium text-muted-foreground border-b border-border">Default</th>
              <th className="text-left px-3 py-2 font-medium text-muted-foreground border-b border-border">Flags</th>
              <th className="text-left px-3 py-2 font-medium text-muted-foreground border-b border-border">Comment</th>
            </tr>
          </thead>
          <tbody>
            {tableColumns.map((col) => (
              <tr key={col.columnName} className="border-b border-border/50 hover:bg-muted/30 transition-colors">
                <td className="px-3 py-2 font-medium text-foreground">{col.columnName}</td>
                <td className="px-3 py-2 text-muted-foreground font-mono">{col.dataType}</td>
                <td className="px-3 py-2 text-muted-foreground">{col.isNullable ? 'YES' : 'NO'}</td>
                <td className="px-3 py-2 text-muted-foreground font-mono truncate max-w-[120px]" title={col.defaultValue ?? ''}>
                  {col.defaultValue ?? '-'}
                </td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-1 flex-wrap">
                    {col.isPrimaryKey && (
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-500/15 text-amber-600 border border-amber-500/30">
                        PK
                      </span>
                    )}
                    {col.isForeignKey && (
                      <span
                        onClick={() => col.referencedTable && onNavigateToTable(col.referencedTable)}
                        className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-500/15 text-blue-600 border border-blue-500/30 cursor-pointer hover:bg-blue-500/25 transition-colors"
                        title={col.referencedTable ? `Go to ${col.referencedTable}.${col.referencedColumn}` : ''}
                      >
                        FK → {col.referencedTable}
                      </span>
                    )}
                  </div>
                </td>
                <td className="px-3 py-2 text-muted-foreground truncate max-w-[160px]" title={col.comment ?? ''}>
                  {col.comment ?? '-'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── DbSchemaExplorer (Main) ────────────────────────────────────────────────

export function DbSchemaExplorer() {
  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const project = useProjectStore((s) => s.projects.find((p) => p.id === s.currentProjectId));

  const activeConnectionId = useSchemaStore((s) => s.activeConnectionId);
  const schemas = useSchemaStore((s) => s.schemas);
  const selectedTable = useSchemaStore((s) => s.selectedTable);
  const loading = useSchemaStore((s) => s.loading);
  const errors = useSchemaStore((s) => s.errors);
  const setActiveConnection = useSchemaStore((s) => s.setActiveConnection);
  const setSelectedTable = useSchemaStore((s) => s.setSelectedTable);
  const setSchema = useSchemaStore((s) => s.setSchema);
  const setLoading = useSchemaStore((s) => s.setLoading);
  const setError = useSchemaStore((s) => s.setError);
  const clearError = useSchemaStore((s) => s.clearError);

  const [activeTab, setActiveTab] = useState<'schema' | 'er'>('schema');
  const [erFocusTable, setErFocusTable] = useState<string>('');
  const [erContent, setErContent] = useState<string | null>(null);
  const [erLoading, setErLoading] = useState(false);
  const [erError, setErError] = useState<string | null>(null);

  // Parse dbConnections from project configJson
  const dbConnections: DbConnectionConfig[] = useMemo(() => {
    if (!project?.configJson) return [];
    try {
      const config = JSON.parse(project.configJson);
      return (config?.dbConnections as DbConnectionConfig[]) ?? [];
    } catch {
      return [];
    }
  }, [project?.configJson]);

  // Active schema data
  const activeSchema = activeConnectionId ? schemas[activeConnectionId] : null;

  // Fetch ER diagram when switching to ER tab or changing table/mode
  useEffect(() => {
    if (activeTab !== 'er' || !activeConnectionId || !activeSchema || !currentProjectId) return;
    const tableParam = erFocusTable ? `?table=${encodeURIComponent(erFocusTable)}` : '';
    let cancelled = false;
    setErLoading(true);
    setErError(null);
    fetch(`/api/schema/${currentProjectId}/${activeConnectionId}/er-diagram${tableParam}`)
      .then(r => r.json())
      .then(data => {
        if (cancelled) return;
        if (data.error) throw new Error(data.error);
        setErContent(data.mermaid);
      })
      .catch(e => { if (!cancelled) setErError((e as Error).message); })
      .finally(() => { if (!cancelled) setErLoading(false); });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, activeConnectionId, activeSchema, erFocusTable, currentProjectId]);

  // Reset ER state when connection changes
  useEffect(() => {
    setErContent(null);
    setErError(null);
    setErFocusTable('');
  }, [activeConnectionId]);

  // Fetch schema handler
  const handleFetchSchema = useCallback(
    async (conn: DbConnectionConfig) => {
      if (!currentProjectId) return;
      setLoading(conn.id, true);
      clearError(conn.id);

      try {
        const res = await fetch(`/api/schema/${currentProjectId}/${conn.id}/fetch`, { method: 'POST' });
        if (!res.ok) {
          const body = await res.json().catch(() => ({ error: 'Fetch failed' }));
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        const data = await res.json();
        setSchema(conn.id, data.result);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        setError(conn.id, msg);
      } finally {
        setLoading(conn.id, false);
      }
    },
    [currentProjectId, setLoading, clearError, setSchema, setError]
  );

  // Navigate to a table (from FK click)
  const handleNavigateToTable = useCallback(
    (tableName: string) => {
      setSelectedTable(tableName);
    },
    [setSelectedTable]
  );

  // ─── Empty states ───────────────────────────────────────────────────────

  if (dbConnections.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-muted-foreground">
        <svg className="w-12 h-12 mb-3 opacity-40" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <ellipse cx="12" cy="6" rx="8" ry="3" />
          <path d="M4 6v6c0 1.657 3.582 3 8 3s8-1.343 8-3V6" />
          <path d="M4 12v6c0 1.657 3.582 3 8 3s8-1.343 8-3v-6" />
        </svg>
        <p className="text-sm font-medium mb-1">No database connections</p>
        <p className="text-xs">Configure DB connections in Project Settings</p>
      </div>
    );
  }

  // ─── Render ─────────────────────────────────────────────────────────────

  return (
    <div className="h-full flex flex-col gap-4">
      {/* Connection Cards */}
      <DbConnectionCards
        connections={dbConnections}
        activeId={activeConnectionId}
        loading={loading}
        errors={errors}
        schemas={schemas}
        onSelect={(id) => setActiveConnection(id)}
        onFetch={handleFetchSchema}
      />

      {/* Content area */}
      {!activeConnectionId ? (
        <div className="flex-1 flex items-center justify-center text-muted-foreground">
          <p className="text-sm">Select a connection above to view its schema</p>
        </div>
      ) : !activeSchema ? (
        <div className="flex-1 flex items-center justify-center text-muted-foreground">
          <div className="text-center">
            <p className="text-sm font-medium mb-1">Schema not loaded</p>
            <p className="text-xs">Click &quot;Fetch Schema&quot; to load database structure</p>
          </div>
        </div>
      ) : (
        <>
          {/* Tabs */}
          <div className="flex gap-1 border-b border-border">
            <button
              onClick={() => setActiveTab('schema')}
              className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 ${
                activeTab === 'schema'
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              DB Schema
            </button>
            <button
              onClick={() => setActiveTab('er')}
              className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 ${
                activeTab === 'er'
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              ER Diagram
            </button>
          </div>

          {/* Tab content */}
          <div className="flex-1 min-h-0">
            {activeTab === 'schema' ? (
              <div className="h-full flex border border-border rounded-lg overflow-hidden">
                {/* Left: Table list */}
                <div className="w-56 flex-shrink-0">
                  <SchemaTableList
                    tables={activeSchema.tables}
                    columns={activeSchema.columns}
                    selectedTable={selectedTable}
                    onSelect={setSelectedTable}
                  />
                </div>

                {/* Right: Column detail */}
                <div className="flex-1 min-w-0">
                  {selectedTable ? (
                    <SchemaColumnDetail
                      tableName={selectedTable}
                      columns={activeSchema.columns}
                      onNavigateToTable={handleNavigateToTable}
                    />
                  ) : (
                    <div className="h-full flex items-center justify-center text-muted-foreground">
                      <p className="text-sm">Select a table to view columns</p>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              /* ER Diagram tab */
              <div className="h-full flex border border-border rounded-lg overflow-hidden">
                {/* Left: table list */}
                <div className="w-48 flex-shrink-0 flex flex-col border-r border-border">
                  <div className="px-3 py-2 border-b border-border">
                    <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Focus Table</span>
                  </div>
                  <div className="flex-1 overflow-y-auto">
                    <button
                      onClick={() => setErFocusTable('')}
                      className={`w-full text-left px-3 py-2 text-xs flex items-center gap-1.5 transition-colors ${
                        erFocusTable === ''
                          ? 'bg-primary/10 text-primary font-medium'
                          : 'hover:bg-muted/50 text-foreground'
                      }`}
                    >
                      <span className="text-muted-foreground text-[10px]">◈</span> All tables
                    </button>
                    {activeSchema.tables.map(t => (
                      <button
                        key={t.name}
                        onClick={() => setErFocusTable(t.name)}
                        className={`w-full text-left px-3 py-2 text-xs transition-colors truncate ${
                          erFocusTable === t.name
                            ? 'bg-primary/10 text-primary font-medium'
                            : 'hover:bg-muted/50 text-foreground'
                        }`}
                      >
                        {t.name}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Right: diagram */}
                <div className="flex-1 min-w-0 relative">
                  {erLoading && (
                    <div className="absolute inset-0 flex items-center justify-center bg-background/60 z-10">
                      <span className="text-xs text-muted-foreground flex items-center gap-1.5">
                        <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
                        Generating…
                      </span>
                    </div>
                  )}
                  {erError ? (
                    <div className="h-full flex items-center justify-center">
                      <div className="text-sm text-red-500 bg-red-500/10 px-4 py-3 rounded-lg">{erError}</div>
                    </div>
                  ) : erContent ? (
                    <MermaidRenderer
                      content={erContent}
                      height="100%"
                      filename={`${activeConnectionId}-${erFocusTable || 'full'}-er-diagram.png`}
                    />
                  ) : !erLoading ? (
                    <div className="h-full flex items-center justify-center text-muted-foreground">
                      <p className="text-sm">Loading diagram…</p>
                    </div>
                  ) : null}
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
