export const SHARED_GROUP_LABEL = '共用';

/**
 * 依功能代碼把清單分組。功能代碼由伺服器端算好（權威 extractFunctionCode，
 * 以 parent_name 優先、退回 title），前端只照這個值分組，不自行抽取。
 * 回傳 [代碼, 項目[]][]，代碼字母排序、共用組永遠排最後。
 */
export function groupByFunctionCode<T>(
  items: T[],
  getCode: (item: T) => string | null | undefined,
): Array<{ code: string; items: T[] }> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const code = getCode(item) || SHARED_GROUP_LABEL;
    const arr = groups.get(code);
    if (arr) arr.push(item);
    else groups.set(code, [item]);
  }
  return [...groups.entries()]
    .map(([code, groupItems]) => ({ code, items: groupItems }))
    .sort((a, b) => {
      if (a.code === SHARED_GROUP_LABEL) return 1;
      if (b.code === SHARED_GROUP_LABEL) return -1;
      return a.code.localeCompare(b.code);
    });
}
