// Scores one case against what a hook did with it. The results hold indexes, type names
// and timings only, never the case text or a planted value, so they are safe to persist.
import type { Case } from './case.ts';
import type { BashOutcome, PromptOutcome } from './classify.ts';
import { expectedTypes } from './taxonomy.ts';

export interface OutputResult {
  outcome: BashOutcome['kind'];
  /** Set when the outcome is an error. */
  errorName?: string;
  /** Finding types the hook reported. */
  types: string[];
  /** Mask tags in the masked text that the original did not contain, as type names. */
  tags: string[];
  /** Indexes into the case's planted values that the model would still see. */
  leaked: number[];
  ms: number;
}

export interface PromptResult {
  outcome: PromptOutcome['kind'];
  errorName?: string;
  types: string[];
  /** Types the case's planted values should have raised that the block did not name. */
  missing: string[];
  /** Reported types the template does not define. */
  unknown: string[];
  ms: number;
}

function maskTags(original: string, masked: string): string[] {
  const tagsIn = (text: string) => new Set([...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]));
  const before = tagsIn(original);
  return [...tagsIn(masked)].filter((tag) => !before.has(tag));
}

export function scoreOutput(testCase: Case, outcome: BashOutcome, ms: number): OutputResult {
  const result: OutputResult = { outcome: outcome.kind, types: [], tags: [], leaked: [], ms };
  if (outcome.kind === 'error') result.errorName = outcome.name;
  if (outcome.kind === 'masked') {
    result.types = outcome.types;
    result.tags = maskTags(testCase.text, outcome.text);
  }
  const seen = outcome.kind === 'masked' ? outcome.text : outcome.kind === 'unchanged' ? testCase.text : undefined;
  if (seen !== undefined) {
    result.leaked = testCase.planted.flatMap((planted, index) => (seen.includes(planted.value) ? [index] : []));
  }
  return result;
}

export function scorePrompt(
  testCase: Case,
  outcome: PromptOutcome,
  ms: number,
  knownTypes: ReadonlySet<string>,
): PromptResult {
  const result: PromptResult = { outcome: outcome.kind, types: [], missing: [], unknown: [], ms };
  if (outcome.kind === 'error') result.errorName = outcome.name;
  if (outcome.kind === 'blocked') {
    const expected = new Set(testCase.planted.flatMap((p) => expectedTypes(p.category, p.sub) ?? []));
    result.types = outcome.types;
    result.missing = [...expected].filter((type) => !outcome.types.includes(type));
    result.unknown = outcome.types.filter((type) => !knownTypes.has(type));
  }
  return result;
}
