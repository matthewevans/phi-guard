import { json } from 'node:stream/consumers';
import { failureName } from '../errors.ts';
import { scannerFromConfig } from '../guardrail.ts';
import { exitAfterWrite, withDeadline } from '../hook-io.ts';
import { maskBashOutput, withheld, type BashResponse, type PostToolUseOutput } from '../hooks/bash-output.ts';

// Minimal documented Bash shape, used if stdin itself can't be read.
let response: BashResponse = { stdout: '', stderr: '', interrupted: false, isImage: false };
let output: PostToolUseOutput | undefined;
try {
  output = await withDeadline(async () => {
    ({ tool_response: response } = (await json(process.stdin)) as { tool_response: BashResponse });
    return maskBashOutput(response, scannerFromConfig('CLAUDE_PLUGIN_OPTION_'));
  });
} catch (error) {
  output = withheld(response, `scan failed (${failureName(error)})`);
}
exitAfterWrite(process.stdout, output && JSON.stringify(output), 0);
