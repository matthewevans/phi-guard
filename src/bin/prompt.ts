import { json } from 'node:stream/consumers';
import { errorName, scannerFromConfig } from '../guardrail.ts';
import { checkPrompt, type BlockDecision } from '../hooks/prompt.ts';

let decision: BlockDecision | undefined;
try {
  const { prompt } = (await json(process.stdin)) as { prompt: string };
  decision = await checkPrompt(prompt, scannerFromConfig('CLAUDE_PLUGIN_OPTION_'));
} catch (error) {
  decision = {
    decision: 'block',
    reason: `phi-guard could not scan this prompt (${errorName(error)}), so it was blocked.`,
  };
}
if (decision) process.stdout.write(JSON.stringify(decision));
