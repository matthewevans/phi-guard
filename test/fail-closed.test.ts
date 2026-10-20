// Runs the bundled hook entrypoints (dist/*.mjs, the shipped artifact) as Claude Code
// would, to prove every failure path blocks or withholds rather than passing through.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { spawnHangingHook, spawnHook } from './hook-process.ts';

// Obviously fake options, with no credentials anywhere, so the scan itself fails.
const fakeOptions = {
  CLAUDE_PLUGIN_OPTION_GUARDRAIL_ID: 'fake-guardrail-id',
  CLAUDE_PLUGIN_OPTION_GUARDRAIL_VERSION: '1',
  CLAUDE_PLUGIN_OPTION_AWS_REGION: 'us-east-1',
  AWS_SHARED_CREDENTIALS_FILE: '/nonexistent/phi-guard-credentials',
  AWS_CONFIG_FILE: '/nonexistent/phi-guard-config',
};

function runHook(script: string, stdin: string, env: Record<string, string> = {}) {
  const result = spawnHook(script, stdin, { env });
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

test('bash hook withholds output when tool_response lacks stdout or stderr strings', () => {
  const responses = [{}, { output: 'Jane Roe' }, { stdout: 'Jane Roe' }, { stdout: 'Jane Roe', stderr: null }];
  for (const response of responses) {
    const input = JSON.stringify({ tool_name: 'Bash', tool_response: response });
    const output = runHook('bash-output.mjs', input, fakeOptions);
    assert.equal(output.hookSpecificOutput.updatedToolOutput.stdout, withheldFor('InvalidHookInput').stdout);
  }
});

const readResponse = {
  type: 'text',
  file: { filePath: '/w/a.txt', content: 'Jane Roe', numLines: 1, startLine: 1, totalLines: 1 },
};
const readInput = JSON.stringify({ tool_name: 'Read', tool_response: readResponse });
const grepResponse = { mode: 'content', numFiles: 1, filenames: [], content: 'a.txt:1:Jane Roe', numLines: 1 };

test('file hook withholds Read and Grep contents when the guardrail is not configured', () => {
  const read = runHook('file-output.mjs', readInput).hookSpecificOutput.updatedToolOutput;
  assert.deepEqual(read, {
    type: 'text',
    file: {
      filePath: '/w/a.txt',
      content: '[phi-guard: output withheld, scan failed (MissingGuardrailConfig)]',
      numLines: 1,
      startLine: 1,
      totalLines: 1,
    },
  });
  const grep = runHook('file-output.mjs', JSON.stringify({ tool_name: 'Grep', tool_response: grepResponse }));
  assert.deepEqual(grep.hookSpecificOutput.updatedToolOutput, {
    ...grepResponse,
    content: '[phi-guard: output withheld, scan failed (MissingGuardrailConfig)]',
  });
});

test('file hook withholds on unreadable input and on a response without its content string', () => {
  assert.match(runHook('file-output.mjs', 'not json').hookSpecificOutput.updatedToolOutput.file.content, /withheld/);
  const input = JSON.stringify({ tool_name: 'Read', tool_response: { type: 'text', file: {} } });
  assert.equal(
    runHook('file-output.mjs', input, fakeOptions).hookSpecificOutput.updatedToolOutput.file.content,
    '[phi-guard: output withheld, scan failed (InvalidHookInput)]',
  );
});

test('file hook withholds Read contents when the scan itself fails', () => {
  const content = runHook('file-output.mjs', readInput, fakeOptions).hookSpecificOutput.updatedToolOutput.file.content;
  assert.match(content, /^\[phi-guard: output withheld, scan failed \(\w+\)\]$/);
  assert.doesNotMatch(content, /MissingGuardrailConfig/);
});

test('prompt hook blocks when an @-mentioned file cannot be scanned', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'phi-guard-mention-'));
  try {
    writeFileSync(join(cwd, 'scan.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]));
    const output = runHook('prompt.mjs', JSON.stringify({ prompt: 'what is in @scan.png', cwd }), fakeOptions);
    assert.equal(output.decision, 'block');
    assert.match(output.reason, /could not scan this prompt \(UnscannableAttachment\)/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
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

test('every hook enforces its own deadline when stdin never closes', { timeout: 25_000 }, async () => {
  const [prompt, bash, file] = await Promise.all(
    ['prompt.mjs', 'bash-output.mjs', 'file-output.mjs'].map((script) => spawnHangingHook(script)),
  );

  assert.equal(prompt.status, 0);
  assert.match(JSON.parse(prompt.stdout).reason, /HookDeadlineExceeded/);
  assert.equal(bash.status, 0);
  assert.equal(
    JSON.parse(bash.stdout).hookSpecificOutput.updatedToolOutput.stdout,
    '[phi-guard: output withheld, scan failed (HookDeadlineExceeded)]',
  );
  assert.equal(file.status, 0);
  assert.equal(
    JSON.parse(file.stdout).hookSpecificOutput.updatedToolOutput.file.content,
    '[phi-guard: output withheld, scan failed (HookDeadlineExceeded)]',
  );
  for (const { ms } of [prompt, bash, file]) assert.ok(ms < 18_000, 'must finish inside the 20s hook timeout');
});
