// Stdin-to-decision wiring shared by the Claude Code and Codex prompt entrypoints.
import { json } from 'node:stream/consumers';
import { failureName } from './errors.ts';
import { scannerFromConfig } from './guardrail.ts';
import { withDeadline } from './hook-io.ts';
import { checkPrompt, type BlockDecision } from './hooks/prompt.ts';
import { readMentions } from './mentions.ts';

/** `mentions` scans the files the prompt @-mentions, which only Claude Code attaches. */
export async function runPromptHook(prefix: string, { mentions = false } = {}): Promise<BlockDecision | undefined> {
  try {
    return await withDeadline(async () => {
      const { prompt, cwd } = (await json(process.stdin)) as { prompt: string; cwd: string };
      return checkPrompt(prompt, scannerFromConfig(prefix), mentions ? readMentions(prompt, cwd) : []);
    });
  } catch (error) {
    return {
      decision: 'block',
      reason: `phi-guard could not scan this prompt (${failureName(error)}), so it was blocked.`,
    };
  }
}
