import { useState, useEffect, useCallback } from 'react';
import { useProjectStore } from '../../stores/projectStore';
import { IconRefresh, IconSearch, IconChevronLeft, IconChevronRight, IconChevronDown } from '../ui/Icons';

interface TableInfo {
  name: string;
  count: number;
}

interface ColumnInfo {
  name: string;
  type: string;
}

interface TableData {
  table: string;
  columns: ColumnInfo[];
  rows: Record<string, unknown>[];
  totalCount: number;
  limit: number;
  offset: number;
}

const ROWS_PER_PAGE = 50;

export function DbExplorer() {
  const currentProjectId = useProjectStore(s => s.currentProjectId);

  const [tables, setTables] = useState<TableInfo[]>([]);
  const [selectedTable, setSelectedTable] = useState('projects');
  const [tableData, setTableData] = useState<TableData | null>(null);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [orderBy, setOrderBy] = useState('');
  const [order, setOrder] = useState<'asc' | 'desc'>('desc');
  const [filterByProject, setFilterByProject] = useState(true);
  const [expandedRow, setExpandedRow] = useState<number | null>(null);

  // Fetch table list
  const fetchTables = useCallback(async () => {
    try {
      const res = await fetch('/api/db/tables');
      if (res.ok) {
        const data = await res.json();
        setTables(data.tables);
      }
    } catch { /* ignore */ }
  }, []);

  // Fetch table data
  const fetchTableData = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        limit: String(ROWS_PER_PAGE),
        offset: String(page * ROWS_PER_PAGE),
        order,
      });
      if (orderBy) params.set('orderBy', orderBy);
      if (search.trim()) params.set('search', search.trim());
      if (filterByProject && currentProjectId) params.set('projectId', currentProjectId);

      const res = await fetch(`/api/db/${selectedTable}?${params}`);
      if (res.ok) {
        const data = await res.json();
        setTableData(data);
      }
    } catch { /* ignore */ }
    setLoading(false);
  }, [selectedTable, page, orderBy, order, search, filterByProject, currentProjectId]);

  useEffect(() => { fetchTables(); }, [fetchTables]);
  useEffect(() => { fetchTableData(); }, [fetchTableData]);

  const totalPages = tableData ? Math.ceil(tableData.totalCount / ROWS_PER_PAGE) : 0;

  const handleSort = (col: string) => {
    if (orderBy === col) {
      setOrder(prev => prev === 'asc' ? 'desc' : 'asc');
    } else {
      setOrderBy(col);
      setOrder('desc');
    }
    setPage(0);
  };

  const handleTableChange = (table: string) => {
    setSelectedTable(table);
    setPage(0);
    setOrderBy('');
    setOrder('desc');
    setSearch('');
    setExpandedRow(null);
  };

  const truncateValue = (val: unknown, maxLen = 80): string => {
    if (val === null || val === undefined) return 'null';
    const str = String(val);
    return str.length > maxLen ? str.substring(0, maxLen) + '...' : str;
  };

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <h2 className="text-xl font-bold">DB Explorer</h2>
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-yellow-500/15 text-yellow-400 font-medium">
            Read-only
          </span>
        </div>
        <button
          onClick={() => { fetchTables(); fetchTableData(); }}
          className="p-2 rounded-md bg-muted border border-border hover:bg-muted/80 transition-colors"
          title="Refresh"
        >
          <IconRefresh className="w-4 h-4 text-muted-foreground" />
        </button>
      </div>

      {/* Controls */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        {/* Table selector */}
        <div className="relative">
          <select
            value={selectedTable}
            onChange={(e) => handleTableChange(e.target.value)}
            className="bg-muted border border-border rounded-md px-3 py-1.5 text-sm appearance-none outline-none focus:border-primary pr-8"
          >
            {tables.map(t => (
              <option key={t.name} value={t.name}>
                {t.name} ({t.count})
              </option>
            ))}
          </select>
          <IconChevronDown className="w-3 h-3 absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
        </div>

        {/* Search */}
        <div className="relative flex-1 max-w-xs">
          <IconSearch className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(0); }}
            placeholder="Search..."
            className="w-full bg-muted border border-border rounded-md pl-8 pr-3 py-1.5 text-sm outline-none focus:border-primary"
          />
        </div>

        {/* Filter by project */}
        {currentProjectId && (
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
            <input
              type="checkbox"
              checked={filterByProject}
              onChange={(e) => { setFilterByProject(e.target.checked); setPage(0); }}
              className="rounded"
            />
            Filter by current project
          </label>
        )}

        {/* Row count */}
        <span className="text-xs text-muted-foreground ml-auto">
          {tableData ? `${tableData.totalCount} rows` : ''}
        </span>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto border border-border rounded-lg">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <span className="text-sm text-muted-foreground animate-pulse">Loading...</span>
          </div>
        ) : tableData && tableData.rows.length > 0 ? (
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-muted/90 backdrop-blur-sm">
              <tr>
                {tableData.columns.map(col => (
                  <th
                    key={col.name}
                    onClick={() => handleSort(col.name)}
                    className="text-left px-3 py-2 font-medium text-muted-foreground cursor-pointer hover:text-foreground transition-colors border-b border-border whitespace-nowrap"
                  >
                    {col.name}
                    {orderBy === col.name && (
                      <span className="ml-1 text-primary">{order === 'asc' ? '\u2191' : '\u2193'}</span>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tableData.rows.map((row, i) => (
                <>
                  <tr
                    key={i}
                    onClick={() => setExpandedRow(expandedRow === i ? null : i)}
                    className={`border-b border-border/50 cursor-pointer transition-colors ${
                      expandedRow === i ? 'bg-primary/5' : 'hover:bg-muted/30'
                    }`}
                  >
                    {tableData.columns.map(col => (
                      <td key={col.name} className="px-3 py-1.5 text-foreground/80 max-w-[200px] truncate" title={String(row[col.name] ?? '')}>
                        {truncateValue(row[col.name], 60)}
                      </td>
                    ))}
                  </tr>
                  {expandedRow === i && (
                    <tr key={`${i}-expanded`}>
                      <td colSpan={tableData.columns.length} className="px-4 py-3 bg-muted/20 border-b border-border">
                        <div className="space-y-1.5">
                          {tableData.columns.map(col => (
                            <div key={col.name} className="flex gap-2">
                              <span className="text-muted-foreground font-medium min-w-[120px] flex-shrink-0">{col.name}:</span>
                              <span className="text-foreground/90 break-all whitespace-pre-wrap">{String(row[col.name] ?? 'null')}</span>
                            </div>
                          ))}
                        </div>
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="flex items-center justify-center py-12">
            <span className="text-sm text-muted-foreground">No data</span>
          </div>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-3">
          <button
            onClick={() => setPage(p => Math.max(0, p - 1))}
            disabled={page === 0}
            className="inline-flex items-center gap-1 px-3 py-1 text-xs rounded bg-muted border border-border hover:bg-muted/80 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <IconChevronLeft className="w-3 h-3" />
            Prev
          </button>
          <span className="text-xs text-muted-foreground">
            Page {page + 1} of {totalPages} ({ROWS_PER_PAGE} rows/page)
          </span>
          <button
            onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
            disabled={page >= totalPages - 1}
            className="inline-flex items-center gap-1 px-3 py-1 text-xs rounded bg-muted border border-border hover:bg-muted/80 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Next
            <IconChevronRight className="w-3 h-3" />
          </button>
        </div>
      )}
    </div>
  );
}
