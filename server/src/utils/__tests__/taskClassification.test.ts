import { describe, it, expect } from 'vitest';
import { detectLabel, detectLabelFromTitle, detectTaskType, classifyTask } from '../taskClassification.js';

describe('taskClassification (shared pure module)', () => {
  describe('detectLabelFromTitle — explicit markers', () => {
    it('前端 → frontend', () => {
      expect(detectLabelFromTitle('SM27_專案成員維護-前端')).toBe('frontend');
    });

    it('串接 → frontend', () => {
      expect(detectLabelFromTitle('DF01 收文單 串接')).toBe('frontend');
    });

    it('後端 → backend', () => {
      expect(detectLabelFromTitle('WA05 簽核流程-後端')).toBe('backend');
    });

    it('前端/串接 wins over 後端 (MCP canonical ordering)', () => {
      expect(detectLabelFromTitle('串接後端 API')).toBe('frontend');
    });

    it('no marker → null (caller decides default)', () => {
      expect(detectLabelFromTitle('SM26 使用者帳號維護')).toBeNull();
    });
  });

  describe('detectLabel — with canonical default', () => {
    it('defaults to frontend when no marker (aligned with MCP sync_asana_tasks)', () => {
      expect(detectLabel('SM26 使用者帳號維護')).toBe('frontend');
    });

    it('後端 → backend', () => {
      expect(detectLabel('報表匯出-後端')).toBe('backend');
    });
  });

  describe('detectTaskType', () => {
    it('English bug keywords → bug', () => {
      expect(detectTaskType('Fix login crash')).toBe('bug');
    });

    it('Chinese bug keywords (失效/錯誤) → bug', () => {
      expect(detectTaskType('查詢欄位失效')).toBe('bug');
      expect(detectTaskType('儲存錯誤')).toBe('bug');
    });

    it('bug wins over feature when both present', () => {
      expect(detectTaskType('Fix new feature crash')).toBe('bug');
    });

    it('重構 → refactor', () => {
      expect(detectTaskType('重構資料存取層')).toBe('refactor');
    });

    it('新增/開發 → feature', () => {
      expect(detectTaskType('新增匯出功能')).toBe('feature');
      expect(detectTaskType('開發收文單')).toBe('feature');
    });

    it('description is also scanned', () => {
      expect(detectTaskType('SM27', '查詢結果 wrong')).toBe('bug');
    });

    it('nothing matches → other', () => {
      expect(detectTaskType('例行維護')).toBe('other');
    });
  });

  describe('classifyTask', () => {
    it('combines taskType and label', () => {
      expect(classifyTask('SM27 共用_查詢工程專案-前端 查詢欄位失效')).toEqual({ taskType: 'bug', label: 'frontend' });
    });

    it('default label frontend + type other', () => {
      expect(classifyTask('文件整理')).toEqual({ taskType: 'other', label: 'frontend' });
    });
  });
});
