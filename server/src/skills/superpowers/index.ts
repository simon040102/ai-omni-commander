import { readFileSync, existsSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * .md 放在哪：tsc 只編 .ts、不會把 .md 複製進 dist。Web Server 以 tsx 從 src 跑所以一直讀得到；
 * MCP 從 dist 跑（在自己 process 組執行計畫），模組旁沒有 .md → 退回 server/src 的對應位置。
 * 兩邊都沒有就回模組目錄，讓讀檔照原樣報 ENOENT（不吞錯）。
 */
export function resolveSkillDir(moduleDir: string, exists: (p: string) => boolean = existsSync): string {
  const probe = (dir: string) => exists(join(dir, 'brainstorm.md'));
  if (probe(moduleDir)) return moduleDir;
  // dist/skills/superpowers → ../../../src/skills/superpowers（從 src 跑時這條等於自己）
  const srcDir = resolve(moduleDir, '..', '..', '..', 'src', 'skills', 'superpowers');
  return probe(srcDir) ? srcDir : moduleDir;
}

const SKILL_DIR = resolveSkillDir(__dirname);

export type SuperpowersFeature = 'brainstorm' | 'tdd' | 'debugging';

const SKILL_FILES: Record<SuperpowersFeature, string> = {
  brainstorm: 'brainstorm.md',
  tdd: 'tdd.md',
  debugging: 'debugging.md',
};

const skillCache: Map<SuperpowersFeature, string> = new Map();

/**
 * Load a single Superpowers skill prompt
 */
export function loadSkill(feature: SuperpowersFeature): string {
  if (skillCache.has(feature)) {
    return skillCache.get(feature)!;
  }

  const filePath = join(SKILL_DIR, SKILL_FILES[feature]);
  const content = readFileSync(filePath, 'utf-8');
  skillCache.set(feature, content);
  return content;
}

/**
 * Load and combine multiple Superpowers skills into a single prompt
 */
export function loadSuperpowersPrompt(features: SuperpowersFeature[]): string {
  if (features.length === 0) {
    return '';
  }

  const header = `# Superpowers Development Methodology

You MUST follow these development methodologies throughout this task.
These rules take precedence over default behaviors but can be overridden by project-specific instructions.

---

`;

  const skillContents = features.map(f => loadSkill(f)).join('\n\n---\n\n');

  return header + skillContents;
}

/**
 * Get all available Superpowers features
 */
export function getAvailableFeatures(): SuperpowersFeature[] {
  return Object.keys(SKILL_FILES) as SuperpowersFeature[];
}
