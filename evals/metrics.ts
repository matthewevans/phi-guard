// Aggregates scored runs. Pure: no I/O, no hook calls.
import type { Case, Planted } from './case.ts';
import { UNRECOGNIZED_OUTPUT } from './classify.ts';
import type { OutputResult, PromptResult } from './score.ts';
import { TAXONOMY } from './taxonomy.ts';

// Guardrails PII filter: $0.10 per 1,000 text units, regexes free. The rate is the one
// in docs/ARCHITECTURE.md (https://aws.amazon.com/bedrock/pricing/); it has not been
// re-checked against the pricing page since, which is Part 2 work.
const PII_FILTER_USD_PER_THOUSAND_UNITS = 0.1;

const WILSON_Z_95 = 1.96;

export interface Run {
  testCase: Case;
  output: OutputResult;
  prompt?: PromptResult;
}

export interface Rate {
  hits: number;
  total: number;
  /** NaN when there is nothing to divide. */
  value: number;
  /** Wilson score interval at 95%. */
  low: number;
  high: number;
}

export function rate(hits: number, total: number): Rate {
  if (total === 0) return { hits, total, value: Number.NaN, low: 0, high: 1 };
  const p = hits / total;
  const z2 = WILSON_Z_95 ** 2;
  const scale = 1 + z2 / total;
  const centre = (p + z2 / (2 * total)) / scale;
  const margin = (WILSON_Z_95 * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total ** 2))) / scale;
  return { hits, total, value: p, low: Math.max(0, centre - margin), high: Math.min(1, centre + margin) };
}

const share = (flags: readonly boolean[]) => rate(flags.filter(Boolean).length, flags.length);

export interface Latency {
  p50: number;
  p95: number;
  max: number;
}

export function latency(samples: readonly number[]): Latency | undefined {
  if (samples.length === 0) return undefined;
  const sorted = [...samples].sort((a, b) => a - b);
  const nearestRank = (percent: number) => sorted[Math.max(0, Math.ceil((percent / 100) * sorted.length) - 1)];
  return { p50: nearestRank(50), p95: nearestRank(95), max: sorted[sorted.length - 1] };
}

/** The pricing rule: one text unit per started 1,000 characters of a scanned stream. */
export const textUnits = (text: string) => Math.ceil(text.length / 1000);

export const estimatedCost = (units: number) => (units / 1000) * PII_FILTER_USD_PER_THOUSAND_UNITS;

function countErrors(results: readonly { errorName?: string }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const { errorName } of results) if (errorName !== undefined) counts[errorName] = (counts[errorName] ?? 0) + 1;
  return counts;
}

export interface Summary {
  cases: number;
  recall: Rate;
  falsePositives: Rate;
  errors: Record<string, number>;
  latency: Latency | undefined;
  units: number;
  cost: number;
}

export interface OutputSummary extends Summary {
  /** Outputs the guardrail replaced wholesale with its blocked message. */
  withheld: number;
  /** Mask tag type names seen in masked text. */
  tags: string[];
}

export interface PromptSummary extends Summary {
  /** Blocked positives whose block did not name every expected type. */
  typeMisses: number;
  /** Reported types the template does not define. */
  unknownTypes: string[];
}

const isNegative = ({ testCase }: Run) => testCase.planted.length === 0;
/** The default scope of a recall: values in a category the guardrail is expected to cover. */
const inCoveredCategory = ({ category }: Planted) => TAXONOMY[category].coverage !== 'gap';
const sorted = (values: Iterable<string>) => [...new Set(values)].sort();

type Timed = { ms: number; errorName?: string };

function common(runs: readonly Run[], results: readonly Timed[]): Omit<Summary, 'recall' | 'falsePositives'> {
  const units = runs.reduce((sum, { testCase }) => sum + textUnits(testCase.text), 0);
  return {
    cases: runs.length,
    errors: countErrors(results),
    latency: latency(results.map(({ ms }) => ms)),
    units,
    cost: estimatedCost(units),
  };
}

/**
 * Output-surface recall counts planted values the model would not see, from masked and
 * unchanged outputs only: a withheld output says nothing about any one value. `include`
 * picks the values counted (by default, those in categories that are not gaps). A masked
 * or withheld negative is a false positive. Errors count as neither.
 */
export function summarizeOutput(
  runs: readonly Run[],
  include: (planted: Planted) => boolean = inCoveredCategory,
): OutputSummary {
  const scored = runs.filter(({ output }) => output.outcome !== 'error');
  const values = scored
    .filter(({ output }) => output.outcome !== 'withheld')
    .flatMap(({ testCase, output }) =>
      testCase.planted.flatMap((planted, index) => (include(planted) ? [!output.leaked.includes(index)] : [])),
    );
  const outputs = runs.map(({ output }) => output);
  return {
    ...common(runs, outputs),
    recall: share(values),
    falsePositives: share(scored.filter(isNegative).map(({ output }) => output.outcome !== 'unchanged')),
    withheld: outputs.filter(({ outcome }) => outcome === 'withheld').length,
    tags: sorted(outputs.flatMap(({ tags }) => tags)),
  };
}

type PromptRun = Run & { prompt: PromptResult };
const hasPrompt = (run: Run): run is PromptRun => run.prompt !== undefined;

/**
 * Prompt-surface recall counts positive cases blocked with every expected type named. A
 * positive is a case with at least one value `include` accepts (by default, one in a
 * category that is not a gap).
 */
export function summarizePrompt(
  runs: readonly Run[],
  include: (planted: Planted) => boolean = inCoveredCategory,
): PromptSummary {
  const prompted = runs.filter(hasPrompt);
  const scored = prompted.filter(({ prompt }) => prompt.outcome !== 'error');
  const blocked = (run: PromptRun) => run.prompt.outcome === 'blocked';
  const positives = scored.filter(({ testCase }) => testCase.planted.some(include));
  const results = prompted.map(({ prompt }) => prompt);
  return {
    ...common(prompted, results),
    recall: share(positives.map((run) => blocked(run) && run.prompt.missing.length === 0)),
    falsePositives: share(scored.filter(isNegative).map(blocked)),
    typeMisses: positives.filter((run) => blocked(run) && run.prompt.missing.length > 0).length,
    unknownTypes: sorted(results.flatMap(({ unknown }) => unknown)),
  };
}

/**
 * Ids of cases that should fail the run: an error on either surface outside the size
 * probes (their over-quota errors are the measurement), or any hook output the evals could not read.
 */
export function gateFailures(runs: readonly Run[]): string[] {
  return runs
    .filter(({ testCase, output, prompt }) =>
      [output, prompt].some(
        (result) =>
          result?.outcome === 'error' && (testCase.format !== 'large' || result.errorName === UNRECOGNIZED_OUTPUT),
      ),
    )
    .map(({ testCase }) => testCase.id);
}

/** A run that scanned nothing, or hit a gating failure, exits nonzero. */
export const runFailed = (runs: readonly Run[]) => runs.length === 0 || gateFailures(runs).length > 0;
