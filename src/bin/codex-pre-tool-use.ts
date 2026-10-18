import { json } from 'node:stream/consumers';
import { failureName } from '../errors.ts';
import { exitAfterWrite, withDeadline } from '../hook-io.ts';
import { currentPaths } from '../hooks/codex-command.ts';
import { rewriteCommand } from '../hooks/codex-pre-tool-use.ts';

try {
  const output = await withDeadline(async () =>
    rewriteCommand(await json(process.stdin), currentPaths(import.meta.url)),
  );
  exitAfterWrite(process.stdout, output && JSON.stringify(output), 0);
} catch (error) {
  // Exit 2 is the one Codex hook failure that blocks the command instead of running it unwrapped.
  exitAfterWrite(
    process.stderr,
    `phi-guard: command blocked, it could not be routed through the output scanner (${failureName(error)})\n`,
    2,
  );
}
