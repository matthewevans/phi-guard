// Stdin-to-decision wiring shared by the Claude Code and Codex prompt entrypoints.
import { json } from 'node:stream/consumers';
import { failureName } from './errors.ts';
import { scannerFromConfig } from './guardrail.ts';
import { withDeadline } from './hook-io.ts';
import { checkPrompt, type BlockDecision } from './hooks/prompt.ts';

export async function runPromptHook(prefix: string): Promise<BlockDecision | undefined> {
  try {
    return await withDeadline(async () => {
      const { prompt } = (await json(process.stdin)) as { prompt: string };
      return checkPrompt(prompt, scannerFromConfig(prefix));
    });
  } catch (error) {
    return {
      decision: 'block',
      reason: `phi-guard could not scan this prompt (${failureName(error)}), so it was blocked.`,
    };
  }
}
