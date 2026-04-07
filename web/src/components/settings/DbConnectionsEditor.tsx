import { useState } from 'react';
import type { DbConnectionConfig } from '@omni/shared';
import { DbConnectionModal } from './DbConnectionModal';

interface DbConnectionsEditorProps {
  connections: DbConnectionConfig[];
  onChange: (connections: DbConnectionConfig[]) => void;
}

const DB_TYPE_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  postgresql: { bg: 'bg-blue-100 text-blue-700', text: 'text-blue-600', label: 'PostgreSQL' },
  mysql: { bg: 'bg-orange-100 text-orange-700', text: 'text-orange-600', label: 'MySQL' },
  mssql: { bg: 'bg-gray-100 text-gray-700', text: 'text-gray-600', label: 'MSSQL' },
};

function maskConnectionString(conn: DbConnectionConfig): string {
  try {
    if (conn.dbType === 'mssql') {
      // Server=host,port;Database=db;...
      const serverMatch = conn.connectionString.match(/Server=([^;]+)/i);
      const dbMatch = conn.connectionString.match(/Database=([^;]+)/i);
      return `${serverMatch?.[1] || '?'}/${dbMatch?.[1] || '?'}`;
    }
    const url = new URL(conn.connectionString);
    return `${url.hostname}:${url.port}/${url.pathname.slice(1)}`;
  } catch {
    return '***';
  }
}

export function DbConnectionsEditor({ connections, onChange }: DbConnectionsEditorProps) {
  const [modalOpen, setModalOpen] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [deleteConfirmIndex, setDeleteConfirmIndex] = useState<number | null>(null);

  const handleAdd = () => {
    setEditingIndex(null);
    setModalOpen(true);
  };

  const handleEdit = (index: number) => {
    setEditingIndex(index);
    setModalOpen(true);
  };

  const handleSave = (conn: DbConnectionConfig) => {
    if (editingIndex !== null) {
      const updated = [...connections];
      updated[editingIndex] = conn;
      onChange(updated);
    } else {
      onChange([...connections, conn]);
    }
    setModalOpen(false);
    setEditingIndex(null);
  };

  const handleDelete = (index: number) => {
    const updated = connections.filter((_, i) => i !== index);
    onChange(updated);
    setDeleteConfirmIndex(null);
  };

  return (
    <div className="border border-border rounded-lg p-4 space-y-3">
      <div className="flex items-center gap-2">
        <svg className="w-4 h-4 text-blue-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <ellipse cx="12" cy="5" rx="9" ry="3" />
          <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
          <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
        </svg>
        <h4 className="text-sm font-medium">Database Connections</h4>
      </div>
      <p className="text-xs text-muted-foreground">
        Configure database connections for backend agents to perform DB operations (schema introspection, queries, etc.).
      </p>

      {/* Connection list */}
      {connections.length > 0 && (
        <div className="space-y-2">
          {connections.map((conn, index) => {
            const style = DB_TYPE_STYLES[conn.dbType] || DB_TYPE_STYLES.mssql;
            return (
              <div
                key={conn.id}
                className="flex items-center gap-3 bg-muted rounded-md px-3 py-2"
              >
                <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${style.bg}`}>
                  {style.label}
                </span>
                <span className="text-sm font-medium truncate min-w-0">
                  {conn.label}
                </span>
                <span className="text-xs text-muted-foreground font-mono truncate min-w-0 flex-1">
                  {maskConnectionString(conn)}
                </span>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => handleEdit(index)}
                    className="px-2 py-1 text-xs rounded-md border border-border hover:bg-background transition-colors"
                  >
                    Edit
                  </button>
                  {deleteConfirmIndex === index ? (
                    <div className="flex items-center gap-1 relative z-20">
                      <button
                        onClick={() => handleDelete(index)}
                        className="px-2 py-1 text-xs rounded-md bg-red-500 text-white hover:bg-red-600 transition-colors"
                      >
                        Confirm
                      </button>
                      <button
                        onClick={() => setDeleteConfirmIndex(null)}
                        className="px-2 py-1 text-xs rounded-md border border-border hover:bg-background transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setDeleteConfirmIndex(index)}
                      className="px-2 py-1 text-xs rounded-md border border-border text-red-500 hover:bg-red-50 transition-colors"
                    >
                      Delete
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Add button */}
      <button
        onClick={handleAdd}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-dashed border-border text-muted-foreground hover:text-foreground hover:border-primary/50 transition-colors"
      >
        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
        Add Connection
      </button>

      {/* Modal */}
      {modalOpen && (
        <DbConnectionModal
          connection={editingIndex !== null ? connections[editingIndex] : undefined}
          onSave={handleSave}
          onClose={() => {
            setModalOpen(false);
            setEditingIndex(null);
          }}
        />
      )}
    </div>
  );
}
