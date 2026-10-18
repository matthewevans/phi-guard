import assert from 'node:assert/strict';
import { test } from 'node:test';
import { maskBashOutput, withheld, type BashResponse } from '../src/hooks/bash-output.ts';
import { checkPrompt } from '../src/hooks/prompt.ts';
import { clean, masking, recording } from './fakes.ts';

const bash = { stdout: '', stderr: '', interrupted: false, isImage: false };

test('prompt: allows a clean prompt', async () => {
  assert.equal(await checkPrompt('refactor the claims parser', clean), undefined);
});

test('prompt: blocks a flagged prompt, naming types but not values', async () => {
  const decision = await checkPrompt('why did Jane Roe get a 500?', masking('Jane Roe'));
  assert.equal(decision?.decision, 'block');
  assert.match(decision!.reason, /NAME/);
  assert.doesNotMatch(decision!.reason, /Jane Roe/);
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
