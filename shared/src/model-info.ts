/**
 * Claude Model Information
 * Reference: https://platform.claude.com/docs/en/docs/about-claude/models
 * Updated: 2026-03
 */

export interface ModelInfo {
  id: string;           // Full API ID (e.g., claude-sonnet-4-20250514)
  alias: string;        // Short alias (e.g., sonnet)
  displayName: string;  // Human-readable name
  family: string;       // Model family (opus/sonnet/haiku)
  version: string;      // Version number (4, 4.5, 4.6, etc.)
  pricing: {
    inputPerMTok: number;   // USD per million input tokens
    outputPerMTok: number;  // USD per million output tokens
  };
  contextWindow: number;      // Default context window in tokens
  maxContextWindow?: number;  // Extended context (beta) in tokens
  maxOutput: number;          // Maximum output tokens
  features: {
    extendedThinking: boolean;
    adaptiveThinking: boolean;
    vision: boolean;
  };
  releaseDate?: string;       // Release date (YYYY-MM-DD)
  knowledgeCutoff?: string;   // Reliable knowledge cutoff
  deprecated?: boolean;
}

/**
 * Current/Latest Models (as of March 2026)
 */
export const CURRENT_MODELS: Record<string, ModelInfo> = {
  'opus': {
    id: 'claude-opus-4-6',
    alias: 'opus',
    displayName: 'Claude Opus 4.6',
    family: 'opus',
    version: '4.6',
    pricing: { inputPerMTok: 5, outputPerMTok: 25 },
    contextWindow: 200000,
    maxContextWindow: 1000000,
    maxOutput: 128000,
    features: { extendedThinking: true, adaptiveThinking: true, vision: true },
    releaseDate: '2026-02-05',
    knowledgeCutoff: 'May 2025',
  },
  'sonnet': {
    id: 'claude-sonnet-4-6',
    alias: 'sonnet',
    displayName: 'Claude Sonnet 4.6',
    family: 'sonnet',
    version: '4.6',
    pricing: { inputPerMTok: 3, outputPerMTok: 15 },
    contextWindow: 200000,
    maxContextWindow: 1000000,
    maxOutput: 64000,
    features: { extendedThinking: true, adaptiveThinking: true, vision: true },
    releaseDate: '2026-02-17',
    knowledgeCutoff: 'Aug 2025',
  },
  'haiku': {
    id: 'claude-haiku-4-5-20251001',
    alias: 'haiku',
    displayName: 'Claude Haiku 4.5',
    family: 'haiku',
    version: '4.5',
    pricing: { inputPerMTok: 1, outputPerMTok: 5 },
    contextWindow: 200000,
    maxOutput: 64000,
    features: { extendedThinking: true, adaptiveThinking: false, vision: true },
    releaseDate: '2025-10-15',
    knowledgeCutoff: 'Feb 2025',
  },
};

/**
 * Legacy Models (still available but consider migrating)
 */
