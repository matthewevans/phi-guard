// Reads what the evals need from infra/guardrail.yaml. The template uses CloudFormation
// short-form tags, which the YAML parser resolves into their long-form JSON shapes.
import { readFileSync } from 'node:fs';
import { parse, type CollectionTag, type ScalarTag } from 'yaml';

export interface TemplateRegex {
  name: string;
  /** Parameters the pattern comes from (`!Ref`). Empty for a fixed pattern. */
  refs: string[];
  /** Assembled patterns: one per variant of a conditional pattern. */
  patterns: string[];
}

export interface Template {
  blockedOutputsMessaging: string;
  entityTypes: string[];
  regexes: TemplateRegex[];
}

// The long form of `!Ref` is `Ref`, and of every other tag `Fn::<name>`.
const longForm = (name: string) => (name === 'Ref' ? name : `Fn::${name}`);

const scalarTag = (name: string): ScalarTag => ({
  tag: `!${name}`,
  resolve: (value) => ({ [longForm(name)]: value }),
});

const sequenceTag = (name: string): CollectionTag => ({
  tag: `!${name}`,
  collection: 'seq',
  resolve: (seq) => ({ [longForm(name)]: seq.toJSON() }),
});

const customTags = [...['Ref', 'GetAtt', 'Sub'].map(scalarTag), ...['Join', 'If', 'Equals'].map(sequenceTag)];

type Conditional = { 'Fn::If': [condition: string, whenTrue: string, whenFalse: string] };
type Pattern = string | { Ref: string } | { 'Fn::Join': [separator: string, parts: (string | Conditional)[]] };

interface Document {
  Resources: {
    Guardrail: {
      Properties: {
        BlockedOutputsMessaging: string;
        SensitiveInformationPolicyConfig: {
          PiiEntitiesConfig: { Type: string }[];
          RegexesConfig: { Name: string; Pattern: Pattern }[];
        };
      };
    };
  };
}

// A `!Join` pattern is a base followed by parts that `!If` adds, so there is one variant
// for each branch of every `!If`.
function variants(pattern: Pattern): string[] {
  if (typeof pattern === 'string') return [pattern];
  if ('Ref' in pattern) return [];
  const [, parts] = pattern['Fn::Join'];
  return parts.reduce(
    (assembled, part) =>
      typeof part === 'string'
        ? assembled.map((variant) => variant + part)
        : [
            ...assembled.map((variant) => variant + part['Fn::If'][2]),
            ...assembled.map((variant) => variant + part['Fn::If'][1]),
          ],
    [''],
  );
}

export function parseTemplate(text: string): Template {
  const { Properties } = (parse(text, { customTags }) as Document).Resources.Guardrail;
  const { PiiEntitiesConfig, RegexesConfig } = Properties.SensitiveInformationPolicyConfig;
  return {
    blockedOutputsMessaging: Properties.BlockedOutputsMessaging,
    entityTypes: PiiEntitiesConfig.map(({ Type }) => Type),
    regexes: RegexesConfig.map(({ Name, Pattern }) => ({
      name: Name,
      refs: typeof Pattern === 'object' && 'Ref' in Pattern ? [Pattern.Ref] : [],
      patterns: variants(Pattern),
    })),
  };
}

export const readTemplate = (): Template =>
  parseTemplate(readFileSync(new URL('../infra/guardrail.yaml', import.meta.url), 'utf8'));
