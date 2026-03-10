import { useState, useCallback } from 'react';
import { useProjectStore, type AgentPlan } from '../../stores/projectStore';
import { useWsStore } from '../../stores/wsStore';
import { useToastStore } from '../../stores/toastStore';

const ROLE_COLORS: Record<string, string> = {
  frontend: 'text-blue-400',
  backend: 'text-purple-400',
  master: 'text-yellow-400',
  architect: 'text-orange-400',
  devops: 'text-green-400',
  testing: 'text-teal-400',
  review: 'text-gray-400',
};

interface PlanPanelProps {
  onClose?: () => void;
}

export function PlanPanel({ onClose }: PlanPanelProps) {
  const plans = useProjectStore(s => s.plans);
  const agents = useProjectStore(s => s.agents);
  const client = useWsStore(s => s.client);
  const addToast = useToastStore(s => s.addToast);
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState('');
  const [showRejectDialog, setShowRejectDialog] = useState(false);

  const selectedPlan = plans.find(p => p.id === selectedPlanId);
  const pendingPlans = plans.filter(p => p.status === 'pending');
  const otherPlans = plans.filter(p => p.status !== 'pending');

  const getAgentRole = useCallback((agentId: string) => {
    const agent = agents.find(a => a.id === agentId);
    return agent?.role || 'unknown';
  }, [agents]);

  const handleApprove = useCallback((plan: AgentPlan) => {
    client?.send({
      type: 'agent.planAction',
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      payload: {
        agentId: plan.agentId,
        planId: plan.id,
        action: 'approve',
      },
    });
    addToast({ type: 'success', title: '計劃已核准', message: 'Agent 將繼續執行' });
    setSelectedPlanId(null);
  }, [client, addToast]);

  const handleReject = useCallback((plan: AgentPlan) => {
    if (!feedback.trim()) {
      addToast({ type: 'warning', title: '請輸入修改意見' });
      return;
    }
    client?.send({
      type: 'agent.planAction',
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      payload: {
        agentId: plan.agentId,
        planId: plan.id,
        action: 'reject',
        feedback: feedback.trim(),
      },
    });
    addToast({ type: 'info', title: '已要求修改計劃', message: 'Agent 將重新擬定計劃' });
    setSelectedPlanId(null);
    setShowRejectDialog(false);
    setFeedback('');
  }, [client, addToast, feedback]);

  if (plans.length === 0) {
    return null;
  }

  return (
    <div className="bg-card border border-border rounded-lg overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-muted/30">
        <div className="flex items-center gap-2">
          <span className="text-lg">📋</span>
          <h3 className="text-sm font-semibold">Implementation Plans</h3>
          {pendingPlans.length > 0 && (
            <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-yellow-500/20 text-yellow-400">
              {pendingPlans.length} 待審核
            </span>
          )}
        </div>
        {onClose && (
          <button
            onClick={onClose}
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>

      {/* Plan list */}
      <div className="flex">
        {/* Left: Plan list */}
        <div className="w-48 border-r border-border bg-muted/20">
          {pendingPlans.length > 0 && (
            <div className="p-2">
              <div className="text-[10px] font-semibold text-muted-foreground uppercase mb-1">Pending</div>
              {pendingPlans.map(plan => (
                <button
                  key={plan.id}
                  onClick={() => setSelectedPlanId(plan.id)}
                  className={`w-full text-left px-2 py-1.5 rounded text-sm transition-colors ${
                    selectedPlanId === plan.id
                      ? 'bg-primary/20 text-primary'
                      : 'hover:bg-muted text-foreground'
                  }`}
                >
                  <span className={`font-medium ${ROLE_COLORS[getAgentRole(plan.agentId)] || ''}`}>
                    {getAgentRole(plan.agentId)}
                  </span>
                  <span className="ml-2 text-[10px] text-yellow-400 animate-pulse">●</span>
                </button>
              ))}
            </div>
          )}
          {otherPlans.length > 0 && (
            <div className="p-2 border-t border-border">
              <div className="text-[10px] font-semibold text-muted-foreground uppercase mb-1">History</div>
              {otherPlans.map(plan => (
                <button
                  key={plan.id}
                  onClick={() => setSelectedPlanId(plan.id)}
                  className={`w-full text-left px-2 py-1.5 rounded text-sm transition-colors ${
                    selectedPlanId === plan.id
                      ? 'bg-primary/20 text-primary'
                      : 'hover:bg-muted text-muted-foreground'
                  }`}
                >
                  <span className={ROLE_COLORS[getAgentRole(plan.agentId)] || ''}>
                    {getAgentRole(plan.agentId)}
                  </span>
                  <span className={`ml-2 text-[10px] ${
                    plan.status === 'approved' ? 'text-green-400' : 'text-red-400'
                  }`}>
                    {plan.status === 'approved' ? '✓' : '✗'}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Right: Plan content */}
        <div className="flex-1 min-h-[300px] max-h-[500px] overflow-auto">
          {selectedPlan ? (
            <div className="p-4">
              {/* Plan status badge */}
              <div className="flex items-center justify-between mb-3">
                <span className={`text-sm font-semibold ${ROLE_COLORS[getAgentRole(selectedPlan.agentId)] || ''}`}>
                  {getAgentRole(selectedPlan.agentId)} Agent 計劃書
                </span>
                <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                  selectedPlan.status === 'pending' ? 'bg-yellow-500/20 text-yellow-400' :
                  selectedPlan.status === 'approved' ? 'bg-green-500/20 text-green-400' :
                  'bg-red-500/20 text-red-400'
                }`}>
                  {selectedPlan.status === 'pending' ? '待審核' :
                   selectedPlan.status === 'approved' ? '已核准' : '已退回'}
                </span>
              </div>

              {/* Plan content as pre-formatted text (markdown-like) */}
              <div className="bg-muted/30 rounded-lg p-4 text-sm font-mono whitespace-pre-wrap overflow-x-auto">
                {selectedPlan.content}
              </div>

              {/* Action buttons for pending plans */}
              {selectedPlan.status === 'pending' && (
                <div className="flex items-center gap-3 mt-4 pt-4 border-t border-border">
                  {!showRejectDialog ? (
                    <>
                      <button
                        onClick={() => handleApprove(selectedPlan)}
                        className="flex-1 px-4 py-2 bg-green-600 hover:bg-green-500 text-white rounded-lg text-sm font-semibold transition-colors"
                      >
                        ✓ 核准執行
                      </button>
                      <button
                        onClick={() => setShowRejectDialog(true)}
                        className="flex-1 px-4 py-2 bg-muted hover:bg-muted/80 text-foreground rounded-lg text-sm font-semibold transition-colors"
                      >
                        ✏ 要求修改
                      </button>
                    </>
                  ) : (
                    <div className="w-full space-y-2">
                      <textarea
                        value={feedback}
                        onChange={(e) => setFeedback(e.target.value)}
                        placeholder="請說明需要修改的地方..."
                        className="w-full bg-muted border border-border rounded-md px-3 py-2 text-sm min-h-[80px] resize-y"
                      />
                      <div className="flex gap-2">
                        <button
                          onClick={() => handleReject(selectedPlan)}
                          className="flex-1 px-4 py-2 bg-red-600 hover:bg-red-500 text-white rounded-lg text-sm font-semibold transition-colors"
                        >
                          送出修改意見
                        </button>
                        <button
                          onClick={() => { setShowRejectDialog(false); setFeedback(''); }}
                          className="px-4 py-2 bg-muted hover:bg-muted/80 text-muted-foreground rounded-lg text-sm transition-colors"
                        >
                          取消
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
              選擇左側的計劃書以檢視內容
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