export const LEGACY_MODELS: Record<string, ModelInfo> = {
  'sonnet-4.5': {
    id: 'claude-sonnet-4-5-20250929',
    alias: 'sonnet-4.5',
    displayName: 'Claude Sonnet 4.5',
    family: 'sonnet',
    version: '4.5',
    pricing: { inputPerMTok: 3, outputPerMTok: 15 },
    contextWindow: 200000,
    maxContextWindow: 1000000,
    maxOutput: 64000,
    features: { extendedThinking: true, adaptiveThinking: false, vision: true },
    knowledgeCutoff: 'Jan 2025',
  },
  'opus-4.5': {
    id: 'claude-opus-4-5-20251101',
    alias: 'opus-4.5',
    displayName: 'Claude Opus 4.5',
    family: 'opus',
    version: '4.5',
    pricing: { inputPerMTok: 5, outputPerMTok: 25 },
    contextWindow: 200000,
    maxOutput: 64000,
    features: { extendedThinking: true, adaptiveThinking: false, vision: true },
    releaseDate: '2025-11-24',
    knowledgeCutoff: 'May 2025',
  },
  'opus-4.1': {
    id: 'claude-opus-4-1-20250805',
    alias: 'opus-4.1',
    displayName: 'Claude Opus 4.1',
    family: 'opus',
    version: '4.1',
    pricing: { inputPerMTok: 15, outputPerMTok: 75 },
    contextWindow: 200000,
    maxOutput: 32000,
    features: { extendedThinking: true, adaptiveThinking: false, vision: true },
    knowledgeCutoff: 'Jan 2025',
  },
  'sonnet-4': {
    id: 'claude-sonnet-4-20250514',
    alias: 'sonnet-4',
    displayName: 'Claude Sonnet 4',
    family: 'sonnet',
    version: '4',
    pricing: { inputPerMTok: 3, outputPerMTok: 15 },
    contextWindow: 200000,
    maxContextWindow: 1000000,
    maxOutput: 64000,
    features: { extendedThinking: true, adaptiveThinking: false, vision: true },
    releaseDate: '2025-05-22',
    knowledgeCutoff: 'Jan 2025',
  },
  'opus-4': {
    id: 'claude-opus-4-20250514',
    alias: 'opus-4',
    displayName: 'Claude Opus 4',
    family: 'opus',
    version: '4',
    pricing: { inputPerMTok: 15, outputPerMTok: 75 },
    contextWindow: 200000,
    maxOutput: 32000,
    features: { extendedThinking: true, adaptiveThinking: false, vision: true },
    releaseDate: '2025-05-22',
    knowledgeCutoff: 'Jan 2025',
  },
  'haiku-3': {
    id: 'claude-3-haiku-20240307',
    alias: 'haiku-3',
    displayName: 'Claude Haiku 3',
    family: 'haiku',
    version: '3',
    pricing: { inputPerMTok: 0.25, outputPerMTok: 1.25 },
    contextWindow: 200000,
    maxOutput: 4000,
    features: { extendedThinking: false, adaptiveThinking: false, vision: true },
    deprecated: true,
  },
};

/**
 * All models combined
 */
export const ALL_MODELS: Record<string, ModelInfo> = {
  ...CURRENT_MODELS,
  ...LEGACY_MODELS,
};

/**
 * Parse a model ID string to extract family and version
 * e.g., "claude-sonnet-4-20250514" -> { family: "sonnet", version: "4" }
 */
export function parseModelId(modelId: string): { family: string; version: string; date?: string } | null {
  // Pattern: claude-{family}-{version}[-{date}]
  // Examples:
  //   claude-sonnet-4-20250514
  //   claude-opus-4-6
  //   claude-haiku-4-5-20251001
  const match = modelId.match(/^claude-(\w+)-(\d+(?:-\d+)?)(?:-(\d{8}))?$/);
  if (!match) return null;

  return {
    family: match[1],
    version: match[2].replace('-', '.'), // Convert "4-6" to "4.6"
    date: match[3],
  };
}

/**
 * Format a model ID for display (remove claude- prefix and date suffix)
 * e.g., "claude-sonnet-4-20250514" -> "sonnet-4"
 */
export function formatModelForDisplay(modelId: string): string {
  return modelId
    .replace(/^claude-/, '')
    .replace(/-\d{8}$/, '');
}

/**
 * Get model info by ID or alias
 */
export function getModelInfo(idOrAlias: string): ModelInfo | undefined {
  // Direct lookup
  if (ALL_MODELS[idOrAlias]) {
    return ALL_MODELS[idOrAlias];
  }

  // Search by ID
  return Object.values(ALL_MODELS).find(m => m.id === idOrAlias);
}

/**
 * Get selectable models for UI (current models only)
 */
export function getSelectableModels(): Array<{ value: string; label: string; description?: string }> {
  return [
    { value: 'sonnet', label: 'Sonnet', description: 'Best balance of speed and intelligence' },
    { value: 'opus', label: 'Opus', description: 'Most intelligent, for complex tasks' },
    { value: 'haiku', label: 'Haiku', description: 'Fastest, most cost-effective' },
  ];
}
