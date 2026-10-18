import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { Scan } from '../src/guardrail.ts';
import { wrapCommand, type CodexPaths } from '../src/hooks/codex-command.ts';
import { maskCodexOutput } from '../src/hooks/codex-post-tool-use.ts';
import { clean, masking, recording } from './fakes.ts';

const uid = process.getuid!();
const scratch = mkdtempSync(join(tmpdir(), 'phi-guard-post-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
const MARKER = '[phi-guard: output captured for scanning]\n';

function setup() {
  const captureDir = mkdtempSync(join(scratch, 'dir-'));
  const paths: CodexPaths = {
    execPath: '/usr/bin/node',
    runnerPath: '/opt/phi-guard/dist/codex-runner.mjs',
    captureDir,
    uid,
  };
  const id = randomUUID();
  const capturePath = join(captureDir, `${id}.out`);
  const input = (command = 'echo hi') => ({
    tool_name: 'Bash',
    tool_input: { command: wrapCommand(paths, command, id) },
    tool_response: MARKER,
  });
  return { paths, capturePath, input };
}

const captured = (path: string, text: string | Buffer) => writeFileSync(path, text, { mode: 0o600 });

test('wrapped, clean: replaces the marker with the captured text and deletes the capture', async () => {
  const { paths, capturePath, input } = setup();
  captured(capturePath, 'ok 12 tests passed\n\n[exit code 0]\n');

  const output = await maskCodexOutput(input(), clean, paths);

  assert.deepEqual(output, { decision: 'block', reason: 'ok 12 tests passed\n\n[exit code 0]\n' });
  assert.equal(existsSync(capturePath), false);
});

test('wrapped, flagged: shows masked text and the finding types, never the raw value', async () => {
  const { paths, capturePath, input } = setup();
  captured(capturePath, 'member zebra-fake-1 found\n\n[exit code 0]\n');

  const output = await maskCodexOutput(input(), masking('zebra-fake-1'), paths);

  assert.equal(output?.decision, 'block');
  assert.match(output!.reason, /^member \{NAME\} found\n/);
  assert.match(output!.reason, /phi-guard masked NAME/);
  assert.doesNotMatch(output!.reason, /zebra-fake-1/);
  assert.equal(existsSync(capturePath), false);
});

test('wrapped, oversize: presents head and tail with an omitted line, scans exactly what it presents', async () => {
  const { paths, capturePath, input } = setup();
  const body = `HEAD${'a'.repeat(100_000)}TAIL`;
  captured(capturePath, body);
  const { scan, seen } = recording();

  const output = await maskCodexOutput(input(), scan, paths);

  assert.equal(seen.length, 1);
  assert.equal(output?.reason, seen[0]);
  assert.ok(seen[0].length <= 20_000);
  assert.ok(seen[0].startsWith('HEAD') && seen[0].endsWith('TAIL'));
  const omitted = /\n\[phi-guard: (\d+) bytes omitted\]\n/.exec(seen[0]);
  assert.ok(omitted);
  assert.equal(seen[0].length - omitted[0].length + Number(omitted[1]), body.length);
  assert.equal(existsSync(capturePath), false);
});

test('wrapped, oversize: a character cut by the byte budget is dropped, not mangled', async () => {
  const { paths, capturePath, input } = setup();
  captured(capturePath, '€'.repeat(30_000));
  const { scan, seen } = recording();

  await maskCodexOutput(input(), scan, paths);

  assert.doesNotMatch(seen[0], /�/);
});

test('wrapped, empty capture: still replaces the marker', async () => {
  const { paths, capturePath, input } = setup();
  captured(capturePath, '');

  assert.deepEqual(await maskCodexOutput(input(), clean, paths), { decision: 'block', reason: '' });
});

test('wrapped, missing capture: withholds and names the sandbox requirement', async () => {
  const { paths, input } = setup();

  const output = await maskCodexOutput(input(), clean, paths);

  assert.equal(output?.decision, 'block');
  assert.match(output!.reason, /^\[phi-guard: output withheld, no capture file was written \(ENOENT\)/);
  assert.match(output!.reason, /danger-full-access/);
  assert.match(output!.reason, /\/tmp/);
});

test('wrapped, symlinked capture: withholds without reading the target', async () => {
  const { paths, capturePath, input } = setup();
  const target = join(scratch, 'target.txt');
  writeFileSync(target, 'zebra-fake-1');
  symlinkSync(target, capturePath);
  const { scan, seen } = recording();

  const output = await maskCodexOutput(input(), scan, paths);

  assert.match(output!.reason, /^\[phi-guard: output withheld, capture file unreadable \(ELOOP\)\]$/);
  assert.deepEqual(seen, []);
  assert.equal(existsSync(target), true);
});

test('wrapped, capture that is not a regular file: withholds', async () => {
  const { paths, capturePath, input } = setup();
  mkdirSync(capturePath);

  const output = await maskCodexOutput(input(), clean, paths);

  assert.match(output!.reason, /^\[phi-guard: output withheld, capture file unreadable \(\w+\)\]$/);
});

test('wrapped, hard-linked capture: withholds and does not scan it', async () => {
  const { paths, capturePath, input } = setup();
  const elsewhere = join(scratch, 'elsewhere.txt');
  writeFileSync(elsewhere, 'zebra-fake-1');
  linkSync(elsewhere, capturePath);
  const { scan, seen } = recording();

  const output = await maskCodexOutput(input(), scan, paths);

  assert.match(output!.reason, /capture file unreadable \(UnsafeCaptureFile\)/);
  assert.deepEqual(seen, []);
  assert.equal(existsSync(capturePath), false, 'our link is removed');
  assert.equal(existsSync(elsewhere), true, 'the other link is untouched');
});

test('wrapped, capture owned by someone else: withholds', async () => {
  const { paths, capturePath, input } = setup();
  captured(capturePath, 'zebra-fake-1');

  // The dir check sees the foreign uid first; either way nothing is scanned.
  const { scan, seen } = recording();
  const output = await maskCodexOutput(input(), scan, { ...paths, uid: uid + 1 });

  assert.match(output!.reason, /capture file unreadable \(Unsafe\w+\)/);
  assert.deepEqual(seen, []);
});

test('wrapped, capture dir that is group-accessible: withholds', async () => {
  const { paths, capturePath, input } = setup();
  captured(capturePath, 'zebra-fake-1');
  chmodSync(paths.captureDir, 0o755);

  const output = await maskCodexOutput(input(), clean, paths);

  assert.match(output!.reason, /capture file unreadable \(UnsafeCaptureDir\)/);
});

test('a runner line whose capture path is outside the capture dir is not read or deleted', async () => {
  const { paths, input } = setup();
  const outside = join(scratch, `${randomUUID()}.out`);
  writeFileSync(outside, 'zebra-fake-1');
  const command = wrapCommand({ ...paths, captureDir: scratch }, 'echo hi', outside.slice(scratch.length + 1, -4));
  const { scan, seen } = recording();

  const output = await maskCodexOutput({ ...input(), tool_input: { command } }, scan, paths);

  assert.equal(output, undefined);
  assert.deepEqual(seen, [MARKER], 'only the tool_response is scanned');
  assert.equal(existsSync(outside), true);
});

test('unwrapped, clean: leaves the output alone', async () => {
  const { paths } = setup();
  const input = { tool_input: { command: 'ls' }, tool_response: 'a.txt\nb.txt\n' };

  assert.equal(await maskCodexOutput(input, clean, paths), undefined);
});

test('unwrapped, flagged: blocks with the masked text', async () => {
  const { paths } = setup();
  const input = { tool_input: { command: 'ls' }, tool_response: 'zebra-fake-1.txt\n' };

  const output = await maskCodexOutput(input, masking('zebra-fake-1'), paths);

  assert.equal(output?.decision, 'block');
  assert.match(output!.reason, /^\{NAME\}\.txt\n/);
  assert.doesNotMatch(output!.reason, /zebra-fake-1/);
});

test('unwrapped, empty: skips scanning', async () => {
  const { paths } = setup();
  const { scan, seen } = recording();

  assert.equal(await maskCodexOutput({ tool_input: { command: 'true' }, tool_response: '' }, scan, paths), undefined);
  assert.deepEqual(seen, []);
});

test('unwrapped, empty command: accepted, because the command is only matched against the runner form', async () => {
  const { paths } = setup();
  const input = { tool_input: { command: '' }, tool_response: 'zebra-fake-1' };

  const output = await maskCodexOutput(input, masking('zebra-fake-1'), paths);

  assert.equal(output?.decision, 'block');
  assert.match(output!.reason, /^\{NAME\}\n/);
});

test('rejects input it cannot interpret so the entrypoint withholds', async () => {
  const { paths } = setup();
  for (const input of [
    null,
    {},
    { tool_input: { command: 'ls' } },
    { tool_input: { command: 'ls' }, tool_response: { stdout: 'x' } },
  ]) {
    await assert.rejects(maskCodexOutput(input, clean, paths), { name: 'InvalidHookInput' });
  }
});

test('a scan failure propagates for the entrypoint to withhold, after the capture is deleted', async () => {
  const { paths, capturePath, input } = setup();
  captured(capturePath, 'zebra-fake-1');
  const failing: Scan = async () => {
    throw Object.assign(new Error('throttled'), { name: 'ThrottlingException' });
  };

  await assert.rejects(maskCodexOutput(input(), failing, paths), { name: 'ThrottlingException' });
  assert.equal(existsSync(capturePath), false);
});
