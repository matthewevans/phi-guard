// UserPromptSubmit hook: blocks a prompt the guardrail flags. Hooks can't rewrite
// prompts, so blocking is the only option. The reason is shown to the user only.
import type { Scan } from '../guardrail.ts';

export interface BlockDecision {
  decision: 'block';
  reason: string;
}

export async function checkPrompt(prompt: string, scan: Scan): Promise<BlockDecision | undefined> {
  const result = await scan(prompt, 'INPUT');
  if (!result.intervened) return undefined;
  const found = result.findings.join(', ') || 'sensitive data';
  return {
    decision: 'block',
    reason: `phi-guard blocked this prompt: possible ${found}. Remove it and resubmit.`,
  };
}
