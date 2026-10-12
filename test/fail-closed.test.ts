// Runs the bundled hook entrypoints (dist/*.mjs, the shipped artifact) as Claude Code
// would, to prove every failure path blocks or withholds rather than passing through.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

// Stripped so a developer's own AWS or phi-guard setup can't leak into the runs.
const AMBIENT_CONFIG = /^(CLAUDE_PLUGIN_OPTION_|PHI_GUARD_|AWS_)/;

// Obviously fake options, with no credentials anywhere, so the scan itself fails.
const fakeOptions = {
  CLAUDE_PLUGIN_OPTION_GUARDRAIL_ID: 'fake-guardrail-id',
  CLAUDE_PLUGIN_OPTION_GUARDRAIL_VERSION: '1',
  CLAUDE_PLUGIN_OPTION_AWS_REGION: 'us-east-1',
  AWS_SHARED_CREDENTIALS_FILE: '/nonexistent/phi-guard-credentials',
  AWS_CONFIG_FILE: '/nonexistent/phi-guard-config',
};

function runHook(script: string, stdin: string, extraEnv: Record<string, string> = {}) {
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !AMBIENT_CONFIG.test(name))),
    ...extraEnv,
  };
  const result = spawnSync('node', [new URL(`../dist/${script}`, import.meta.url).pathname], {
    input: stdin,
    env,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

const tool_response = { stdout: 'Jane Roe', stderr: 'x', interrupted: false, isImage: false, extra: 1 };
const bashInput = JSON.stringify({ tool_name: 'Bash', tool_response });

const withheldFor = (why: string) => ({
  ...tool_response,
  stdout: `[phi-guard: output withheld, scan failed (${why})]`,
  stderr: '',
});

test('prompt hook blocks when the guardrail is not configured', () => {
  const output = runHook('prompt.mjs', JSON.stringify({ prompt: 'hello' }));
  assert.equal(output.decision, 'block');
  assert.match(output.reason, /could not scan this prompt \(MissingGuardrailConfig\)/);
});

test('prompt hook blocks on unreadable input', () => {
  assert.equal(runHook('prompt.mjs', 'not json').decision, 'block');
});

test('bash hook withholds output when the guardrail is not configured', () => {
  const output = runHook('bash-output.mjs', bashInput);
  assert.deepEqual(output.hookSpecificOutput.updatedToolOutput, withheldFor('MissingGuardrailConfig'));
});

test('bash hook withholds output on unreadable input', () => {
  const output = runHook('bash-output.mjs', 'not json');
  assert.match(output.hookSpecificOutput.updatedToolOutput.stdout, /withheld/);
});

test('prompt hook blocks when the scan itself fails', () => {
  const started = Date.now();
  const output = runHook('prompt.mjs', JSON.stringify({ prompt: 'hello' }), fakeOptions);
  assert.equal(output.decision, 'block');
  assert.match(output.reason, /could not scan this prompt/);
  assert.doesNotMatch(output.reason, /MissingGuardrailConfig/);
  assert.ok(Date.now() - started < 15_000, 'must finish well inside the 20s hook timeout');
});

test('bash hook withholds output when the scan itself fails', () => {
  const started = Date.now();
  const output = runHook('bash-output.mjs', bashInput, fakeOptions);
  const updated = output.hookSpecificOutput.updatedToolOutput;
  assert.match(updated.stdout, /^\[phi-guard: output withheld, scan failed \(\w+\)\]$/);
  assert.doesNotMatch(updated.stdout, /MissingGuardrailConfig/);
  assert.equal(updated.stderr, '');
  assert.equal(updated.extra, 1);
  assert.ok(Date.now() - started < 15_000, 'must finish well inside the 20s hook timeout');
});
