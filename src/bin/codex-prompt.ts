import { exitAfterWrite } from '../hook-io.ts';
import { runPromptHook } from '../prompt-hook.ts';

const decision = await runPromptHook('PHI_GUARD_');
exitAfterWrite(process.stdout, decision && JSON.stringify(decision), 0);
