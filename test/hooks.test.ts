import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Scan } from '../src/guardrail.ts';
import { maskBashOutput } from '../src/hooks/bash-output.ts';
import { checkPrompt } from '../src/hooks/prompt.ts';

const clean: Scan = async (text) => ({ intervened: false, text, findings: [] });

/** Masks every occurrence of `secret` as {NAME}. */
const masking =
  (secret: string): Scan =>
  async (text) =>
    text.includes(secret)
      ? { intervened: true, text: text.replaceAll(secret, '{NAME}'), findings: ['NAME'] }
      : { intervened: false, text, findings: [] };

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
  const scanned: string[] = [];
  await maskBashOutput({ ...bash, stdout: 'out' }, async (text) => {
    scanned.push(text);
    return { intervened: false, text, findings: [] };
  });
  assert.deepEqual(scanned, ['out']);
});

test('bash: withholds image output it cannot scan', async () => {
  const output = await maskBashOutput({ ...bash, stdout: 'iVBORw0KGgo...', isImage: true }, clean);
  assert.match(output!.hookSpecificOutput.updatedToolOutput.stdout, /withheld/);
  assert.equal(output!.hookSpecificOutput.updatedToolOutput.isImage, false);
});
