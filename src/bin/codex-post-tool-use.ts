import { json } from 'node:stream/consumers';
import { errorName, scannerFromConfig, type Scan } from '../guardrail.ts';
import { currentPaths } from '../hooks/codex-command.ts';
import { maskCodexOutput, withheld } from '../hooks/codex-post-tool-use.ts';
import { exitAfterWrite, HOOK_DEADLINE_MS, withDeadline } from '../hooks/deadline.ts';
import type { BlockDecision } from '../hooks/prompt.ts';

// Built per call, so a missing config fails the scan after the capture file is already deleted.
const scan: Scan = (text, source) => scannerFromConfig('PHI_GUARD_')(text, source);

let output: BlockDecision | undefined;
try {
  output = await withDeadline(
    (async () => maskCodexOutput(await json(process.stdin), scan, currentPaths(import.meta.url)))(),
    HOOK_DEADLINE_MS,
  );
} catch (error) {
  output = withheld(`scan failed (${errorName(error)})`);
}
exitAfterWrite(process.stdout, output && JSON.stringify(output), 0);
