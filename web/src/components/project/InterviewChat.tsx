import { useState, useEffect, useRef } from 'react';
import { useWsStore } from '../../stores/wsStore';

interface Message {
  role: 'user' | 'architect';
  content: string;
  timestamp: string;
}

interface InterviewChatProps {
  projectId: string;
}

export function InterviewChat({ projectId }: InterviewChatProps) {
  const client = useWsStore(s => s.client);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [started, setStarted] = useState(false);
  const [specDraft, setSpecDraft] = useState<{ sa: string; sd: string } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Listen for interview events
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      const type = detail.type as string;

      if (type === 'interview.question') {
        setMessages(prev => [...prev, {
          role: 'architect',
          content: detail.payload.question,
          timestamp: new Date().toISOString(),
        }]);
      } else if (type === 'interview.specDraft') {
        setSpecDraft({
          sa: detail.payload.saDocument,
          sd: detail.payload.sdDocument,
        });
      }
    };

    window.addEventListener('omni:interview', handler);
    return () => window.removeEventListener('omni:interview', handler);
  }, []);

  // Auto-scroll
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages.length]);

  const handleStart = () => {
    if (!input.trim()) return;

    // Start the interview with the initial requirement
    client?.send({
      type: 'interview.userResponse',
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      payload: { projectId, message: input },
    });

    setMessages([{ role: 'user', content: input, timestamp: new Date().toISOString() }]);
    setInput('');
    setStarted(true);
  };

  const handleSend = () => {
    if (!input.trim()) return;

    client?.send({
      type: 'interview.userResponse',
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      payload: { projectId, message: input },
    });

    setMessages(prev => [...prev, {
      role: 'user',
      content: input,
      timestamp: new Date().toISOString(),
    }]);
    setInput('');
  };

  const handleConfirmSpec = (confirmed: boolean) => {
    client?.send({
      type: 'interview.confirmSpec',
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      payload: { projectId, confirmed },
    });
  };

  if (!started) {
    return (
      <div className="space-y-4">
        <h3 className="text-lg font-medium">Describe Your Idea</h3>
        <p className="text-sm text-muted-foreground">
          Tell the AI architect about your project. Be as detailed or as vague as you want.
        </p>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="I want to build..."
          className="w-full bg-muted border border-border rounded-md px-3 py-2 text-sm min-h-[120px] resize-y"
        />
        <button
          onClick={handleStart}
          disabled={!input.trim()}
          className="px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-md text-sm disabled:opacity-50"
        >
          Start Interview
        </button>
      </div>
    );
  }

  // Show spec draft for review
  if (specDraft) {
    return (
      <div className="space-y-4">
        <h3 className="text-lg font-medium">Generated Specification</h3>
        <div className="grid grid-cols-2 gap-4">
          <div className="bg-muted border border-border rounded-lg p-4">
            <h4 className="font-bold mb-2">System Analysis (SA)</h4>
            <div className="text-sm whitespace-pre-wrap max-h-96 overflow-auto">
              {specDraft.sa}
            </div>
          </div>
          <div className="bg-muted border border-border rounded-lg p-4">
            <h4 className="font-bold mb-2">System Design (SD)</h4>
            <div className="text-sm whitespace-pre-wrap max-h-96 overflow-auto">
              {specDraft.sd}
            </div>
          </div>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => handleConfirmSpec(true)}
            className="px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-md text-sm"
          >
            Confirm & Start Execution
          </button>
          <button
            onClick={() => { setSpecDraft(null); }}
            className="px-4 py-2 bg-muted text-foreground rounded-md text-sm"
          >
            Request Changes
          </button>
        </div>
      </div>
    );
  }

  // Chat interface
  return (
    <div className="flex flex-col h-[500px]">
      <h3 className="text-lg font-medium mb-3">Architect Interview</h3>

      <div ref={scrollRef} className="flex-1 overflow-auto space-y-3 mb-3">
        {messages.map((msg, i) => (
          <div
            key={i}
            className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            <div className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
              msg.role === 'user'
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-foreground'
            }`}>
              {msg.content}
            </div>
          </div>
        ))}
      </div>

      <div className="flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleSend()}
          placeholder="Type your response..."
          className="flex-1 bg-muted border border-border rounded-md px-3 py-2 text-sm"
        />
        <button
          onClick={handleSend}
          disabled={!input.trim()}
          className="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm disabled:opacity-50"
        >
          Send
        </button>
      </div>
    </div>
  );
}
