// Runs the bundled Codex entrypoints (dist/*.mjs, the shipped artifact) as Codex would.
// Codex fails open on every hook failure except exit 2, so each of these must block,
// withhold or exit 2 on its own.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { wrapCommand, type CodexPaths } from '../src/hooks/codex-command.ts';
import { dist, spawnHangingHook, spawnHook } from './hook-process.ts';

// The paths the post hook derives for itself, so a wrapped command is recognised.
const uid = process.getuid!();
const paths: CodexPaths = {
  execPath: process.execPath,
  runnerPath: dist('codex-runner.mjs'),
  captureDir: `${realpathSync('/tmp')}/phi-guard-${uid}`,
  uid,
};

test('prompt hook blocks when the guardrail is not configured', () => {
  const result = spawnHook('codex-prompt.mjs', JSON.stringify({ prompt: 'hello' }));
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.decision, 'block');
  assert.match(output.reason, /could not scan this prompt \(MissingGuardrailConfig\)/);
});

test('prompt hook ignores the Claude Code options', () => {
  const result = spawnHook('codex-prompt.mjs', JSON.stringify({ prompt: 'hello' }), {
    env: {
      CLAUDE_PLUGIN_OPTION_GUARDRAIL_ID: 'x',
      CLAUDE_PLUGIN_OPTION_GUARDRAIL_VERSION: '1',
      CLAUDE_PLUGIN_OPTION_AWS_REGION: 'us-east-1',
    },
  });
  assert.match(JSON.parse(result.stdout).reason, /MissingGuardrailConfig/);
});

test('prompt hook blocks on unreadable input', () => {
  assert.equal(JSON.parse(spawnHook('codex-prompt.mjs', 'not json').stdout).decision, 'block');
});

test('post hook withholds a wrapped command when the guardrail is not configured, and deletes the capture', () => {
  mkdirSync(paths.captureDir, { mode: 0o700, recursive: true });
  const id = randomUUID();
  const capturePath = `${paths.captureDir}/${id}.out`;
  writeFileSync(capturePath, 'zebra-fake-1\n', { mode: 0o600 });
  const input = { tool_input: { command: wrapCommand(paths, 'echo zebra-fake-1', id) }, tool_response: 'marker' };

  const result = spawnHook('codex-post-tool-use.mjs', JSON.stringify(input));

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    decision: 'block',
    reason: '[phi-guard: output withheld, scan failed (MissingGuardrailConfig)]',
  });
  assert.equal(existsSync(capturePath), false);
});

test('post hook withholds a wrapped command whose capture is missing, naming the cause', () => {
  const command = wrapCommand(paths, 'echo hi', randomUUID());
  const input = { tool_input: { command }, tool_response: 'marker' };
  const result = spawnHook('codex-post-tool-use.mjs', JSON.stringify(input));

  assert.match(JSON.parse(result.stdout).reason, /no capture file was written \(ENOENT\).*danger-full-access/);
});

test('post hook withholds a FIFO capture promptly instead of blocking on open', () => {
  mkdirSync(paths.captureDir, { mode: 0o700, recursive: true });
  const id = randomUUID();
  const capturePath = `${paths.captureDir}/${id}.out`;
  assert.equal(spawnSync('mkfifo', [capturePath]).status, 0);
  const input = { tool_input: { command: wrapCommand(paths, 'echo hi', id) }, tool_response: 'marker' };

  const started = Date.now();
  const result = spawnHook('codex-post-tool-use.mjs', JSON.stringify(input), { timeout: 10_000 });

  assert.equal(result.status, 0, result.stderr);
  assert.match(JSON.parse(result.stdout).reason, /capture file unreadable \(UnsafeCaptureFile\)/);
  assert.ok(Date.now() - started < 5_000, 'must not wait on a writer');
  assert.equal(existsSync(capturePath), false);
});

test('post hook withholds an unwrapped command when the guardrail is not configured', () => {
  const input = { tool_input: { command: 'ls' }, tool_response: 'zebra-fake-1.txt\n' };
  const result = spawnHook('codex-post-tool-use.mjs', JSON.stringify(input));

  assert.equal(JSON.parse(result.stdout).reason, '[phi-guard: output withheld, scan failed (MissingGuardrailConfig)]');
});

test('post hook withholds on unreadable input', () => {
  const output = JSON.parse(spawnHook('codex-post-tool-use.mjs', 'not json').stdout);
  assert.equal(output.decision, 'block');
  assert.match(output.reason, /^\[phi-guard: output withheld, scan failed \(\w+\)\]$/);
});

test('pre hook exits 2 on unreadable input or a missing command', () => {
  for (const input of ['not json', '{}', JSON.stringify({ tool_input: {} })]) {
    const result = spawnHook('codex-pre-tool-use.mjs', input);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /command blocked/);
  }
});

test('pre hook wraps a command into the form the post hook recognises, and skips its own output', () => {
  const first = spawnHook('codex-pre-tool-use.mjs', JSON.stringify({ tool_input: { command: 'echo hi' } }));
  assert.equal(first.status, 0, first.stderr);
  const { command } = JSON.parse(first.stdout).hookSpecificOutput.updatedInput;
  assert.match(command, new RegExp(`^'${process.execPath}' '${dist('codex-runner.mjs')}' '${paths.captureDir}/`));

  const second = spawnHook('codex-pre-tool-use.mjs', JSON.stringify({ tool_input: { command } }));
  assert.equal(second.status, 0);
  assert.equal(second.stdout, '');
});

test('every Codex hook enforces its own deadline when stdin never closes', { timeout: 25_000 }, async () => {
  const [prompt, post, pre] = await Promise.all(
    ['codex-prompt.mjs', 'codex-post-tool-use.mjs', 'codex-pre-tool-use.mjs'].map(spawnHangingHook),
  );

  for (const hook of [prompt, post]) {
    assert.equal(hook.status, 0);
    assert.match(JSON.parse(hook.stdout).reason, /HookDeadlineExceeded/);
  }
  assert.equal(pre.status, 2);
  assert.equal(pre.stdout, '');
  for (const { ms } of [prompt, post, pre]) assert.ok(ms < 18_000, 'must finish inside the 20s hook timeout');
});
