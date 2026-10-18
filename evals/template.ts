// Reads what the evals need from infra/guardrail.yaml. The template uses CloudFormation
// tags (!Ref, !Join, !If), so this is a line-level reader that knows only the shapes the file uses.
import { readFileSync } from 'node:fs';

export interface TemplateRegex {
  name: string;
  /** Parameters the pattern comes from (`!Ref`). Empty for a fixed pattern. */
  refs: string[];
  /** Assembled patterns, unescaped from YAML single quotes: one per variant of a conditional pattern. */
  patterns: string[];
}

export interface Template {
  blockedOutputsMessaging: string;
  entityTypes: string[];
  regexes: TemplateRegex[];
}

const unquote = (scalar: string) => scalar.replaceAll("''", "'");

// A `!Join` pattern is a base followed by parts that `!If` adds, so each variant is one
// more part appended to the one before.
function assembled(pattern: string): string[] {
  const parts = [...pattern.matchAll(/'((?:[^']|'')*)'/g)].map((match) => unquote(match[1])).filter(Boolean);
  return pattern.includes('!Join') ? parts.map((_, end) => parts.slice(0, end + 1).join('')) : parts;
}

export function parseTemplate(yaml: string): Template {
  const blocked = /BlockedOutputsMessaging: '((?:[^']|'')*)'/.exec(yaml);
  if (!blocked) throw new Error('template has no BlockedOutputsMessaging');
  return {
    blockedOutputsMessaging: unquote(blocked[1]),
    entityTypes: [...yaml.matchAll(/\{ Type: (\w+),/g)].map((match) => match[1]),
    regexes: [...yaml.matchAll(/- Name: (\w+)\n\s+Pattern: (.+)/g)].map(([, name, pattern]) => ({
      name,
      refs: [...pattern.matchAll(/!Ref (\w+)/g)].map((match) => match[1]),
      patterns: assembled(pattern),
    })),
  };
}

export const readTemplate = (): Template =>
  parseTemplate(readFileSync(new URL('../infra/guardrail.yaml', import.meta.url), 'utf8'));
