import { json } from 'node:stream/consumers';
import { errorName, scannerFromConfig } from '../guardrail.ts';
import { maskBashOutput, withheld, type BashResponse, type PostToolUseOutput } from '../hooks/bash-output.ts';

// Minimal documented Bash shape, used if stdin itself can't be read.
let response: BashResponse = { stdout: '', stderr: '', interrupted: false, isImage: false };
let output: PostToolUseOutput | undefined;
try {
  ({ tool_response: response } = (await json(process.stdin)) as { tool_response: BashResponse });
  output = await maskBashOutput(response, scannerFromConfig('CLAUDE_PLUGIN_OPTION_'));
} catch (error) {
  output = withheld(response, `scan failed (${errorName(error)})`);
}
if (output) process.stdout.write(JSON.stringify(output));
