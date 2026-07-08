import { useState } from 'react';
import { useProjectStore } from '../../stores/projectStore';
import { usePanelData } from '../../hooks/usePanelData';
import { CollapsibleSection } from './CollapsibleSection';
import { SpecGapsPanel, type SpecGap } from './SpecGapsPanel';
import { SpecCompliancePanel, type ComplianceTaskSummary } from './SpecCompliancePanel';
import { ProjectNotesPanel, type ProjectNote } from './ProjectNotesPanel';
import { groupByFunctionCode } from '../../lib/functionCode';

type Category = 'gaps' | 'compliance' | 'notes';

/**
 * 規格治理（獨立頁）— 上方 tab 選類別（待補規格 / 規格回對 / 專案筆記）；
 * 待補規格、規格回對的內容再依功能代碼（WA05、DF01…）分組，無代碼歸「共用」，
 * 各功能代碼組可展開/收合。專案筆記無功能代碼，平鋪為共用內容。
 */
export function SpecGovernanceView() {
  const currentProjectId = useProjectStore(s => s.currentProjectId);
  const pid = currentProjectId ? encodeURIComponent(currentProjectId) : null;
  const [category, setCategory] = useState<Category>('gaps');

  const gapsData = usePanelData<{ gaps: SpecGap[] }>(
    pid && `/api/spec-gaps/${pid}`, 'omni:spec-gap');
  const complianceData = usePanelData<{ tasks: ComplianceTaskSummary[] }>(
    pid && `/api/spec-compliance/project/${pid}`, 'omni:spec-compliance');
  const notesData = usePanelData<{ notes: ProjectNote[] }>(
    pid && `/api/project-notes/${pid}`, 'omni:project-note');

  const gaps = gapsData.data?.gaps ?? [];
  const taskSummaries = complianceData.data?.tasks ?? [];
  const notes = notesData.data?.notes ?? [];

  const openGapCount = gaps.filter(g => g.status === 'open').length;
  const missingCount = taskSummaries.reduce((sum, t) => sum + (t.latestRun?.missing ?? 0), 0);
  const activeNoteCount = notes.filter(n => n.active).length;

  if (!currentProjectId) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
        尚未選擇專案 — 請先從 Projects 選一個專案。
      </div>
    );
  }

  const tabs: { key: Category; label: string; count: number; tone: 'red' | 'gray' }[] = [
    { key: 'gaps', label: '待補規格', count: openGapCount, tone: 'red' },
    { key: 'compliance', label: '規格回對', count: missingCount, tone: 'red' },
    { key: 'notes', label: '專案筆記', count: activeNoteCount, tone: 'gray' },
  ];

  const gapGroups = groupByFunctionCode(gaps, g => g.functionCode);
  const complianceGroups = groupByFunctionCode(taskSummaries, t => t.functionCode);

  return (
    <div className="p-4 overflow-y-auto h-full space-y-3">
      <div>
        <h1 className="text-lg font-semibold text-foreground">規格治理</h1>
        <p className="text-xs text-muted-foreground mt-0.5">
          選類別後，內容依功能代碼分組（無代碼歸「共用」）。
        </p>
      </div>

      {/* ─── 類別 tab ─── */}
      <div className="flex gap-1 border-b border-border">
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => setCategory(t.key)}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border-b-2 -mb-px transition-colors ${
              category === t.key
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {t.label}
            <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-bold ${
              t.tone === 'red' && t.count > 0 ? 'bg-red-500/20 text-red-400' : 'bg-muted text-muted-foreground'
            }`}>
              {t.count}
            </span>
          </button>
        ))}
      </div>

      {/* ─── 待補規格：依功能代碼分組 ─── */}
      {category === 'gaps' && (
        gapsData.loading ? <PanelHint text="載入中…" />
        : gapsData.error ? <PanelError refetch={gapsData.refetch} />
        : gapGroups.length === 0 ? <PanelHint text="目前沒有待補規格。" />
        : gapGroups.map(group => {
            const openInGroup = group.items.filter(g => g.status === 'open').length;
            return (
              <CollapsibleSection
                key={group.code}
                title={group.code}
                badges={[{ label: '未解決', count: openInGroup, tone: 'red' }]}
                defaultExpanded={openInGroup > 0}
              >
                <SpecGapsPanel gaps={group.items} loading={false} error={false} refetch={gapsData.refetch} />
              </CollapsibleSection>
            );
          })
      )}

      {/* ─── 規格回對：依功能代碼分組 ─── */}
      {category === 'compliance' && (
        complianceData.loading ? <PanelHint text="載入中…" />
        : complianceData.error ? <PanelError refetch={complianceData.refetch} />
        : complianceGroups.length === 0 ? <PanelHint text="目前沒有規格回對資料。" />
        : complianceGroups.map(group => {
            const missingInGroup = group.items.reduce((s, t) => s + (t.latestRun?.missing ?? 0), 0);
            return (
              <CollapsibleSection
                key={group.code}
                title={group.code}
                badges={[{ label: 'missing', count: missingInGroup, tone: 'red' }]}
                defaultExpanded={missingInGroup > 0}
              >
                <SpecCompliancePanel taskSummaries={group.items} loading={false} error={false} refetch={complianceData.refetch} />
              </CollapsibleSection>
            );
          })
      )}

      {/* ─── 專案筆記：無功能代碼，平鋪為共用內容 ─── */}
      {category === 'notes' && (
        <ProjectNotesPanel notes={notes} loading={notesData.loading} error={notesData.error} refetch={notesData.refetch} />
      )}
    </div>
  );
}

function PanelHint({ text }: { text: string }) {
  return <div className="text-xs text-muted-foreground px-1 py-4 text-center">{text}</div>;
}

function PanelError({ refetch }: { refetch: () => Promise<void> }) {
  return (
    <div className="text-xs text-muted-foreground px-1 py-4 text-center">
      載入失敗 — <button onClick={() => void refetch()} className="text-primary hover:underline">重試</button>
    </div>
  );
}
