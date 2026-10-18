import { CATEGORIES, expectedTypes, type Category, type Sub } from './taxonomy.ts';

export const FORMATS = [
  'prose',
  'log',
  'json',
  'csv',
  'psql',
  'hl7',
  'fhir',
  'stacktrace',
  'ticket',
  'git-log',
  'changelog',
  'docs',
  'code',
  'ddl',
  'package-output',
  'access-log',
  'large',
] as const;
export type Format = (typeof FORMATS)[number];

/** Formats a person types or pastes into a prompt, so they also run through the prompt hook. */
export const PROMPT_FORMATS: ReadonlySet<Format> = new Set<Format>(['prose', 'ticket']);

/** A value that must not survive masking, and what kind of identifier it is. */
export interface Planted {
  category: Category;
  sub: string;
  value: string;
}

export function plant<C extends Category>(category: C, sub: Sub<C>, value: string): Planted {
  return { category, sub, value };
}

/** A positive plants at least one value tied to a person's health or care. A negative plants none. */
export interface Case {
  /** `<format>/<scenario>-<nnn>`, stable across runs and unique. */
  id: string;
  format: Format;
  text: string;
  planted: readonly Planted[];
}

const occurrences = (text: string, value: string) => text.split(value).length - 1;

function plantedProblem(entry: unknown): string | undefined {
  const { category, sub, value } = (entry ?? {}) as Record<string, unknown>;
  if (!CATEGORIES.includes(category as Category)) return 'unknown category';
  if (expectedTypes(category as Category, sub as string) === undefined) {
    return `unknown sub-category for ${category as string}`;
  }
  return typeof value === 'string' && value !== '' ? undefined : 'a planted value must be a non-empty string';
}

// Each value occurs once and is not part of another, so a surviving value always means
// that one insertion leaked.
function placementProblem(text: string, values: readonly string[]): string | undefined {
  for (const [index, value] of values.entries()) {
    const count = occurrences(text, value);
    if (count !== 1) return `planted value ${index} occurs ${count} times in the text`;
    if (values.some((other, otherIndex) => otherIndex !== index && other.includes(value))) {
      return `planted value ${index} is part of another planted value`;
    }
  }
  return undefined;
}

/** Describes what is wrong with a case, or returns undefined. Takes unknown so it can check a parsed overlay row. */
export function caseProblem(candidate: unknown): string | undefined {
  if (typeof candidate !== 'object' || candidate === null) return 'not an object';
  const { id, format, text, planted } = candidate as Record<string, unknown>;
  if (typeof id !== 'string' || id === '') return 'id must be a non-empty string';
  if (!FORMATS.includes(format as Format)) return 'unknown format';
  if (typeof text !== 'string' || text === '') return 'text must be a non-empty string';
  if (!Array.isArray(planted)) return 'planted must be an array';

  for (const entry of planted) {
    const problem = plantedProblem(entry);
    if (problem !== undefined) return problem;
  }
  return placementProblem(text, (planted as Planted[]).map(({ value }) => value));
}
