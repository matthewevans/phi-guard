// Test-only Claude Code PostToolUse hook, built into a temp dir by scripts/e2e.sh.
// It runs the production maskBashOutput with a fake scanner that masks the canary, to
// prove the installed CLI accepts the updatedToolOutput shape. Never part of dist/.
import { json } from 'node:stream/consumers';
import type { Scan } from '../../src/guardrail.ts';
import { maskBashOutput, type BashResponse } from '../../src/hooks/bash-output.ts';

const canary = process.env.E2E_CANARY!;

const scan: Scan = async (text) => ({
  intervened: text.includes(canary),
  text: text.replaceAll(canary, '{NAME}'),
  findings: ['NAME'],
});

const { tool_response } = (await json(process.stdin)) as { tool_response: BashResponse };
const output = await maskBashOutput(tool_response, scan);
if (output) process.stdout.write(JSON.stringify(output));
