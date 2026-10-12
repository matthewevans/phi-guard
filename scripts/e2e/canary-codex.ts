// Test-only Codex PostToolUse hook, built into a temp dir by scripts/e2e.sh. It runs the
// production maskCodexOutput with a fake scanner that masks the canary. The paths come
// from the shipped dist/codex-post-tool-use.mjs, so the runner-form match uses the
// shipped runner exactly as the real hook would. Never part of dist/.
import { json } from 'node:stream/consumers';
import { pathToFileURL } from 'node:url';
import type { Scan } from '../../src/guardrail.ts';
import { currentPaths } from '../../src/hooks/codex-command.ts';
import { maskCodexOutput } from '../../src/hooks/codex-post-tool-use.ts';

const canary = process.env.E2E_CANARY!;
const shipped = pathToFileURL(`${process.env.E2E_REPO}/dist/codex-post-tool-use.mjs`).href;

const scan: Scan = async (text) => ({
  intervened: text.includes(canary),
  text: text.replaceAll(canary, '{NAME}'),
  findings: ['NAME'],
});

const output = await maskCodexOutput(await json(process.stdin), scan, currentPaths(shipped));
if (output) process.stdout.write(JSON.stringify(output));
