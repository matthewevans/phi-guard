import type { Format, Planted } from './case.ts';

/** Text under construction: literal strings, planted values and nested lists of both. */
export type Part = string | Planted | readonly Part[];

/** Joins parts into text and collects the planted values in order of appearance. */
export function flatten(part: Part): { text: string; planted: Planted[] } {
  if (typeof part === 'string') return { text: part, planted: [] };
  if ('value' in part) return { text: part.value, planted: [part] };
  const pieces = part.map(flatten);
  return { text: pieces.map((piece) => piece.text).join(''), planted: pieces.flatMap((piece) => piece.planted) };
}

/** Template tag that keeps planted values distinguishable from the literal text around them. */
export function compose(strings: TemplateStringsArray, ...parts: Part[]): Part {
  return strings.flatMap((literal, index) => (index < parts.length ? [literal, parts[index]] : [literal]));
}

/** Where each generated case comes from: `count` cases named `<format>/<name>-<nnn>`. */
export interface Recipe {
  format: Format;
  name: string;
  count: number;
  /** Draws from the seeded generator, so it must make the same calls in the same order every time. */
  build(index: number): Part;
}
