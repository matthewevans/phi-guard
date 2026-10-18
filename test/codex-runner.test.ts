// Runs the shipped dist/codex-runner.mjs: the runner's own stdout is what Codex can show
// the model before PostToolUse runs, so it must never carry anything the command printed.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { after, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

const runner = new URL('../dist/codex-runner.mjs', import.meta.url).pathname;
const scratch = mkdtempSync(join(tmpdir(), 'phi-guard-runner-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
const MARKER = '[phi-guard: output captured for scanning]\n';

let counter = 0;
const capturePath = () => join(scratch, `${counter++}.out`);

function run(capture: string, command: string, input = '', shell = '/bin/sh') {
  return spawnSync(process.execPath, [runner, capture, Buffer.from(command).toString('base64')], {
    env: { ...process.env, SHELL: shell },
    input,
    encoding: 'utf8',
  });
}

test('prints only the marker, captures both streams and the exit line, and propagates the exit code', () => {
  const capture = capturePath();
  const result = run(capture, 'echo zebra-fake-out; echo zebra-fake-err >&2; exit 3');

  assert.equal(result.status, 3);
  assert.equal(result.stdout, MARKER);
  assert.equal(result.stderr, '');
  assert.equal(readFileSync(capture, 'utf8'), 'zebra-fake-out\nzebra-fake-err\n\n[exit code 3]\n');
  assert.equal(statSync(capture).mode & 0o777, 0o600);
});

test('pipes the runner stdin to the command', () => {
  const capture = capturePath();
  const result = run(capture, 'cat', 'zebra-fake-in\n');

  assert.equal(result.stdout, MARKER);
  assert.match(readFileSync(capture, 'utf8'), /^zebra-fake-in\n/);
});

test('reports a signal-killed command as 128+n', () => {
  const capture = capturePath();
  const result = run(capture, 'kill -TERM $$');

  assert.equal(result.status, 128 + 15);
  assert.equal(result.stdout, MARKER);
  assert.match(readFileSync(capture, 'utf8'), /\[exit code 143\]\n$/);
});

test('forwards SIGTERM to the command and reports 143', async () => {
  const capture = capturePath();
  const child = spawn(process.execPath, [runner, capture, Buffer.from('echo started; sleep 30').toString('base64')], {
    env: { ...process.env, SHELL: '/bin/sh' },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  let stdout = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  while (!existsSync(capture) || !readFileSync(capture, 'utf8').includes('started')) {
    await sleep(20);
  }
  child.kill('SIGTERM');
  const [code] = await once(child, 'exit');

  assert.equal(code, 143);
  assert.equal(stdout, MARKER);
  assert.match(readFileSync(capture, 'utf8'), /\[exit code 143\]\n$/);
});

test('starts the command as its own process group leader', () => {
  const capture = capturePath();
  // A detached child is its own session and group leader, so its pgid equals its pid.
  run(capture, 'ps -o pid=,pgid=,sess= -p $$ | tr -s " "');
  const [pid, pgid] = readFileSync(capture, 'utf8').trim().split(/\s+/);
  assert.equal(pgid, pid);
});

for (const [name, plant] of [
  ['a pre-existing file', (path: string) => writeFileSync(path, 'zebra-fake-old')],
  ['a symlink', (path: string) => symlinkSync(join(scratch, 'symlink-target'), path)],
] as const) {
  test(`withholds and never runs the command when the capture path is ${name}`, () => {
    const capture = capturePath();
    const sentinel = join(scratch, `ran-${counter}`);
    writeFileSync(join(scratch, 'symlink-target'), 'zebra-fake-target');
    plant(capture);
    const result = run(capture, `touch ${sentinel}; echo zebra-fake-out`);

    assert.equal(result.status, 1);
    assert.equal(
      result.stdout,
      '[phi-guard: output withheld, capture dir not writable under the current sandbox (EEXIST)]\n',
    );
    assert.equal(existsSync(sentinel), false);
    assert.equal(readFileSync(join(scratch, 'symlink-target'), 'utf8'), 'zebra-fake-target');
  });
}

test('writes the withheld line to the capture too when the runner fails after opening it', () => {
  const capture = capturePath();
  const sentinel = join(scratch, `ran-${counter}`);
  const result = run(capture, `touch ${sentinel}; echo zebra-fake-out`, '', '/nonexistent');

  const line = '[phi-guard: output withheld, runner failed (ENOENT)]\n';
  assert.equal(result.status, 1);
  assert.equal(result.stdout, line);
  assert.equal(readFileSync(capture, 'utf8'), line);
  assert.equal(existsSync(sentinel), false);
});

test('withholds when the capture dir does not exist', () => {
  const result = run(join(scratch, 'missing-dir', 'x.out'), 'echo zebra-fake-out');

  assert.equal(result.status, 1);
  assert.equal(
    result.stdout,
    '[phi-guard: output withheld, capture dir not writable under the current sandbox (ENOENT)]\n',
  );
});

test('withholds when invoked without arguments', () => {
  const result = spawnSync(process.execPath, [runner], { encoding: 'utf8' });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /^\[phi-guard: output withheld, .*\(InvalidArguments\)\]\n$/);
});
