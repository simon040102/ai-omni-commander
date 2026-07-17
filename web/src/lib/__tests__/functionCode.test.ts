import { describe, it, expect } from 'vitest';
import { groupByFunctionCode, SHARED_GROUP_LABEL } from '../functionCode';

interface Row { id: string; code: string | null }

describe('groupByFunctionCode', () => {
  it('groups items by their function code, alphabetically, with 共用 always last', () => {
    const items: Row[] = [
      { id: '1', code: 'SM27' },
      { id: '2', code: 'DF01' },
      { id: '3', code: 'SM27' },
      { id: '4', code: null },       // → 共用
      { id: '5', code: 'DF01' },
    ];

    const groups = groupByFunctionCode(items, r => r.code);

    expect(groups.map(g => g.code)).toEqual(['DF01', 'SM27', SHARED_GROUP_LABEL]);
    expect(groups[0].items.map(i => i.id)).toEqual(['2', '5']);
    expect(groups[1].items.map(i => i.id)).toEqual(['1', '3']);
    expect(groups[2].items.map(i => i.id)).toEqual(['4']);
  });

  it('treats undefined/empty codes as the shared group', () => {
    const items: Row[] = [
      { id: 'a', code: undefined as unknown as null },
      { id: 'b', code: '' },
      { id: 'c', code: 'WA05' },
    ];
    const groups = groupByFunctionCode(items, r => r.code);
    expect(groups.map(g => g.code)).toEqual(['WA05', SHARED_GROUP_LABEL]);
    expect(groups[1].items.map(i => i.id)).toEqual(['a', 'b']);
  });

  it('preserves insertion order within a group', () => {
    const items: Row[] = [
      { id: 'x1', code: 'A' },
      { id: 'x2', code: 'A' },
      { id: 'x3', code: 'A' },
    ];
    const groups = groupByFunctionCode(items, r => r.code);
    expect(groups).toHaveLength(1);
    expect(groups[0].items.map(i => i.id)).toEqual(['x1', 'x2', 'x3']);
  });

  it('returns [] for an empty input', () => {
    expect(groupByFunctionCode([], (r: Row) => r.code)).toEqual([]);
  });
});
