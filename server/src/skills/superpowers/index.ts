import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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

  const filePath = join(__dirname, SKILL_FILES[feature]);
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
