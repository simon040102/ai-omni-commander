import { useEffect, useRef, useState, useMemo, useCallback, memo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import type { AgentOutput } from '../../stores/agentStore';
import { useAgentStore } from '../../stores/agentStore';
import { IconSearch, IconStop, IconRefresh, IconSend, IconChevronDown, IconChevronRight, IconX } from '../ui/Icons';
import { FlowPanel } from './FlowPanel';
import { SaFlowModal } from './SaFlowModal';
import { useWsStore } from '../../stores/wsStore';

// Configure marked for terminal-friendly output
marked.setOptions({
  breaks: true,
  gfm: true,
});

/** Check if content likely contains markdown formatting */
function hasMarkdown(text: string): boolean {
  // Check for common markdown patterns
  return /(?:^#{1,6}\s|^\s*[-*+]\s|^\s*\d+\.\s|```|`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[.+?\]\(.+?\)|^\s*>\s|^\|.+\|)/m.test(text);
}

/** Render markdown content to HTML string */
function renderMarkdown(content: string): string {
  try {
    return marked.parse(content, { async: false }) as string;
  } catch {
    return content;
  }
}

/** Memoized markdown content component */
const MarkdownContent = memo(function MarkdownContent({ content }: { content: string }) {
  const html = useMemo(() => DOMPurify.sanitize(renderMarkdown(content)), [content]);
  return (
    <span
      className="terminal-markdown"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
});

/** Collapsible thinking block component - memoized for performance */
const ThinkingBlock = memo(function ThinkingBlock({ content, defaultExpanded = false }: { content: string; defaultExpanded?: boolean }) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const [wasManuallyToggled, setWasManuallyToggled] = useState(false);

  // Auto-collapse when thinking is no longer active (only if user hasn't manually toggled)
  useEffect(() => {
    if (!wasManuallyToggled) {
      setIsExpanded(defaultExpanded);
    }
  }, [defaultExpanded, wasManuallyToggled]);

  // Memoize processed content to avoid re-computing on every render
  const { thinkingContent, preview } = useMemo(() => {
    const cleaned = content.replace(/^\[thinking\]\s*/i, '');
    return {
      thinkingContent: cleaned,
      preview: cleaned.slice(0, 50) + (cleaned.length > 50 ? '...' : ''),
    };
  }, [content]);

  const handleToggle = useCallback(() => {
    setWasManuallyToggled(true);
    setIsExpanded(prev => !prev);
  }, []);

  return (
    <div className="my-1">
      <button
        onClick={handleToggle}
        className="flex items-center gap-1 text-yellow-600 dark:text-yellow-400 hover:text-yellow-500 dark:hover:text-yellow-300 transition-colors"
      >
        {isExpanded ? (
          <IconChevronDown className="w-3 h-3 shrink-0" />
        ) : (
          <IconChevronRight className="w-3 h-3 shrink-0" />
        )}
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-yellow-500/10 font-medium">thinking</span>
        {!isExpanded && (
          <span className="opacity-50 text-[10px] truncate max-w-[300px]">{preview}</span>
        )}
      </button>
      {isExpanded && (
        <div className="ml-4 mt-1 pl-2 border-l-2 border-yellow-500/30 text-yellow-600 dark:text-yellow-400 opacity-80 whitespace-pre-wrap break-all max-h-[400px] overflow-y-auto">
          {thinkingContent}
        </div>
      )}
    </div>
  );
});

/** Collapsible streaming thinking block - for real-time thinking display */
const StreamingThinkingBlock = memo(function StreamingThinkingBlock({ content }: { content: string }) {
  const [isExpanded, setIsExpanded] = useState(false);

  const preview = useMemo(() => {
    return content.slice(0, 50) + (content.length > 50 ? '...' : '');
  }, [content]);

  const handleToggle = useCallback(() => {
    setIsExpanded(prev => !prev);
  }, []);

  return (
    <div className="my-1">
      <button
        onClick={handleToggle}
        className="flex items-center gap-1 text-yellow-600 dark:text-yellow-400 hover:text-yellow-500 dark:hover:text-yellow-300 transition-colors"
      >
        {isExpanded ? (
          <IconChevronDown className="w-3 h-3 shrink-0" />
        ) : (
          <IconChevronRight className="w-3 h-3 shrink-0" />
        )}
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-yellow-500/10 font-medium flex items-center gap-1">
          thinking
          <span className="animate-pulse">●</span>
        </span>
        {!isExpanded && (
          <span className="opacity-50 text-[10px] truncate max-w-[300px]">{preview}</span>
        )}
      </button>
      {isExpanded && (
        <div className="ml-4 mt-1 pl-2 border-l-2 border-yellow-500/30 text-yellow-600 dark:text-yellow-400 opacity-80 whitespace-pre-wrap break-all max-h-[400px] overflow-y-auto">
          {content}
          <span className="animate-pulse">▌</span>
        </div>
      )}
    </div>
  );
});

interface PastedFile {
  id: string;
  name: string;
  path: string;
  preview?: string; // base64 data URL for images
  type: 'image' | 'file';
}

const STREAM_COLORS: Record<string, string> = {
  text: 'text-foreground',
  tool_use: 'text-cyan-600 dark:text-cyan-400',
  tool_result: 'text-muted-foreground',
  error: 'text-red-600 dark:text-red-400',
  system: 'text-yellow-600 dark:text-yellow-400',
};

interface TerminalOutputProps {
  outputs: AgentOutput[];
  title: string;
  role?: string;
  status?: string;
  agentId?: string;
  projectId?: string;
  taskId?: string;
  model?: string;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  onSendCommand?: (agentId: string, command: string) => void;
  onAction?: (agentId: string, action: 'stop' | 'restart') => void;
  /** Compact mode for grid view — hides some header info */
  compact?: boolean;
}

export function TerminalOutput({ outputs, title, role, status, agentId, projectId, taskId, model, totalInputTokens, totalOutputTokens, onSendCommand, onAction, compact }: TerminalOutputProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const [isAutoScroll, setIsAutoScroll] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const [filterType, setFilterType] = useState<string | null>(null);
  const [showFlow, setShowFlow] = useState(false);
  const [showSaFlow, setShowSaFlow] = useState(false);
  const [reportContent, setReportContent] = useState<string | null>(null);
  const [showReport, setShowReport] = useState(false);

  // Use store for command input to persist across project switches
  const commandInputs = useAgentStore((s) => s.commandInputs);
  const setCommandInput = useAgentStore((s) => s.setCommandInput);
  const commandInput = agentId ? (commandInputs[agentId] ?? '') : '';

  // Get streaming buffer for real-time display
  const streamingBuffers = useAgentStore((s) => s.streamingBuffers);
  const streamingBuffer = agentId ? streamingBuffers[agentId] : undefined;

  // Get flow plan for this agent
  const flowPlans = useAgentStore((s) => s.flowPlans);
  const flowPlan = agentId ? (flowPlans[agentId] ?? null) : null;

  // Get context usage for this agent
  const contextUsage = useAgentStore((s) => agentId ? s.contextUsage[agentId] : undefined);

  // Pasted files state
  const [pastedFiles, setPastedFiles] = useState<PastedFile[]>([]);
  const [isUploading, setIsUploading] = useState(false);

  // Handle paste from clipboard
  const handlePaste = useCallback(async (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (const item of items) {
      // Handle images
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (!file) continue;

        setIsUploading(true);
        try {
          // Read file as base64
          const reader = new FileReader();
          const base64 = await new Promise<string>((resolve, reject) => {
            reader.onload = () => {
              const result = reader.result as string;
              resolve(result.split(',')[1]); // Remove data URL prefix
            };
            reader.onerror = reject;
            reader.readAsDataURL(file);
          });

          // Upload to server
          const resp = await fetch('/api/upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              data: base64,
              filename: file.name || 'pasted_image.png',
              mimeType: file.type,
              projectId,
              taskId,
            }),
          });

          if (resp.ok) {
            const result = await resp.json();
            setPastedFiles(prev => [...prev, {
              id: crypto.randomUUID(),
              name: file.name || 'pasted_image.png',
              path: result.path,
              preview: `data:${file.type};base64,${base64}`,
              type: 'image',
            }]);
          }
        } catch (err) {
          console.error('Failed to upload pasted image:', err);
        } finally {
          setIsUploading(false);
        }
        return;
      }

      // Handle files (from file manager paste)
      if (item.kind === 'file') {
        e.preventDefault();
        const file = item.getAsFile();
        if (!file) continue;

        setIsUploading(true);
        try {
          const reader = new FileReader();
          const base64 = await new Promise<string>((resolve, reject) => {
            reader.onload = () => {
              const result = reader.result as string;
              resolve(result.split(',')[1]);
            };
            reader.onerror = reject;
            reader.readAsDataURL(file);
          });

          const resp = await fetch('/api/upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              data: base64,
              filename: file.name,
              mimeType: file.type,
              projectId,
              taskId,
            }),
          });

          if (resp.ok) {
            const result = await resp.json();
            const isImage = file.type.startsWith('image/');
            setPastedFiles(prev => [...prev, {
              id: crypto.randomUUID(),
              name: file.name,
              path: result.path,
              preview: isImage ? `data:${file.type};base64,${base64}` : undefined,
              type: isImage ? 'image' : 'file',
            }]);
          }
        } catch (err) {
          console.error('Failed to upload pasted file:', err);
        } finally {
          setIsUploading(false);
        }
      }
    }
  }, []);

  const removePastedFile = useCallback((id: string) => {
    setPastedFiles(prev => prev.filter(f => f.id !== id));
  }, []);

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
      // TXT also includes user instructions
      const types = filterType === 'text' ? ['text', 'user'] : [filterType];
      result = result.filter(o => types.includes(o.streamType));
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
      {/* Header — two rows: title on top, controls on bottom */}
      <div className="px-3 py-1.5 bg-card border-b border-border">
        {/* Row 1: Title */}
        <div className="font-mono font-bold text-sm truncate">{title}</div>
        {/* Row 2: Controls */}
        <div className="flex items-center justify-between mt-1">
          <div className="flex items-center gap-2">
            {!compact && (
              <span className="text-[10px] text-muted-foreground">
                {outputs.length} lines
                {toolCount > 0 && ` | ${toolCount} tools`}
                {errorCount > 0 && ` | ${errorCount} errors`}
              </span>
            )}
            {model && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-600 dark:text-purple-400">
                {model.replace('claude-', '').replace(/-\d{8}$/, '')}
              </span>
            )}
            {contextUsage && (
              <div className="flex items-center gap-1" title={`Context: ${contextUsage.totalTokens.toLocaleString()} / ${contextUsage.maxTokens.toLocaleString()} tokens (${Math.round(contextUsage.percentage)}%)`}>
                <div className="w-16 h-1.5 rounded-full bg-muted overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${contextUsage.percentage > 80 ? 'bg-red-500' : contextUsage.percentage > 60 ? 'bg-amber-500' : 'bg-green-500'}`}
                    style={{ width: `${Math.min(contextUsage.percentage, 100)}%` }}
                  />
                </div>
                <span className={`text-[10px] ${contextUsage.percentage > 80 ? 'text-red-500' : 'text-muted-foreground'}`}>
                  {Math.round(contextUsage.percentage)}%
                </span>
              </div>
            )}
          </div>
          <div className="flex items-center gap-1.5">
          {/* Search toggle */}
          <button
            onClick={() => { setShowSearch(!showSearch); if (showSearch) setSearchQuery(''); }}
            className={`p-1.5 rounded transition-colors ${
              showSearch ? 'bg-primary/20 text-primary' : 'text-muted-foreground hover:text-foreground hover:bg-muted'
            }`}
            title="Search output"
          >
            <IconSearch className="w-4 h-4" />
          </button>

          <div className="h-4 w-px bg-border" />

          {/* Filter buttons */}
          {(['text', 'tool_use', 'error'] as const).map(type => (
            <button
              key={type}
              onClick={() => setFilterType(filterType === type ? null : type)}
              className={`px-2 py-1 rounded text-[11px] font-medium transition-colors ${
                filterType === type
                  ? type === 'text' ? 'bg-gray-500/20 text-gray-300'
                    : type === 'tool_use' ? 'bg-cyan-500/15 text-cyan-400'
                    : 'bg-red-500/15 text-red-400'
                  : 'text-muted-foreground/60 hover:text-muted-foreground hover:bg-muted'
              }`}
              title={`Filter ${type}`}
            >
              {type === 'text' ? 'TXT' : type === 'tool_use' ? 'TOOL' : 'ERR'}
            </button>
          ))}

          {/* SA Flow button — frontend tasks only */}
          {role === 'frontend' && projectId && (
            <button
              onClick={() => setShowSaFlow(true)}
              className="px-2 py-1 rounded text-[11px] font-medium transition-colors border text-violet-600 dark:text-violet-400 border-violet-500/30 hover:bg-violet-500/10"
              title="查看 SA 操作流程圖"
            >
              SA Flow
            </button>
          )}

          {/* Verification Report button */}
          {taskId && (
            <button
              onClick={() => {
                fetch(`/api/task/${taskId}/verification-report`)
                  .then(r => r.ok ? r.text() : Promise.reject())
                  .then(text => { setReportContent(text); setShowReport(true); })
                  .catch(() => { setReportContent(null); setShowReport(true); });
              }}
              className="px-2 py-1 rounded text-[11px] font-medium transition-colors border text-emerald-600 dark:text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/10"
              title="查看驗證報告"
            >
              Report
            </button>
          )}

          <div className="h-4 w-px bg-border" />

          {/* Agent actions */}
          {agentId && onAction && status === 'running' && (
            <button
              onClick={() => onAction(agentId, 'stop')}
              className="p-1.5 rounded text-red-400 hover:bg-red-500/15 transition-colors"
              title="Stop agent"
            >
              <IconStop className="w-4 h-4" />
            </button>
          )}
          {agentId && onAction && (status === 'stopped' || status === 'error') && (
            <button
              onClick={() => onAction(agentId, 'restart')}
              className="p-1.5 rounded text-green-400 hover:bg-green-500/15 transition-colors"
              title="Restart agent"
            >
              <IconRefresh className="w-4 h-4" />
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
      </div>

      {/* Search bar */}
      {showSearch && (
        <div className="flex items-center gap-2 px-3 py-1 bg-muted/50 border-b border-border">
          <IconSearch className="w-3 h-3 text-muted-foreground" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search output..."
            className="flex-1 bg-transparent text-xs text-foreground font-mono outline-none placeholder:text-muted-foreground"
            autoFocus
          />
          {searchQuery && (
            <span className="text-[10px] text-muted-foreground">
              {filteredOutputs.length}/{outputs.length}
            </span>
          )}
        </div>
      )}

      {/* Output area + Flow panel */}
      <div className="flex flex-1 min-h-0">
      <div className="relative flex-1 min-h-0">
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="absolute inset-0 overflow-auto bg-slate-100 dark:bg-zinc-950 font-mono text-xs p-2"
        >
          {filteredOutputs.length === 0 ? (
            <div className="text-muted-foreground italic">
              {outputs.length === 0 ? 'Waiting for output...' :
               searchQuery ? 'No matches found.' : 'No output for this filter.'}
            </div>
          ) : (
            filteredOutputs.map((output, i) => {
              // Use timestamp + index as stable key to preserve component state
              const stableKey = `${output.timestamp}-${i}`;
              const isLastItem = i === filteredOutputs.length - 1;

              // Check if this is a thinking block - always collapsed by default
              const isThinking = output.streamType === 'system' && output.content.startsWith('[thinking]');
              if (isThinking) {
                return <ThinkingBlock key={stableKey} content={output.content} defaultExpanded={false} />;
              }

              // For tool_use, resolve toolName and displayContent:
              // - Live streaming: output.toolName is set directly
              // - History (DB/JSONL): content is JSON string {"tool":"X","input":{...}}
              let resolvedToolName = output.toolName;
              let toolDisplayContent = output.content;
              if (output.streamType === 'tool_use' && !resolvedToolName && output.content) {
                try {
                  const parsed = JSON.parse(output.content) as { tool?: string; input?: unknown };
                  if (parsed.tool) {
                    resolvedToolName = parsed.tool;
                    toolDisplayContent = parsed.input !== undefined ? JSON.stringify(parsed.input, null, 2) : '';
                  }
                } catch { /* not JSON, display as-is */ }
              }

              return (
                <div key={stableKey} className={`${STREAM_COLORS[output.streamType] || 'text-gray-300'} leading-5 whitespace-pre-wrap break-all`}>
                  {output.streamType === 'error' && (
                    <span className="opacity-50">ERR </span>
                  )}
                  {output.streamType === 'system' && (
                    <span className="opacity-50">SYS </span>
                  )}
                  {output.streamType === 'tool_use' && resolvedToolName && (
                    <>
                      <span className="inline-flex items-center px-1.5 py-0 rounded bg-cyan-500/10 text-cyan-600 dark:text-cyan-500 text-[10px] font-medium mr-1.5">
                        {resolvedToolName}
                      </span>
                      {model && (
                        <span className="text-[9px] text-purple-500/70 mr-1.5">
                          [{model.replace('claude-', '').replace(/-\d{8}$/, '')}]
                        </span>
                      )}
                    </>
                  )}
                  {output.streamType === 'text' && typeof output.content === 'string' && hasMarkdown(output.content) ? (
                    <MarkdownContent content={output.content} />
                  ) : (
                    output.streamType === 'tool_use' ? toolDisplayContent
                      : typeof output.content === 'string' ? output.content
                      : JSON.stringify(output.content)
                  )}
                </div>
              );
            })
          )}
          {/* Real-time streaming content */}
          {streamingBuffer?.thinking && (
            <StreamingThinkingBlock content={streamingBuffer.thinking} />
          )}
          {streamingBuffer?.text && (
            <div className="text-foreground leading-5 whitespace-pre-wrap break-all">
              {hasMarkdown(streamingBuffer.text) ? (
                <><MarkdownContent content={streamingBuffer.text} /><span className="animate-pulse text-primary">▌</span></>
              ) : (
                <>{streamingBuffer.text}<span className="animate-pulse text-primary">▌</span></>
              )}
            </div>
          )}
          {/* Working indicator when running but no visible streaming text */}
          {(status === 'running' || status === 'starting') && !streamingBuffer?.text && (
            <div className="flex items-center gap-2 text-muted-foreground text-xs py-2">
              <span className="flex gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-primary animate-bounce" style={{ animationDelay: '0ms' }} />
                <span className="w-1.5 h-1.5 rounded-full bg-primary animate-bounce" style={{ animationDelay: '150ms' }} />
                <span className="w-1.5 h-1.5 rounded-full bg-primary animate-bounce" style={{ animationDelay: '300ms' }} />
              </span>
              <span className="animate-pulse">Agent is working...</span>
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
      {/* Flow panel (right side) */}
      {showFlow && (
        <FlowPanel
          plan={flowPlan}
          agentStatus={status}
          onReRun={agentId && onSendCommand ? (stepN, stepLabel) => {
            onSendCommand(agentId, `Please re-run from step ${stepN}: "${stepLabel}". Treat all previous steps as incomplete and resume the task from this step onwards. Output [STEP:${stepN}] to mark it active, then continue to completion.`);
          } : undefined}
        />
      )}
      </div>

      {/* Command input */}
      {agentId && onSendCommand && (() => {
        // Axure agents use Playwright MCP which can't survive session resume —
        // only allow input while actively running; use UI buttons for restart.
        const isAxure = role === 'axure';
        const wsConnected = useWsStore.getState().connected;
        const canSend = wsConnected && (isAxure
          ? (status === 'running' || status === 'starting')
          : (status === 'running' || status === 'starting' || status === 'stopped'));
        const isRunning = status === 'running' || status === 'starting';
        const placeholder = isRunning
          ? 'Send instruction to agent... (Ctrl+V to paste images)'
          : isAxure
            ? '爬取完成或出錯請使用 MockupView 的按鈕繼續'
            : status === 'stopped'
              ? 'Send to resume agent session...'
              : 'Agent is not available';

        const handleSubmit = (e: React.FormEvent) => {
          e.preventDefault();
          if (!canSend) return;

          // Build command with file paths
          let fullCommand = commandInput.trim();
          if (pastedFiles.length > 0) {
            const filePaths = pastedFiles.map(f => f.path).join('\n');
            if (fullCommand) {
              fullCommand = `${fullCommand}\n\n[Attached files - please read these files using the Read tool]:\n${filePaths}`;
            } else {
              fullCommand = `Please analyze these files using the Read tool:\n${filePaths}`;
            }
          }

          if (fullCommand) {
            onSendCommand(agentId, fullCommand);
            setCommandInput(agentId, '');
            setPastedFiles([]);
          }
        };

        return (
          <div className="bg-slate-200 dark:bg-zinc-900 border-t border-border">
            {/* Pasted files preview */}
            {pastedFiles.length > 0 && (
              <div className="flex flex-wrap gap-2 px-3 py-2 border-b border-border/50">
                {pastedFiles.map(file => (
                  <div
                    key={file.id}
                    className="relative group flex items-center gap-1.5 px-2 py-1 bg-slate-300 dark:bg-zinc-800 rounded-md text-xs"
                  >
                    {file.preview ? (
                      <img src={file.preview} alt={file.name} className="w-8 h-8 object-cover rounded" />
                    ) : (
                      <span className="w-8 h-8 flex items-center justify-center bg-slate-400 dark:bg-zinc-700 rounded text-[10px]">
                        📄
                      </span>
                    )}
                    <span className="max-w-[100px] truncate text-foreground">{file.name}</span>
                    <button
                      type="button"
                      onClick={() => removePastedFile(file.id)}
                      className="p-0.5 rounded hover:bg-red-500/20 text-muted-foreground hover:text-red-500 dark:hover:text-red-400"
                    >
                      <IconX className="w-3 h-3" />
                    </button>
                  </div>
                ))}
                {isUploading && (
                  <div className="flex items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground">
                    <span className="animate-spin">⏳</span>
                    Uploading...
                  </div>
                )}
              </div>
            )}

            <form
              className="flex items-start gap-2 px-3 py-2"
              onSubmit={handleSubmit}
            >
              <span className={`text-xs select-none mt-1.5 ${canSend ? 'text-primary' : 'text-muted-foreground/30'}`}>&gt;</span>
              <textarea
                value={commandInput}
                onChange={(e) => {
                  if (agentId) setCommandInput(agentId, e.target.value);
                  // Auto-resize
                  e.target.style.height = 'auto';
                  e.target.style.height = Math.min(e.target.scrollHeight, 150) + 'px';
                }}
                onKeyDown={(e) => {
                  // Submit on Enter (without Shift)
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    if (canSend && (commandInput.trim() || pastedFiles.length > 0)) {
                      handleSubmit(e);
                    }
                  }
                }}
                onPaste={handlePaste}
                placeholder={placeholder}
                disabled={!canSend}
                rows={1}
                className="flex-1 bg-transparent text-xs text-foreground font-mono outline-none placeholder:text-muted-foreground disabled:opacity-40 disabled:cursor-not-allowed resize-none min-h-[24px] max-h-[150px] leading-5"
              />
              <button
                type="submit"
                disabled={!canSend || (!commandInput.trim() && pastedFiles.length === 0)}
                className="inline-flex items-center gap-1 px-3 py-1 text-xs font-medium bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-30 disabled:cursor-not-allowed transition-colors mt-0.5"
              >
                <IconSend className="w-3 h-3" />
                Send
              </button>
              {status === 'running' && onAction && agentId && (
                <button
                  type="button"
                  onClick={() => onAction(agentId, 'stop')}
                  className="inline-flex items-center gap-1 px-3 py-1 text-xs font-medium bg-red-500/10 text-red-600 dark:text-red-400 rounded-md hover:bg-red-500/20 transition-colors mt-0.5"
                >
                  <IconStop className="w-3 h-3" />
                  Stop
                </button>
              )}
            </form>
          </div>
        );
      })()}

      {/* SA Flow Modal */}
      {showSaFlow && projectId && (
        <SaFlowModal
          projectId={projectId}
          taskId={taskId}
          onClose={() => setShowSaFlow(false)}
        />
      )}

      {/* Verification Report Modal */}
      {showReport && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setShowReport(false)}>
          <div className="bg-card border border-border rounded-xl shadow-2xl w-[700px] max-h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-3 border-b border-border flex-shrink-0">
              <span className="text-sm font-semibold text-emerald-500">驗證報告</span>
              <button onClick={() => setShowReport(false)} className="p-1 rounded hover:bg-muted text-muted-foreground">✕</button>
            </div>
            <div className="overflow-y-auto flex-1 p-5">
              {reportContent
                ? <pre className="text-xs text-foreground whitespace-pre-wrap font-mono leading-5">{reportContent}</pre>
                : <p className="text-sm text-muted-foreground text-center py-8">尚未產生驗證報告<br/><span className="text-xs">Agent 完成任務後會自動寫入 docs/verification-reports/</span></p>
              }
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
