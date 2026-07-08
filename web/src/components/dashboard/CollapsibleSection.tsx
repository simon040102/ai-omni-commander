import { useState, type ReactNode } from 'react';
import { IconChevronDown, IconChevronRight } from '../ui/Icons';

export interface SectionBadge {
  label: string;
  count: number;
  /** red = attention (rendered red only when count > 0); gray = informational */
  tone: 'red' | 'gray';
}

interface CollapsibleSectionProps {
  title: string;
  badges?: SectionBadge[];
  /** Default expand state (e.g. any red badge > 0); a manual toggle overrides it */
  defaultExpanded?: boolean;
  children: ReactNode;
}

/**
 * Collapsible dashboard section with count badges in the header.
 * Collapsed by default; auto-expands while defaultExpanded is true,
 * unless the user has toggled it manually.
 */
export function CollapsibleSection({ title, badges = [], defaultExpanded = false, children }: CollapsibleSectionProps) {
  const [userToggled, setUserToggled] = useState<boolean | null>(null);
  const expanded = userToggled ?? defaultExpanded;

  return (
    <div className="bg-card border border-border rounded-lg flex-shrink-0">
      <button
        onClick={() => setUserToggled(!expanded)}
        className="w-full flex items-center gap-2.5 px-4 py-3 text-left hover:bg-muted/30 rounded-lg transition-colors"
      >
        {expanded
          ? <IconChevronDown className="w-4 h-4 text-muted-foreground flex-shrink-0" />
          : <IconChevronRight className="w-4 h-4 text-muted-foreground flex-shrink-0" />}
        <span className="text-sm font-semibold text-foreground">{title}</span>
        {badges.map(b => (
          <span
            key={b.label}
            className={`px-2 py-0.5 rounded-full text-xs font-bold ${
              b.tone === 'red' && b.count > 0
                ? 'bg-red-500/20 text-red-400'
                : 'bg-muted text-muted-foreground'
            }`}
          >
            {b.label} {b.count}
          </span>
        ))}
      </button>
      {expanded && <div className="px-4 pb-3 space-y-3">{children}</div>}
    </div>
  );
}
