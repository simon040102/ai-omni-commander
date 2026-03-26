import type { AgentFlowPlan } from '../../stores/agentStore';

interface FlowPanelProps {
  plan: AgentFlowPlan | null;
  agentStatus?: string;
}

export function FlowPanel({ plan, agentStatus }: FlowPanelProps) {
  if (!plan || plan.steps.length === 0) {
    return (
      <div className="w-52 flex-shrink-0 border-l border-border/30 flex flex-col bg-background/30">
        <div className="px-3 py-2 border-b border-border/30">
          <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">執行流程</span>
        </div>
        <div className="flex-1 flex items-center justify-center p-4">
          <span className="text-[11px] text-muted-foreground/50 text-center">
            {agentStatus === 'running'
              ? 'Agent 尚未輸出 [FLOW_PLAN]'
              : '尚無流程資料'}
          </span>
        </div>
      </div>
    );
  }

  const doneCount = plan.steps.filter(s => s.status === 'done').length;
  const total = plan.steps.length;
  const pct = total > 0 ? Math.round((doneCount / total) * 100) : 0;

  return (
    <div className="w-52 flex-shrink-0 border-l border-border/30 flex flex-col bg-background/30 overflow-hidden">
      {/* Header */}
      <div className="px-3 py-2 border-b border-border/30 flex items-center justify-between">
        <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">執行流程</span>
        <span className="text-[10px] text-muted-foreground">{doneCount}/{total}</span>
      </div>

      {/* Progress bar */}
      <div className="h-0.5 bg-border/30">
        <div
          className="h-full bg-emerald-500/60 transition-all duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>

      {/* Steps */}
      <div className="flex-1 overflow-y-auto py-2 space-y-0.5">
        {plan.steps.map((step) => (
          <div
            key={step.n}
            className={`flex items-start gap-2 px-3 py-1.5 rounded mx-1 transition-colors ${
              step.status === 'active'
                ? 'bg-blue-500/10 border border-blue-500/20'
                : step.status === 'done'
                ? 'opacity-60'
                : 'opacity-40'
            }`}
          >
            {/* Status icon */}
            <span className="flex-shrink-0 w-4 text-center text-[11px] mt-0.5">
              {step.status === 'done' && <span className="text-emerald-400">✓</span>}
              {step.status === 'active' && (
                <span className="inline-block w-2 h-2 rounded-full bg-blue-400 animate-pulse mt-1" />
              )}
              {step.status === 'pending' && (
                <span className="text-muted-foreground/40 text-[10px]">{step.n}</span>
              )}
            </span>
            {/* Label */}
            <span className={`text-[11px] leading-snug ${
              step.status === 'active' ? 'text-blue-300 font-medium'
              : step.status === 'done' ? 'text-muted-foreground line-through'
              : 'text-muted-foreground/50'
            }`}>
              {step.label}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
