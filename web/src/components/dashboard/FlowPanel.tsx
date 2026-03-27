import { useState } from 'react';
import type { AgentFlowPlan } from '../../stores/agentStore';

interface FlowPanelProps {
  plan: AgentFlowPlan | null;
  agentStatus?: string;
  onReRun?: (stepN: number, stepLabel: string) => void;
}

export function FlowPanel({ plan, agentStatus, onReRun }: FlowPanelProps) {
  const [hoveredStep, setHoveredStep] = useState<number | null>(null);

  if (!plan || plan.steps.length === 0) {
    return (
      <div className="w-56 flex-shrink-0 border-l border-border flex flex-col bg-muted/20">
        <div className="px-3 py-2 border-b border-border">
          <span className="text-[10px] font-semibold text-foreground/60 uppercase tracking-wider">執行流程</span>
        </div>
        <div className="flex-1 flex items-center justify-center p-4">
          <span className="text-[11px] text-muted-foreground text-center">
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
    <div className="w-56 flex-shrink-0 border-l border-border flex flex-col bg-muted/20 overflow-hidden">
      {/* Header */}
      <div className="px-3 py-2 border-b border-border flex items-center justify-between">
        <span className="text-[10px] font-semibold text-foreground/60 uppercase tracking-wider">執行流程</span>
        <span className="text-[10px] font-medium text-foreground/50">{doneCount}/{total}</span>
      </div>

      {/* Progress bar */}
      <div className="h-1 bg-border">
        <div
          className="h-full bg-emerald-500 transition-all duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>

      {/* Steps */}
      <div className="flex-1 overflow-y-auto py-3 px-3 flex flex-col">
        {plan.steps.map((step, i) => (
          <div key={step.n} className="flex flex-col items-center">
            {/* Step card */}
            <div
              className={`w-full rounded-lg border px-3 py-2 transition-all duration-300 group ${
                step.status === 'active'
                  ? 'bg-blue-50 border-blue-300 shadow-sm dark:bg-blue-500/10 dark:border-blue-500/40'
                  : step.status === 'done'
                  ? 'bg-emerald-50 border-emerald-200 dark:bg-emerald-500/10 dark:border-emerald-500/30'
                  : 'bg-background border-border/80'
              }`}
              onMouseEnter={() => setHoveredStep(step.n)}
              onMouseLeave={() => setHoveredStep(null)}
            >
              <div className="flex items-start gap-2">
                {/* Status icon */}
                <div className="flex-shrink-0 mt-0.5">
                  {step.status === 'done' && (
                    onReRun && hoveredStep === step.n ? (
                      <button
                        onClick={() => onReRun(step.n, step.label)}
                        className="w-5 h-5 rounded-full bg-orange-500 flex items-center justify-center hover:bg-orange-600 transition-colors"
                        title={`從 Step ${step.n} 重新執行`}
                      >
                        <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                        </svg>
                      </button>
                    ) : (
                      <div className="w-5 h-5 rounded-full bg-emerald-500 flex items-center justify-center">
                        <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                      </div>
                    )
                  )}
                  {step.status === 'active' && (
                    <div className="w-4 h-4 rounded-full bg-blue-500 flex items-center justify-center animate-pulse">
                      <div className="w-1.5 h-1.5 rounded-full bg-white" />
                    </div>
                  )}
                  {step.status === 'pending' && (
                    <div className="w-4 h-4 rounded-full border-2 border-border flex items-center justify-center">
                      <span className="text-[8px] text-muted-foreground font-bold">{step.n}</span>
                    </div>
                  )}
                </div>
                {/* Label */}
                <span className={`text-[11px] leading-snug flex-1 ${
                  step.status === 'active'
                    ? 'text-blue-700 font-semibold dark:text-blue-300'
                    : step.status === 'done'
                    ? 'text-emerald-700 dark:text-emerald-400'
                    : 'text-foreground/60'
                }`}>
                  {step.label}
                </span>
              </div>

            </div>

            {/* Connector between steps */}
            {i < plan.steps.length - 1 && (
              <div className="flex flex-col items-center my-0.5">
                <div className={`w-px h-4 ${step.status === 'done' ? 'bg-emerald-500' : 'bg-border/80'}`} />
                <div className={`w-1.5 h-1.5 rotate-45 border-r-2 border-b-2 -mt-1 ${
                  step.status === 'done' ? 'border-emerald-500' : 'border-foreground/30'
                }`} />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
