// Runs the bundled Codex entrypoints (dist/*.mjs, the shipped artifact) as Codex would.
// Codex fails open on every hook failure except exit 2, so each of these must block,
// withhold or exit 2 on its own.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { test } from 'node:test';
import { wrapCommand, type CodexPaths } from '../src/hooks/codex-command.ts';

// Stripped so a developer's own AWS or phi-guard setup can't leak into the runs.
const AMBIENT_CONFIG = /^(CLAUDE_PLUGIN_OPTION_|PHI_GUARD_|AWS_)/;
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !AMBIENT_CONFIG.test(name)));

const dist = (script: string) => new URL(`../dist/${script}`, import.meta.url).pathname;
const run = (script: string, input: string) =>
  spawnSync(process.execPath, [dist(script)], { input, env, encoding: 'utf8' });

// The paths the post hook derives for itself, so a wrapped command is recognised.
const uid = process.getuid!();
const paths: CodexPaths = {
  execPath: process.execPath,
  runnerPath: dist('codex-runner.mjs'),
  captureDir: `${realpathSync('/tmp')}/phi-guard-${uid}`,
  uid,
};

test('prompt hook blocks when the guardrail is not configured', () => {
  const result = run('codex-prompt.mjs', JSON.stringify({ prompt: 'hello' }));
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.decision, 'block');
  assert.match(output.reason, /could not scan this prompt \(MissingGuardrailConfig\)/);
});

test('prompt hook ignores the Claude Code options', () => {
  const result = spawnSync(process.execPath, [dist('codex-prompt.mjs')], {
    input: JSON.stringify({ prompt: 'hello' }),
    env: { ...env, CLAUDE_PLUGIN_OPTION_GUARDRAIL_ID: 'x', CLAUDE_PLUGIN_OPTION_GUARDRAIL_VERSION: '1', CLAUDE_PLUGIN_OPTION_AWS_REGION: 'us-east-1' },
    encoding: 'utf8',
  });
  assert.match(JSON.parse(result.stdout).reason, /MissingGuardrailConfig/);
});

test('prompt hook blocks on unreadable input', () => {
  assert.equal(JSON.parse(run('codex-prompt.mjs', 'not json').stdout).decision, 'block');
});

test('post hook withholds a wrapped command when the guardrail is not configured, and deletes the capture', () => {
  mkdirSync(paths.captureDir, { mode: 0o700, recursive: true });
  const id = randomUUID();
  const capturePath = `${paths.captureDir}/${id}.out`;
  writeFileSync(capturePath, 'zebra-fake-1\n', { mode: 0o600 });
  const input = { tool_input: { command: wrapCommand(paths, 'echo zebra-fake-1', id) }, tool_response: 'marker' };

  const result = run('codex-post-tool-use.mjs', JSON.stringify(input));

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    decision: 'block',
    reason: '[phi-guard: output withheld, scan failed (MissingGuardrailConfig)]',
  });
  assert.equal(existsSync(capturePath), false);
});

test('post hook withholds a wrapped command whose capture is missing, naming the cause', () => {
  const command = wrapCommand(paths, 'echo hi', randomUUID());
  const result = run('codex-post-tool-use.mjs', JSON.stringify({ tool_input: { command }, tool_response: 'marker' }));

  assert.match(JSON.parse(result.stdout).reason, /no capture file was written \(ENOENT\).*danger-full-access/);
});

test('post hook withholds a FIFO capture promptly instead of blocking on open', () => {
  mkdirSync(paths.captureDir, { mode: 0o700, recursive: true });
  const id = randomUUID();
  const capturePath = `${paths.captureDir}/${id}.out`;
  assert.equal(spawnSync('mkfifo', [capturePath]).status, 0);
  const input = { tool_input: { command: wrapCommand(paths, 'echo hi', id) }, tool_response: 'marker' };

  const started = Date.now();
  const result = spawnSync(process.execPath, [dist('codex-post-tool-use.mjs')], {
    input: JSON.stringify(input),
    env,
    encoding: 'utf8',
    timeout: 10_000,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(JSON.parse(result.stdout).reason, /capture file unreadable \(UnsafeCaptureFile\)/);
  assert.ok(Date.now() - started < 5_000, 'must not wait on a writer');
  assert.equal(existsSync(capturePath), false);
});

test('post hook withholds an unwrapped command when the guardrail is not configured', () => {
  const input = { tool_input: { command: 'ls' }, tool_response: 'zebra-fake-1.txt\n' };
  const result = run('codex-post-tool-use.mjs', JSON.stringify(input));

  assert.equal(JSON.parse(result.stdout).reason, '[phi-guard: output withheld, scan failed (MissingGuardrailConfig)]');
});

test('post hook withholds on unreadable input', () => {
  const output = JSON.parse(run('codex-post-tool-use.mjs', 'not json').stdout);
  assert.equal(output.decision, 'block');
  assert.match(output.reason, /^\[phi-guard: output withheld, scan failed \(\w+\)\]$/);
});

test('pre hook exits 2 on unreadable input or a missing command', () => {
  for (const input of ['not json', '{}', JSON.stringify({ tool_input: {} })]) {
    const result = run('codex-pre-tool-use.mjs', input);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /command blocked/);
  }
});

test('pre hook wraps a command into the form the post hook recognises, and skips its own output', () => {
  const first = run('codex-pre-tool-use.mjs', JSON.stringify({ tool_input: { command: 'echo hi' } }));
  assert.equal(first.status, 0, first.stderr);
  const { command } = JSON.parse(first.stdout).hookSpecificOutput.updatedInput;
  assert.match(command, new RegExp(`^'${process.execPath}' '${dist('codex-runner.mjs')}' '${paths.captureDir}/`));

  const second = run('codex-pre-tool-use.mjs', JSON.stringify({ tool_input: { command } }));
  assert.equal(second.status, 0);
  assert.equal(second.stdout, '');
});

test('every Codex hook enforces its own deadline when stdin never closes', async () => {
  const expectations = {
    'codex-prompt.mjs': (status: number | null, stdout: string) => {
      assert.equal(status, 0);
      assert.match(JSON.parse(stdout).reason, /HookDeadlineExceeded/);
    },
    'codex-post-tool-use.mjs': (status: number | null, stdout: string) => {
      assert.equal(status, 0);
      assert.match(JSON.parse(stdout).reason, /HookDeadlineExceeded/);
    },
    'codex-pre-tool-use.mjs': (status: number | null, stdout: string) => {
      assert.equal(status, 2);
      assert.equal(stdout, '');
    },
  };
  await Promise.all(
    Object.entries(expectations).map(async ([script, check]) => {
      const started = Date.now();
      const child = spawn(process.execPath, [dist(script)], { env, stdio: ['pipe', 'pipe', 'ignore'] });
      let stdout = '';
      child.stdout.on('data', (chunk) => (stdout += chunk));
      const [status] = await once(child, 'exit');
      check(status, stdout);
      assert.ok(Date.now() - started < 18_000, `${script} must finish inside the 20s hook timeout`);
    }),
  );
});
