import { useState } from 'react';
import type { ReviewResult } from '../../stores/projectStore';

interface ReviewBadgeProps {
  result: ReviewResult;
}

const severityColor = {
  critical: 'text-red-400',
  warning: 'text-yellow-400',
  info: 'text-blue-400',
};

export function ReviewBadge({ result }: ReviewBadgeProps) {
  const [expanded, setExpanded] = useState(false);
  const isPass = result.verdict === 'pass';

  return (
    <div className="inline-block">
      <button
        onClick={() => setExpanded(!expanded)}
        className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium border transition-colors ${
          isPass
            ? 'bg-green-900/40 text-green-400 border-green-700 hover:bg-green-900/60'
            : 'bg-red-900/40 text-red-400 border-red-700 hover:bg-red-900/60'
        }`}
      >
        <span>{isPass ? '✅' : '❌'}</span>
        <span>{result.score}/100</span>
        {result.issues.length > 0 && (
          <span className="opacity-60">({result.issues.length})</span>
        )}
      </button>

      {expanded && result.issues.length > 0 && (
        <div className="mt-2 rounded-lg border border-gray-700 bg-gray-800/80 p-3 text-xs space-y-2 max-h-60 overflow-y-auto">
          <p className="text-gray-400 mb-1">{result.summary}</p>
          {result.issues.map((issue, i) => (
            <div key={i} className="flex gap-2">
              <span className={`font-medium uppercase ${severityColor[issue.severity]}`}>
                {issue.severity}
              </span>
              <span className="text-gray-300">
                {issue.file}{issue.line ? `:${issue.line}` : ''} — {issue.message}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
