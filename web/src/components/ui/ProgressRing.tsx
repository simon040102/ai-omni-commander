interface ProgressRingProps {
  percentage: number;
  size?: number;
  strokeWidth?: number;
  phase?: string;
}

export function ProgressRing({
  percentage,
  size = 40,
  strokeWidth = 3,
  phase,
}: ProgressRingProps) {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (Math.min(Math.max(percentage, 0), 100) / 100) * circumference;

  const color =
    percentage >= 70 ? '#22c55e' : percentage >= 30 ? '#eab308' : '#ef4444';

  return (
    <div
      className="relative inline-flex items-center justify-center"
      style={{ width: size, height: size }}
      title={phase ? `${phase} — ${Math.round(percentage)}%` : `${Math.round(percentage)}%`}
    >
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={strokeWidth}
          className="text-gray-700"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          className="transition-all duration-500 ease-out"
        />
      </svg>
      <span className="absolute text-[10px] font-medium text-gray-300">
        {Math.round(percentage)}
      </span>
    </div>
  );
}
