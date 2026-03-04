import { useEffect, useRef, useState, useMemo } from 'react';
import type { AgentOutput } from '../../stores/agentStore';
import { useAgentStore } from '../../stores/agentStore';
import { IconSearch, IconStop, IconRefresh, IconSend, IconChevronDown } from '../ui/Icons';

const STREAM_COLORS: Record<string, string> = {
  text: 'text-gray-200',
  tool_use: 'text-cyan-400',
  tool_result: 'text-gray-500',
  error: 'text-red-400',
  system: 'text-yellow-400',
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
  const [isAutoScroll, setIsAutoScroll] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const [filterType, setFilterType] = useState<string | null>(null);

  // Use store for command input to persist across project switches
  const commandInputs = useAgentStore((s) => s.commandInputs);
  const setCommandInput = useAgentStore((s) => s.setCommandInput);
  const commandInput = agentId ? (commandInputs[agentId] ?? '') : '';

  // Get streaming buffer for real-time display
  const streamingBuffers = useAgentStore((s) => s.streamingBuffers);
  const streamingBuffer = agentId ? streamingBuffers[agentId] : undefined;

  useEffect(() => {
    if (autoScrollRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [outputs.length]);

  const handleScroll = () => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    const atBottom = scrollHeight - scrollTop - clientHeight < 50;
    autoScrollRef.current = atBottom;
    setIsAutoScroll(atBottom);
  };

  const scrollToBottom = () => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
      autoScrollRef.current = true;
      setIsAutoScroll(true);
    }
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
          <span className="text-[10px] text-muted-foreground">
            {outputs.length} lines
            {toolCount > 0 && ` | ${toolCount} tools`}
            {errorCount > 0 && ` | ${errorCount} errors`}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {/* Search toggle */}
          <button
            onClick={() => { setShowSearch(!showSearch); if (showSearch) setSearchQuery(''); }}
            className={`p-1 rounded transition-colors ${
              showSearch ? 'bg-primary/20 text-primary' : 'text-muted-foreground hover:text-foreground hover:bg-muted'
            }`}
            title="Search output"
          >
            <IconSearch className="w-3.5 h-3.5" />
          </button>
          {/* Filter buttons */}
          {(['text', 'tool_use', 'error'] as const).map(type => (
            <button
              key={type}
              onClick={() => setFilterType(filterType === type ? null : type)}
              className={`px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors ${
                filterType === type
                  ? type === 'text' ? 'bg-gray-500/20 text-gray-300'
                    : type === 'tool_use' ? 'bg-cyan-500/15 text-cyan-400'
                    : 'bg-red-500/15 text-red-400'
                  : 'text-muted-foreground/50 hover:text-muted-foreground hover:bg-muted'
              }`}
              title={`Filter ${type}`}
            >
              {type === 'text' ? 'TXT' : type === 'tool_use' ? 'TOOL' : 'ERR'}
            </button>
          ))}

          <div className="h-3 w-px bg-border mx-0.5" />

          {/* Agent actions */}
          {agentId && onAction && status === 'running' && (
            <button
              onClick={() => onAction(agentId, 'stop')}
              className="p-1 rounded text-red-400 hover:bg-red-500/15 transition-colors"
              title="Stop agent"
            >
              <IconStop className="w-3.5 h-3.5" />
            </button>
          )}
          {agentId && onAction && (status === 'stopped' || status === 'error') && (
            <button
              onClick={() => onAction(agentId, 'restart')}
              className="p-1 rounded text-green-400 hover:bg-green-500/15 transition-colors"
              title="Restart agent"
            >
              <IconRefresh className="w-3.5 h-3.5" />
            </button>
          )}
          {/* Status badge */}
          {status && (
            <span className={`text-[10px] px-1.5 py-0.5 rounded-full ml-0.5 ${
              status === 'running' ? 'bg-green-500/15 text-green-400 animate-breathe' :
              status === 'error' ? 'bg-red-500/15 text-red-400' :
              'bg-gray-500/15 text-gray-400'
            }`}>
              {status}
            </span>
          )}
        </div>
      </div>

      {/* Search bar */}
      {showSearch && (
        <div className="flex items-center gap-2 px-3 py-1 bg-zinc-900 border-b border-border">
          <IconSearch className="w-3 h-3 text-muted-foreground" />
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
      <div className="relative flex-1 min-h-0">
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="absolute inset-0 overflow-auto bg-zinc-950 font-mono text-xs p-2"
        >
          {filteredOutputs.length === 0 ? (
            <div className="text-gray-600 italic">
              {outputs.length === 0 ? 'Waiting for output...' :
               searchQuery ? 'No matches found.' : 'No output for this filter.'}
            </div>
          ) : (
            filteredOutputs.map((output, i) => (
              <div key={i} className={`${STREAM_COLORS[output.streamType] || 'text-gray-300'} leading-5 whitespace-pre-wrap break-all`}>
                {output.streamType === 'error' && (
                  <span className="opacity-50">ERR </span>
                )}
                {output.streamType === 'system' && (
                  <span className="opacity-50">SYS </span>
                )}
                {output.streamType === 'tool_use' && output.toolName && (
                  <span className="inline-flex items-center px-1.5 py-0 rounded bg-cyan-500/10 text-cyan-500 text-[10px] font-medium mr-1.5">
                    {output.toolName}
                  </span>
                )}
                {output.content}
              </div>
            ))
          )}
          {/* Real-time streaming content */}
          {streamingBuffer?.thinking && (
            <div className="text-yellow-400 leading-5 whitespace-pre-wrap break-all opacity-70">
              <span className="opacity-50">SYS </span>
              <span className="text-yellow-500">[thinking] </span>
              {streamingBuffer.thinking}
              <span className="animate-pulse">▌</span>
            </div>
          )}
          {streamingBuffer?.text && (
            <div className="text-gray-200 leading-5 whitespace-pre-wrap break-all">
              {streamingBuffer.text}
              <span className="animate-pulse text-primary">▌</span>
            </div>
          )}
        </div>

        {/* Scroll to bottom button */}
        {!isAutoScroll && outputs.length > 0 && (
          <button
            onClick={scrollToBottom}
            className="absolute bottom-2 right-3 inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-primary/90 text-primary-foreground text-[10px] font-medium shadow-lg hover:bg-primary transition-colors animate-fade-in"
          >
            <IconChevronDown className="w-3 h-3" />
            Latest
          </button>
        )}
      </div>

      {/* Command input */}
      {agentId && onSendCommand && (() => {
        // Allow sending to running, starting, or stopped agents (stopped agents can be resumed)
        const canSend = status === 'running' || status === 'starting' || status === 'stopped';
        const isRunning = status === 'running' || status === 'starting';
        const placeholder = isRunning
          ? 'Send instruction to agent...'
          : status === 'stopped'
            ? 'Send to resume agent session...'
            : 'Agent is not available';
        return (
          <form
            className="flex items-center gap-2 px-3 py-2 bg-zinc-900 border-t border-border"
            onSubmit={(e) => {
              e.preventDefault();
              if (canSend && commandInput.trim()) {
                onSendCommand(agentId, commandInput.trim());
                setCommandInput(agentId, '');
              }
            }}
          >
            <span className={`text-xs select-none ${canSend ? 'text-primary' : 'text-muted-foreground/30'}`}>&gt;</span>
            <input
              type="text"
              value={commandInput}
              onChange={(e) => agentId && setCommandInput(agentId, e.target.value)}
              placeholder={placeholder}
              disabled={!canSend}
              className="flex-1 bg-transparent text-xs text-gray-200 font-mono outline-none placeholder:text-gray-600 disabled:opacity-40 disabled:cursor-not-allowed"
            />
            <button
              type="submit"
              disabled={!canSend || !commandInput.trim()}
              className="inline-flex items-center gap-1 px-3 py-1 text-xs font-medium bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              <IconSend className="w-3 h-3" />
              Send
            </button>
          </form>
        );
      })()}
    </div>
  );
}
