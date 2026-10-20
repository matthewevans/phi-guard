import assert from 'node:assert/strict';
import { test } from 'node:test';
import { maskBashOutput, withheld, type BashResponse } from '../src/hooks/bash-output.ts';
import { maskFileOutput, type GrepResponse, type ReadResponse } from '../src/hooks/file-output.ts';
import { checkPrompt } from '../src/hooks/prompt.ts';
import { clean, masking, recording } from './fakes.ts';

const bash = { stdout: '', stderr: '', interrupted: false, isImage: false };
// The shapes Claude Code 2.1.296 sends (observed in the devcontainer).
const read = (content: string, type = 'text'): ReadResponse => ({
  type,
  file: { filePath: '/workspace/notes.txt', content, numLines: 1, startLine: 1, totalLines: 1 },
});
const grep = (content?: string): GrepResponse => ({
  mode: 'content',
  numFiles: 1,
  filenames: [],
  content,
  numLines: 1,
});

test('prompt: allows a clean prompt', async () => {
  assert.equal(await checkPrompt('refactor the claims parser', clean), undefined);
});

test('prompt: blocks a flagged prompt, naming types but not values', async () => {
  const decision = await checkPrompt('why did Jane Roe get a 500?', masking('Jane Roe'));
  assert.equal(decision?.decision, 'block');
  assert.match(decision!.reason, /NAME/);
  assert.doesNotMatch(decision!.reason, /Jane Roe/);
});

test('prompt: blocks on a flagged @-mention attachment, naming where but not values', async () => {
  const { scan, seen } = recording();
  assert.equal(await checkPrompt('summarise @notes.txt', scan, [{ mention: 'notes.txt', text: 'ok' }]), undefined);
  assert.deepEqual(seen, ['summarise @notes.txt', 'ok']);

  const decision = await checkPrompt('summarise @notes.txt', masking('Jane Roe'), [
    { mention: 'notes.txt', text: 'patient Jane Roe' },
  ]);
  assert.equal(decision?.reason, 'phi-guard blocked this prompt: possible NAME in @notes.txt. Remove it and resubmit.');
});

test('prompt: names the prompt and the attachment when both are flagged', async () => {
  const decision = await checkPrompt('Jane Roe: see @a.txt', masking('Jane Roe'), [
    { mention: 'a.txt', text: 'Jane Roe' },
  ]);
  assert.match(decision!.reason, / in the prompt, @a\.txt\./);
});

test('file: masks Read content and keeps the other fields', async () => {
  const output = await maskFileOutput('Read', read('Jane Roe\nok'), masking('Jane Roe'));
  assert.deepEqual(output?.hookSpecificOutput.updatedToolOutput, read('{NAME}\nok'));
  assert.match(output!.hookSpecificOutput.additionalContext!, /NAME/);
});

test('file: masks Grep content and leaves clean or content-less results alone', async () => {
  const output = await maskFileOutput('Grep', grep('notes.txt:1:Jane Roe'), masking('Jane Roe'));
  assert.deepEqual(output?.hookSpecificOutput.updatedToolOutput, grep('notes.txt:1:{NAME}'));

  const { scan, seen } = recording();
  assert.equal(await maskFileOutput('Grep', grep('notes.txt:1:ok'), scan), undefined);
  assert.equal(await maskFileOutput('Grep', { mode: 'files_with_matches', filenames: ['notes.txt'] }, scan), undefined);
  assert.equal(await maskFileOutput('Read', read(''), scan), undefined);
  assert.deepEqual(seen, ['notes.txt:1:ok']);
});

test('file: withholds a non-text Read as text, keeping only the path', async () => {
  const { scan, seen } = recording();
  const output = await maskFileOutput('Read', read('iVBORw0KGgo...', 'image'), scan);
  assert.deepEqual(output?.hookSpecificOutput.updatedToolOutput, {
    type: 'text',
    file: {
      filePath: '/workspace/notes.txt',
      content: '[phi-guard: output withheld, image content cannot be scanned]',
      numLines: 1,
      startLine: 1,
      totalLines: 1,
    },
  });
  assert.deepEqual(seen, []);
});

test('file: rejects an unexpected tool or a response without its content string', async () => {
  const { scan, seen } = recording();
  const cases: [string, unknown][] = [
    ['Bash', read('Jane Roe')],
    ['Read', { type: 'text', file: {} }],
    ['Read', { type: 'text', content: 'Jane Roe' }],
    ['Grep', { mode: 'content', content: ['Jane Roe'] }],
  ];
  for (const [tool, response] of cases) {
    await assert.rejects(maskFileOutput(tool, response as ReadResponse, scan), { name: 'InvalidHookInput' });
  }
  assert.deepEqual(seen, []);
});

test('bash: leaves clean output untouched', async () => {
  assert.equal(await maskBashOutput({ ...bash, stdout: 'ok 12 tests passed' }, clean), undefined);
});

test('bash: masks stdout and stderr independently and keeps extra fields', async () => {
  const response = { ...bash, stdout: 'Jane Roe\nok', stderr: 'warn: Jane Roe', returnCodeInterpretation: 'x' };
  const output = await maskBashOutput(response, masking('Jane Roe'));
  assert.deepEqual(output?.hookSpecificOutput.updatedToolOutput, {
    ...response,
    stdout: '{NAME}\nok',
    stderr: 'warn: {NAME}',
  });
  assert.match(output!.hookSpecificOutput.additionalContext!, /NAME/);
});

test('bash: skips scanning empty streams', async () => {
  const { scan, seen } = recording();
  await maskBashOutput({ ...bash, stdout: 'out' }, scan);
  assert.deepEqual(seen, ['out']);
});

test('bash: rejects a tool_response without stdout and stderr strings instead of passing it unscanned', async () => {
  const { scan, seen } = recording();
  for (const response of [{}, { output: 'Jane Roe' }, { ...bash, stdout: undefined }, { ...bash, stderr: null }]) {
    await assert.rejects(maskBashOutput(response as unknown as BashResponse, scan), { name: 'InvalidHookInput' });
  }
  assert.deepEqual(seen, []);
});

test('bash: a withheld replacement has the full Bash shape even when the response is empty', () => {
  const { stdout, stderr, interrupted, isImage } = withheld({} as BashResponse, 'test').hookSpecificOutput
    .updatedToolOutput as BashResponse;
  assert.equal(typeof stdout, 'string');
  assert.equal(stderr, '');
  assert.equal(interrupted, false);
  assert.equal(isImage, false);
});

test('bash: withholds image output it cannot scan', async () => {
  const output = await maskBashOutput({ ...bash, stdout: 'iVBORw0KGgo...', isImage: true }, clean);
  assert.match(output!.hookSpecificOutput.updatedToolOutput.stdout, /withheld/);
  assert.equal(output!.hookSpecificOutput.updatedToolOutput.isImage, false);
});
