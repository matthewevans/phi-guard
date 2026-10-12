import { exitAfterWrite, HOOK_DEADLINE_MS } from '../hooks/deadline.ts';
import { runPromptHook } from '../hooks/prompt-hook.ts';

const decision = await runPromptHook('PHI_GUARD_', HOOK_DEADLINE_MS);
exitAfterWrite(process.stdout, decision && JSON.stringify(decision), 0);
