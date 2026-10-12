// Runs the hook entrypoints as Claude Code would, with no guardrail configured,
// to prove every failure path blocks or withholds rather than passing through.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

function runHook(script: string, stdin: string) {
  const { PHI_GUARD_GUARDRAIL_ID, PHI_GUARD_GUARDRAIL_VERSION, ...env } = process.env;
  const result = spawnSync('node', [new URL(`../src/hooks/${script}`, import.meta.url).pathname], {
    input: stdin,
    env,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('prompt hook blocks when the guardrail is not configured', () => {
  const output = runHook('prompt.ts', JSON.stringify({ prompt: 'hello' }));
  assert.equal(output.decision, 'block');
  assert.match(output.reason, /could not scan this prompt \(MissingGuardrailConfig\)/);
});

test('prompt hook blocks on unreadable input', () => {
  assert.equal(runHook('prompt.ts', 'not json').decision, 'block');
});

test('bash hook withholds output when the guardrail is not configured', () => {
  const tool_response = { stdout: 'Jane Roe', stderr: 'x', interrupted: false, isImage: false, extra: 1 };
  const output = runHook('bash-output.ts', JSON.stringify({ tool_name: 'Bash', tool_response }));
  assert.deepEqual(output.hookSpecificOutput.updatedToolOutput, {
    ...tool_response,
    stdout: '[phi-guard: output withheld, scan failed (MissingGuardrailConfig)]',
    stderr: '',
  });
});

test('bash hook withholds output on unreadable input', () => {
  const output = runHook('bash-output.ts', 'not json');
  assert.match(output.hookSpecificOutput.updatedToolOutput.stdout, /withheld/);
});
