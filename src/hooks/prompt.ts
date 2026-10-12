// UserPromptSubmit hook: blocks a prompt the guardrail flags. Hooks can't rewrite
// prompts, so blocking is the only option. The reason is shown to the user only.
import { json } from 'node:stream/consumers';
import { errorName, scannerFromEnv, type Scan } from '../guardrail.ts';

interface BlockDecision {
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

if (import.meta.main) {
  let decision: BlockDecision | undefined;
  try {
    const { prompt } = (await json(process.stdin)) as { prompt: string };
    decision = await checkPrompt(prompt, scannerFromEnv());
  } catch (error) {
    decision = {
      decision: 'block',
      reason: `phi-guard could not scan this prompt (${errorName(error)}), so it was blocked.`,
    };
  }
  if (decision) process.stdout.write(JSON.stringify(decision));
}
