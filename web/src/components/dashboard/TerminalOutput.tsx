import { useEffect, useRef, useState, useMemo } from 'react';
import type { AgentOutput } from '../../stores/agentStore';

const STREAM_COLORS: Record<string, string> = {
  text: 'text-gray-200',
  tool_use: 'text-cyan-400',
  tool_result: 'text-gray-500',
  error: 'text-red-400',
  system: 'text-yellow-400',
};

const STREAM_LABELS: Record<string, string> = {
  text: '',
  tool_use: '',
  tool_result: '',
  error: 'ERR ',
  system: 'SYS ',
};

interface TerminalOutputProps {
  outputs: AgentOutput[];
  title: string;
  role?: string;
  status?: string;
  agentId?: string;
  onSendCommand?: (agentId: string, command: string) => void;
  onAction?: (agentId: string, action: 'stop' | 'restart') => void;
}

export function TerminalOutput({ outputs, title, role, status, agentId, onSendCommand, onAction }: TerminalOutputProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const [commandInput, setCommandInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const [filterType, setFilterType] = useState<string | null>(null);

  useEffect(() => {
    if (autoScrollRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [outputs.length]);

  const handleScroll = () => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    autoScrollRef.current = scrollHeight - scrollTop - clientHeight < 50;
  };

  // Filter and search outputs
  const filteredOutputs = useMemo(() => {
    let result = outputs;
    if (filterType) {
      result = result.filter(o => o.streamType === filterType);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(o => o.content.toLowerCase().includes(q));
    }
    return result;
  }, [outputs, filterType, searchQuery]);

  const toolCount = outputs.filter(o => o.streamType === 'tool_use').length;
  const errorCount = outputs.filter(o => o.streamType === 'error').length;

  return (
    <div className="flex flex-col h-full border border-border rounded-lg overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-card border-b border-border">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm font-bold">{title}</span>
          {role && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-secondary text-secondary-foreground">
              {role}
            </span>
          )}
          <span className="text-[10px] text-muted-foreground">
            {outputs.length} lines
            {toolCount > 0 && ` | ${toolCount} tools`}
            {errorCount > 0 && ` | ${errorCount} errors`}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          {/* Search toggle */}
          <button
            onClick={() => { setShowSearch(!showSearch); if (showSearch) setSearchQuery(''); }}
            className={`px-1.5 py-0.5 rounded text-[10px] transition-colors ${
              showSearch ? 'bg-primary/20 text-primary' : 'text-muted-foreground hover:text-foreground'
            }`}
            title="Search output"
          >
            &#x1F50D;
          </button>
          {/* Filter buttons */}
          {(['text', 'tool_use', 'error'] as const).map(type => (
            <button
              key={type}
              onClick={() => setFilterType(filterType === type ? null : type)}
              className={`px-1.5 py-0.5 rounded text-[10px] transition-colors ${
                filterType === type
                  ? `${STREAM_COLORS[type]} bg-current/10`
                  : 'text-muted-foreground/50 hover:text-muted-foreground'
              }`}
              title={`Filter ${type}`}
            >
              {type === 'text' ? 'TXT' : type === 'tool_use' ? 'TOOL' : 'ERR'}
            </button>
          ))}
          {/* Agent actions */}
          {agentId && onAction && status === 'running' && (
            <button
              onClick={() => onAction(agentId, 'stop')}
              className="px-1.5 py-0.5 rounded text-[10px] text-red-400 hover:bg-red-500/20 transition-colors"
              title="Stop agent"
            >
              &#9632;
            </button>
          )}
          {agentId && onAction && (status === 'stopped' || status === 'error') && (
            <button
              onClick={() => onAction(agentId, 'restart')}
              className="px-1.5 py-0.5 rounded text-[10px] text-green-400 hover:bg-green-500/20 transition-colors"
              title="Restart agent"
            >
              &#x21BB;
            </button>
          )}
          {/* Status badge */}
          {status && (
            <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${
              status === 'running' ? 'bg-green-500/20 text-green-400 animate-pulse' :
              status === 'error' ? 'bg-red-500/20 text-red-400' :
              'bg-gray-500/20 text-gray-400'
            }`}>
              {status}
            </span>
          )}
        </div>
      </div>

      {/* Search bar */}
      {showSearch && (
        <div className="flex items-center gap-2 px-3 py-1 bg-zinc-900 border-b border-border">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search output..."
            className="flex-1 bg-transparent text-xs text-gray-200 font-mono outline-none placeholder:text-gray-600"
            autoFocus
          />
          {searchQuery && (
            <span className="text-[10px] text-muted-foreground">
              {filteredOutputs.length}/{outputs.length}
            </span>
          )}
        </div>
      )}

      {/* Output area */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-auto bg-zinc-950 font-mono text-xs p-2 min-h-0"
      >
        {filteredOutputs.length === 0 ? (
          <div className="text-gray-600 italic">
            {outputs.length === 0 ? 'Waiting for output...' :
             searchQuery ? 'No matches found.' : 'No output for this filter.'}
          </div>
        ) : (
          filteredOutputs.map((output, i) => (
            <div key={i} className={`${STREAM_COLORS[output.streamType] || 'text-gray-300'} leading-5 whitespace-pre-wrap break-all`}>
              {STREAM_LABELS[output.streamType] && (
                <span className="opacity-50">{STREAM_LABELS[output.streamType]}</span>
              )}
              {output.streamType === 'tool_use' && output.toolName && (
                <span className="text-cyan-600">[{output.toolName}] </span>
              )}
              {output.content}
            </div>
          ))
        )}
      </div>

      {/* Command input */}
      {agentId && onSendCommand && (() => {
        const isActive = status === 'running' || status === 'starting';
        return (
          <form
            className="flex items-center gap-2 px-2 py-1.5 bg-zinc-900 border-t border-border"
            onSubmit={(e) => {
              e.preventDefault();
              if (isActive && commandInput.trim()) {
                onSendCommand(agentId, commandInput.trim());
                setCommandInput('');
              }
            }}
          >
            <span className={`text-xs select-none ${isActive ? 'text-muted-foreground' : 'text-muted-foreground/30'}`}>&gt;</span>
            <input
              type="text"
              value={commandInput}
              onChange={(e) => setCommandInput(e.target.value)}
              placeholder={isActive ? 'Send instruction to agent...' : 'Agent is not running'}
              disabled={!isActive}
              className="flex-1 bg-transparent text-xs text-gray-200 font-mono outline-none placeholder:text-gray-600 disabled:opacity-40 disabled:cursor-not-allowed"
            />
            <button
              type="submit"
              disabled={!isActive || !commandInput.trim()}
              className="px-2 py-0.5 text-xs bg-primary/20 text-primary rounded hover:bg-primary/30 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              Send
            </button>
          </form>
        );
      })()}
    </div>
  );
}
