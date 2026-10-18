import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { parseWrapped, wrapCommand, type CodexPaths } from '../src/hooks/codex-command.ts';
import { rewriteCommand } from '../src/hooks/codex-pre-tool-use.ts';

const runnerPath = new URL('../dist/codex-runner.mjs', import.meta.url).pathname;
const uid = process.getuid!();
const scratch = mkdtempSync(join(tmpdir(), 'phi-guard-pre-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

function pathsIn(name: string): CodexPaths {
  return { execPath: process.execPath, runnerPath, captureDir: join(scratch, name), uid };
}

const inputFor = (command: string) => ({ tool_name: 'Bash', tool_input: { command } });

function rewritten(paths: CodexPaths, command: string): string {
  const output = rewriteCommand(inputFor(command), paths);
  assert.ok(output, 'expected a rewrite');
  return output.hookSpecificOutput.updatedInput.command;
}

test('rewrites the command into the exact PreToolUse allow shape and creates a private capture dir', () => {
  const paths = pathsIn('shape');
  const output = rewriteCommand(inputFor('echo hi'), paths);

  assert.deepEqual(Object.keys(output!.hookSpecificOutput), ['hookEventName', 'permissionDecision', 'updatedInput']);
  assert.equal(output!.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(output!.hookSpecificOutput.permissionDecision, 'allow');
  const command = output!.hookSpecificOutput.updatedInput.command;
  const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  assert.match(
    command,
    new RegExp(
      `^'${process.execPath}' '${runnerPath}' '${paths.captureDir}/${uuid}\\.out' ${Buffer.from('echo hi').toString('base64')}$`,
    ),
  );
  assert.equal(statSync(paths.captureDir).mode & 0o777, 0o700);
});

// Each command is run through the real runner and shell: quoting must not alter it.
const commands: [string, string][] = [
  [`printf '%s\\n' "it's" 'say "hi"'`, `it's\nsay "hi"\n`],
  [`X=zebra-fake-1; echo "$X" '$X' \\$X`, `zebra-fake-1 $X $X\n`],
  [`echo one\necho two`, `one\ntwo\n`],
  [`cat <<'EOF'\nfake $HOME 'line'\nEOF`, `fake $HOME 'line'\n`],
];
for (const [command, expected] of commands) {
  test(`rewritten command survives the shell: ${JSON.stringify(command)}`, () => {
    const paths = pathsIn('quoting');
    const line = rewritten(paths, command);
    const result = spawnSync('sh', ['-c', line], { env: { ...process.env, SHELL: '/bin/sh' }, encoding: 'utf8' });
    const capturePath = parseWrapped(paths, line)!;
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(capturePath, 'utf8'), `${expected}\n[exit code 0]\n`);
  });
}

test('loop guard: an exact runner invocation is left alone', () => {
  const paths = pathsIn('guard');
  assert.equal(rewriteCommand(inputFor(rewritten(paths, 'echo hi')), paths), undefined);
});

const guardEscapes = (paths: CodexPaths): [string, string][] => {
  const exact = wrapCommand(paths, 'echo hi');
  const b64 = Buffer.from('echo hi').toString('base64');
  const quoted = (value: string) => `'${value}'`;
  return [
    ['a command that only mentions the runner path', `echo ${quoted(paths.runnerPath)}; cat x`],
    ['an exact runner line followed by more commands', `${exact}; cat secret`],
    ['an exact runner line preceded by more commands', `cat secret; ${exact}`],
    [
      'a capture path outside the capture dir',
      `${quoted(paths.execPath)} ${quoted(paths.runnerPath)} '/etc/${randomUUID()}.out' ${b64}`,
    ],
    [
      'a capture path in a subdirectory',
      `${quoted(paths.execPath)} ${quoted(paths.runnerPath)} '${paths.captureDir}/sub/${randomUUID()}.out' ${b64}`,
    ],
    [
      'a capture path that is not a generated name',
      `${quoted(paths.execPath)} ${quoted(paths.runnerPath)} '${paths.captureDir}/evil.out' ${b64}`,
    ],
    [
      'a capture path that traverses out',
      `${quoted(paths.execPath)} ${quoted(paths.runnerPath)} '${paths.captureDir}/../${randomUUID()}.out' ${b64}`,
    ],
    ['a non-base64 argument', exact.replace(/ \S+$/, ' $(cat${IFS}secret)')],
    ['a different node binary', exact.replace(quoted(paths.execPath), "'/usr/bin/evil-node'")],
  ];
};

for (const [name, command] of guardEscapes(pathsIn('guard'))) {
  test(`loop guard: still wraps ${name}`, () => {
    const paths = pathsIn('guard');
    const line = rewritten(paths, command);
    assert.notEqual(line, command);
    assert.equal(Buffer.from(line.split(' ').at(-1)!, 'base64').toString(), command);
  });
}

test('rejects input without a command, and an empty one the runner could not run', () => {
  for (const input of [null, {}, { tool_input: {} }, { tool_input: { command: 7 } }, inputFor('')]) {
    assert.throws(() => rewriteCommand(input, pathsIn('invalid')), { name: 'InvalidHookInput' });
  }
});

test('capture dir hardening: accepts a private dir the user already owns', () => {
  const paths = pathsIn('existing');
  mkdirSync(paths.captureDir, { mode: 0o700 });
  assert.ok(rewriteCommand(inputFor('echo hi'), paths));
});

test('capture dir hardening: refuses a symlinked dir', () => {
  const paths = pathsIn('symlinked');
  const target = join(scratch, 'symlink-target');
  mkdirSync(target, { mode: 0o700 });
  symlinkSync(target, paths.captureDir);
  assert.throws(() => rewriteCommand(inputFor('echo hi'), paths), { name: 'UnsafeCaptureDir' });
});

test('capture dir hardening: refuses a dir owned by someone else', () => {
  const paths = pathsIn('foreign');
  mkdirSync(paths.captureDir, { mode: 0o700 });
  assert.throws(() => rewriteCommand(inputFor('echo hi'), { ...paths, uid: uid + 1 }), { name: 'UnsafeCaptureDir' });
});

for (const mode of [0o750, 0o705, 0o755, 0o770, 0o777]) {
  test(`capture dir hardening: refuses mode ${mode.toString(8)}`, () => {
    const paths = pathsIn(`mode-${mode.toString(8)}`);
    mkdirSync(paths.captureDir);
    chmodSync(paths.captureDir, mode);
    assert.throws(() => rewriteCommand(inputFor('echo hi'), paths), { name: 'UnsafeCaptureDir' });
  });
}

test('capture dir hardening: refuses a symlink to a non-directory', () => {
  const paths = pathsIn('a-file');
  symlinkSync('/dev/null', paths.captureDir);
  assert.throws(() => rewriteCommand(inputFor('echo hi'), paths), { name: 'UnsafeCaptureDir' });
});
