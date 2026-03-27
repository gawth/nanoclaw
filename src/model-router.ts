export const MODEL_HAIKU = 'claude-haiku-4-5-20251001';
export const MODEL_SONNET = 'claude-sonnet-4-6';
export const MODEL_OPUS = 'claude-opus-4-6';

const OVERRIDE_PATTERNS: Array<[RegExp, string]> = [
  [/^use haiku[:\s]\s*/i, MODEL_HAIKU],
  [/^use sonnet[:\s]\s*/i, MODEL_SONNET],
  [/^use opus[:\s]\s*/i, MODEL_OPUS],
];

const COMPLEX_KEYWORDS = [
  'research',
  'find out',
  'summarize',
  'summary',
  'explain',
  'analyze',
  'analyse',
  'compare',
  'review',
  'think through',
  'figure out',
  'plan',
  'decide',
  'draft',
  'write',
  'compose',
  'email',
  'letter',
  'report',
  'help me think',
  'help me plan',
  'work out',
];

export interface ModelSelection {
  model: string;
  prompt: string;
}

/**
 * Detect an explicit model override prefix ("use haiku: ...") and strip it,
 * or fall back to heuristic classification.
 */
export function selectModel(prompt: string): ModelSelection {
  for (const [pattern, model] of OVERRIDE_PATTERNS) {
    if (pattern.test(prompt)) {
      return { model, prompt: prompt.replace(pattern, '').trim() };
    }
  }
  return { model: classifyModel(prompt), prompt };
}

/**
 * Heuristic model selection for a personal assistant workload.
 * Long prompts or complexity keywords → Sonnet; everything else → Haiku.
 */
export function classifyModel(prompt: string): string {
  const lower = prompt.toLowerCase();
  if (
    prompt.length > 500 ||
    COMPLEX_KEYWORDS.some((kw) => lower.includes(kw))
  ) {
    return MODEL_SONNET;
  }
  return MODEL_HAIKU;
}
