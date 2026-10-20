import { json } from 'node:stream/consumers';
import { failureName } from '../errors.ts';
import { scannerFromConfig } from '../guardrail.ts';
import { exitAfterWrite, withDeadline } from '../hook-io.ts';
import { maskFileOutput, withheld, type FileTool, type GrepResponse, type ReadResponse } from '../hooks/file-output.ts';
import type { PostToolUseOutput } from '../hooks/bash-output.ts';

// The matcher in hooks/hooks.json sends only Read and Grep, so Read is the fallback if stdin itself can't be read.
let tool: FileTool = 'Read';
let response = {} as ReadResponse | GrepResponse;
let output: PostToolUseOutput<ReadResponse | GrepResponse> | undefined;
try {
  output = await withDeadline(async () => {
    const input = (await json(process.stdin)) as { tool_name: string; tool_response: ReadResponse | GrepResponse };
    if (input.tool_name === 'Grep') tool = 'Grep';
    response = input.tool_response;
    return maskFileOutput(input.tool_name, response, scannerFromConfig('CLAUDE_PLUGIN_OPTION_'));
  });
} catch (error) {
  output = withheld(tool, response, `scan failed (${failureName(error)})`);
}
exitAfterWrite(process.stdout, output && JSON.stringify(output), 0);
