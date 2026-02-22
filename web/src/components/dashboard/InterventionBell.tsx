import { useState, useEffect } from 'react';
import { useProjectStore } from '../../stores/projectStore';
import { useWsStore } from '../../stores/wsStore';
import { IconBell, IconX } from '../ui/Icons';

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
        className="relative p-1.5 rounded-md hover:bg-muted transition-colors"
      >
        <IconBell className="w-4 h-4 text-muted-foreground" />
        {pending.length > 0 && (
          <span className="absolute -top-0.5 -right-0.5 w-4 h-4 bg-red-500 text-white text-[9px] font-bold rounded-full flex items-center justify-center animate-bounce">
            {pending.length}
          </span>
        )}
      </button>

      {/* Modal */}
      {isOpen && pending.length > 0 && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-card border border-border rounded-lg w-full max-w-lg mx-4 max-h-[80vh] overflow-auto shadow-2xl animate-fade-in">
            <div className="p-4 border-b border-border flex items-center justify-between">
              <h2 className="font-bold text-lg">Needs Your Attention</h2>
              <button
                onClick={() => setIsOpen(false)}
                className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              >
                <IconX className="w-4 h-4" />
              </button>
            </div>

            {pending.map(intervention => (
              <div key={intervention.id} className="p-4 border-b border-border">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-xs px-2 py-0.5 rounded bg-yellow-500/15 text-yellow-400">
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
                  className="w-full bg-muted border border-border rounded-md p-2.5 text-sm mb-3 resize-none outline-none focus:border-primary focus:ring-1 focus:ring-primary/30"
                  rows={3}
                />

                <div className="flex gap-2">
                  <button
                    onClick={() => handleResolve(intervention.id, 'approve')}
                    className="inline-flex items-center gap-1.5 px-4 py-2 bg-green-600 hover:bg-green-500 text-white text-sm font-medium rounded-lg transition-colors"
                  >
                    Approve & Continue
                  </button>
                  <button
                    onClick={() => handleResolve(intervention.id, 'modify')}
                    className="inline-flex items-center gap-1.5 px-4 py-2 bg-primary hover:bg-primary/90 text-primary-foreground text-sm font-medium rounded-lg transition-colors"
                  >
                    Send Instructions
                  </button>
                  <button
                    onClick={() => handleResolve(intervention.id, 'reject')}
                    className="inline-flex items-center gap-1.5 px-4 py-2 bg-red-500/10 text-red-400 border border-red-500/20 text-sm font-medium rounded-lg hover:bg-red-500/20 transition-colors"
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
