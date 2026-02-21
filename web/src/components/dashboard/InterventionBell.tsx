import { useState, useEffect } from 'react';
import { useProjectStore } from '../../stores/projectStore';
import { useWsStore } from '../../stores/wsStore';

export function InterventionBell() {
  const interventions = useProjectStore(s => s.interventions);
  const resolveIntervention = useProjectStore(s => s.resolveIntervention);
  const client = useWsStore(s => s.client);
  const [isOpen, setIsOpen] = useState(false);
  const [userInput, setUserInput] = useState('');

  const pending = interventions.filter(i => i.status === 'pending');

  // Auto-open when new intervention arrives
  useEffect(() => {
    if (pending.length > 0) {
      setIsOpen(true);
    }
  }, [pending.length]);

  const handleResolve = (interventionId: string, decision: 'approve' | 'reject' | 'modify') => {
    client?.send({
      type: 'intervention.resolve',
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      payload: {
        interventionId,
        decision,
        userInput: decision === 'modify' ? userInput : undefined,
      },
    });
    resolveIntervention(interventionId);
    setUserInput('');
  };

  if (pending.length === 0 && !isOpen) return null;

  return (
    <>
      {/* Bell button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="relative p-2 rounded-md hover:bg-muted transition-colors"
      >
        <span className="text-lg">🔔</span>
        {pending.length > 0 && (
          <span className="absolute -top-1 -right-1 w-5 h-5 bg-red-500 text-white text-xs rounded-full flex items-center justify-center animate-bounce">
            {pending.length}
          </span>
        )}
      </button>

      {/* Modal */}
      {isOpen && pending.length > 0 && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-card border border-border rounded-lg w-full max-w-lg mx-4 max-h-[80vh] overflow-auto">
            <div className="p-4 border-b border-border flex items-center justify-between">
              <h2 className="font-bold text-lg">Needs Your Attention</h2>
              <button onClick={() => setIsOpen(false)} className="text-muted-foreground hover:text-foreground">
                ✕
              </button>
            </div>

            {pending.map(intervention => (
              <div key={intervention.id} className="p-4 border-b border-border">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-xs px-2 py-0.5 rounded bg-yellow-500/20 text-yellow-400">
                    {intervention.agentRole}
                  </span>
                  <span className="text-sm font-medium">Agent needs help</span>
                </div>

                <p className="text-sm text-muted-foreground mb-3">
                  {intervention.reason}
                </p>

                <textarea
                  value={userInput}
                  onChange={(e) => setUserInput(e.target.value)}
                  placeholder="Provide instructions (optional)..."
                  className="w-full bg-muted border border-border rounded-md p-2 text-sm mb-3 resize-none"
                  rows={3}
                />

                <div className="flex gap-2">
                  <button
                    onClick={() => handleResolve(intervention.id, 'approve')}
                    className="px-3 py-1.5 bg-green-600 hover:bg-green-700 text-white text-sm rounded-md"
                  >
                    Approve & Continue
                  </button>
                  <button
                    onClick={() => handleResolve(intervention.id, 'modify')}
                    className="px-3 py-1.5 bg-primary hover:bg-primary/80 text-primary-foreground text-sm rounded-md"
                  >
                    Send Instructions
                  </button>
                  <button
                    onClick={() => handleResolve(intervention.id, 'reject')}
                    className="px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white text-sm rounded-md"
                  >
                    Skip Task
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
