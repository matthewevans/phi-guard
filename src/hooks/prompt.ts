// UserPromptSubmit hook: blocks a prompt the guardrail flags. Hooks can't rewrite
// prompts, so blocking is the only option. The reason is shown to the user only.
import { describeFindings } from '../errors.ts';
import type { Scan } from '../guardrail.ts';

export interface BlockDecision {
  decision: 'block';
  reason: string;
}

/** A file an @-mention attaches to the prompt. Claude Code sends its contents to the model without a tool call. */
export interface Attachment {
  mention: string;
  text: string;
}

export async function checkPrompt(
  prompt: string,
  scan: Scan,
  attachments: readonly Attachment[] = [],
): Promise<BlockDecision | undefined> {
  const sources = [
    { where: 'the prompt', text: prompt },
    ...attachments.map((a) => ({ where: `@${a.mention}`, text: a.text })),
  ];
  const results = await Promise.all(sources.map(({ text }) => scan(text, 'INPUT')));
  const flagged = sources.filter((_, index) => results[index].intervened);
  if (flagged.length === 0) return undefined;

  const findings = [...new Set(results.flatMap((result) => result.findings))];
  // A prompt-only block keeps the plain wording that evals/classify.ts and scripts/e2e.sh parse.
  const where =
    flagged.length === 1 && flagged[0] === sources[0] ? '' : ` in ${flagged.map((s) => s.where).join(', ')}`;
  return {
    decision: 'block',
    reason: `phi-guard blocked this prompt: possible ${describeFindings(findings)}${where}. Remove it and resubmit.`,
  };
}
