// UserPromptSubmit hook: blocks a prompt the guardrail flags. Hooks can't rewrite
// prompts, so blocking is the only option. The reason is shown to the user only.
import { describeFindings } from '../errors.ts';
import type { Scan } from '../guardrail.ts';

export interface BlockDecision {
  decision: 'block';
  reason: string;
}

export async function checkPrompt(prompt: string, scan: Scan): Promise<BlockDecision | undefined> {
  const result = await scan(prompt, 'INPUT');
  if (!result.intervened) return undefined;
  return {
    decision: 'block',
    reason: `phi-guard blocked this prompt: possible ${describeFindings(result.findings)}. Remove it and resubmit.`,
  };
}
