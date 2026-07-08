import { useProjectStore } from '../../stores/projectStore';
import { usePanelData } from '../../hooks/usePanelData';
import { CollapsibleSection } from './CollapsibleSection';
import { SpecGapsPanel, type SpecGap } from './SpecGapsPanel';
import { SpecCompliancePanel, type ComplianceTaskSummary } from './SpecCompliancePanel';
import { ProjectNotesPanel, type ProjectNote } from './ProjectNotesPanel';

/**
 * 規格治理 — collapsible section grouping the three governance panels:
 * 待補規格 (spec gaps) / 規格回對 (spec compliance) / 專案筆記 (project notes).
 * Collapsed by default; auto-expands when any red count > 0.
 */
export function SpecGovernanceSection() {
  const currentProjectId = useProjectStore(s => s.currentProjectId);
  const pid = currentProjectId ? encodeURIComponent(currentProjectId) : null;

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

  return (
    <CollapsibleSection
      title="規格治理"
      badges={[
        { label: '待補規格', count: openGapCount, tone: 'red' },
        { label: '回對 missing', count: missingCount, tone: 'red' },
        { label: '筆記', count: activeNoteCount, tone: 'gray' },
      ]}
      defaultExpanded={openGapCount > 0 || missingCount > 0}
    >
      <SpecGapsPanel gaps={gaps} loading={gapsData.loading} error={gapsData.error} refetch={gapsData.refetch} />
      <SpecCompliancePanel taskSummaries={taskSummaries} loading={complianceData.loading} error={complianceData.error} refetch={complianceData.refetch} />
      <ProjectNotesPanel notes={notes} loading={notesData.loading} error={notesData.error} refetch={notesData.refetch} />
    </CollapsibleSection>
  );
}
