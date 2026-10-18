// Renders a target's runs as text. Prints case ids, counts and type names, never case
// text or planted values.
import { PROMPT_FORMATS, type Planted } from './case.ts';
import {
  gateFailures,
  summarizeOutput,
  summarizePrompt,
  textUnits,
  type Rate,
  type Run,
  type Summary,
} from './metrics.ts';
import { CATEGORIES, TAXONOMY, type Category } from './taxonomy.ts';

const MAX_LISTED_IDS = 10;

const percent = (value: number, digits = 1) => `${(value * 100).toFixed(digits)}%`;
const formatRate = ({ hits, total, value, low, high }: Rate) =>
  total === 0 ? '-' : `${percent(value)} (${hits}/${total}) [${percent(low, 0)}-${percent(high, 0)}]`;
const formatErrors = (errors: Record<string, number>) =>
  Object.entries(errors)
    .map(([name, count]) => `${count} ${name}`)
    .join(', ') || 'none';

/** Left-aligns each column to its widest cell. */
function aligned(rows: string[][]): string {
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
  return rows
    .map((row) =>
      row
        .map((cell, column) => cell.padEnd(widths[column]))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

const table = (headers: string[], rows: string[][]) => aligned([headers, ...rows]);
const section = (title: string, body: string) => `${title}\n${body}`;

function overview(summary: Summary, extra: [string, string][]): string {
  const { cases, recall, falsePositives, errors, latency, units, cost } = summary;
  const ms = latency
    ? `p50 ${latency.p50.toFixed(0)}, p95 ${latency.p95.toFixed(0)}, max ${latency.max.toFixed(0)}`
    : '-';
  return aligned([
    ['cases', String(cases)],
    ['recall', formatRate(recall)],
    ['false positives', formatRate(falsePositives)],
    ['errors', formatErrors(errors)],
    ...extra,
    ['hook latency ms', ms],
    ['text units', `${units} (about $${cost.toFixed(4)})`],
  ]);
}

const holds = (category: Category, sub?: string) => (planted: Planted) =>
  planted.category === category && (sub === undefined || planted.sub === sub);

/** One row for each category, then one for each of its sub-categories when it has several. */
export function categoryRows(runs: readonly Run[]): string[][] {
  return CATEGORIES.flatMap((category) => {
    const subs = Object.keys(TAXONOMY[category].subs);
    return [undefined, ...(subs.length > 1 ? subs : [])].flatMap((sub) => {
      const include = holds(category, sub);
      const { recall, withheld } = summarizeOutput(
        runs.filter(({ testCase }) => testCase.planted.some(include)),
        include,
      );
      if (recall.total === 0 && withheld === 0) return [];
      const [label, coverage] = sub === undefined ? [category, TAXONOMY[category].coverage] : [`  ${sub}`, ''];
      return [
        [
          label,
          coverage,
          String(recall.total),
          formatRate(recall),
          String(recall.total - recall.hits),
          String(withheld),
        ],
      ];
    });
  });
}

function formatRows(runs: readonly Run[]): string[][] {
  const formats = new Set(runs.map(({ testCase }) => testCase.format));
  return [...formats].map((format) => {
    const { cases, recall, falsePositives, withheld, errors } = summarizeOutput(
      runs.filter(({ testCase }) => testCase.format === format),
    );
    return [
      format,
      String(cases),
      formatRate(recall),
      formatRate(falsePositives),
      String(withheld),
      formatErrors(errors),
    ];
  });
}

export function sizeProbeRows(runs: readonly Run[]): string[][] {
  return runs
    .filter(({ testCase }) => testCase.format === 'large')
    .map(({ testCase, output }) => [
      testCase.id,
      String(testCase.text.length),
      String(textUnits(testCase.text)),
      output.errorName ? `error ${output.errorName}` : output.outcome,
      String(output.leaked.length),
      output.ms.toFixed(0),
    ]);
}

export function promptCategoryRows(runs: readonly Run[]): string[][] {
  return CATEGORIES.flatMap((category) => {
    const include = holds(category);
    const { cases, recall, typeMisses } = summarizePrompt(
      runs.filter(({ testCase }) => testCase.planted.some(include)),
      include,
    );
    return cases === 0
      ? []
      : [[category, TAXONOMY[category].coverage, String(cases), formatRate(recall), String(typeMisses)]];
  });
}

function failures(runs: readonly Run[]): string {
  const ids = gateFailures(runs);
  if (ids.length === 0) return 'none';
  const more = ids.length - MAX_LISTED_IDS;
  return `${ids.length}: ${ids.slice(0, MAX_LISTED_IDS).join(', ')}${more > 0 ? `, and ${more} more` : ''}`;
}

export function formatReport(target: string, runs: readonly Run[]): string {
  const output = summarizeOutput(runs);
  const prompt = summarizePrompt(runs);
  return [
    `Target ${target}`,
    section(
      'Output surface (dist/bash-output.mjs)',
      overview(output, [
        ['withheld by guardrail', String(output.withheld)],
        ['mask tags seen', output.tags.join(', ') || 'none'],
      ]),
    ),
    section(
      'By category (values)',
      table(['category', 'coverage', 'values', 'recall', 'leaked', 'withheld cases'], categoryRows(runs)),
    ),
    section(
      'By format',
      table(['format', 'cases', 'recall', 'false positives', 'withheld', 'errors'], formatRows(runs)),
    ),
    section(
      'Size probes',
      table(['case', 'characters', 'text units', 'outcome', 'leaked values', 'ms'], sizeProbeRows(runs)),
    ),
    section(
      `Prompt surface (dist/prompt.mjs, formats ${[...PROMPT_FORMATS].join(', ')})`,
      overview(prompt, [
        ['blocked without every expected type', String(prompt.typeMisses)],
        ['types the template does not define', prompt.unknownTypes.join(', ') || 'none'],
      ]),
    ),
    section(
      'Prompt surface by category (cases)',
      table(['category', 'coverage', 'cases', 'recall', 'type misses'], promptCategoryRows(runs)),
    ),
    section('Run failures (errors outside size probes, unreadable output)', failures(runs)),
  ].join('\n\n');
}
