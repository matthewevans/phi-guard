// Stdin-to-decision wiring shared by the Claude Code and Codex prompt entrypoints.
import { json } from 'node:stream/consumers';
import { errorName, scannerFromConfig } from '../guardrail.ts';
import { withDeadline } from './deadline.ts';
import { checkPrompt, type BlockDecision } from './prompt.ts';

export async function runPromptHook(prefix: string, deadlineMs?: number): Promise<BlockDecision | undefined> {
  try {
    const work = (async () => {
      const { prompt } = (await json(process.stdin)) as { prompt: string };
      return checkPrompt(prompt, scannerFromConfig(prefix));
    })();
    return await (deadlineMs === undefined ? work : withDeadline(work, deadlineMs));
  } catch (error) {
    return {
      decision: 'block',
      reason: `phi-guard could not scan this prompt (${errorName(error)}), so it was blocked.`,
    };
  }
}
