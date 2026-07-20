/**
 * Asana due date (due_on) 共用純函式。
 *
 * tasks.due_date 存 Asana due_on 原樣（YYYY-MM-DD）；非字串一律 null。
 * 兩條同步路徑（MCP sync_asana_tasks / Web AsanaSyncService）與讀取面
 * （next_task 排序、list_pending_tasks overdue 標示）共用，避免規則漂移。
 */

/** 正規化 Asana due_on：只接受非空字串（YYYY-MM-DD 原樣保留），其他一律 null。 */
export function normalizeDueDate(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** 本地時區的今天（YYYY-MM-DD）。due_on 是無時區的日期，用本地日比較最符合直覺。 */
export function localTodayYmd(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/** 是否已逾期（due_date 嚴格早於今天）。YYYY-MM-DD 字串可直接字典序比較。 */
export function isOverdue(dueDate: string | null | undefined, today: string = localTodayYmd()): boolean {
  return !!dueDate && dueDate < today;
}

/**
 * 到期資訊描述文字（推薦理由用）：
 * 「已逾期 N 天」/「今天到期」/「N 天後到期」；無 due 或格式無法解析 → null。
 */
export function describeDueDate(dueDate: string | null | undefined, today: string = localTodayYmd()): string | null {
  if (!dueDate) return null;
  // 以 UTC 錨定兩個日期字串做整數天差（避免時區/DST 影響天數計算）
  const due = Date.parse(`${dueDate}T00:00:00Z`);
  const base = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(due) || Number.isNaN(base)) return null;
  const diffDays = Math.round((due - base) / 86_400_000);
  if (diffDays < 0) return `已逾期 ${-diffDays} 天`;
  if (diffDays === 0) return '今天到期';
  return `${diffDays} 天後到期`;
}
