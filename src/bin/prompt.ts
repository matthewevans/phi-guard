import { runPromptHook } from '../hooks/prompt-hook.ts';

const decision = await runPromptHook('CLAUDE_PLUGIN_OPTION_');
if (decision) process.stdout.write(JSON.stringify(decision));
