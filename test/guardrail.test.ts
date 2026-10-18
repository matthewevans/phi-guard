import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ApplyGuardrailCommandInput, ApplyGuardrailCommandOutput } from '@aws-sdk/client-bedrock-runtime';
import { createScanner, readConfig } from '../src/guardrail.ts';
import { maskBashOutput } from '../src/hooks/bash-output.ts';
import { checkPrompt } from '../src/hooks/prompt.ts';

function scannerReturning(response: Partial<ApplyGuardrailCommandOutput>) {
  const calls: ApplyGuardrailCommandInput[] = [];
  const scan = createScanner(
    async (input) => {
      calls.push(input);
      return response as ApplyGuardrailCommandOutput;
    },
    'gr-123',
    '2',
  );
  return { scan, calls };
}

test('sends the text to the configured guardrail version with the given source', async () => {
  const { scan, calls } = scannerReturning({ action: 'NONE' });
  await scan('hello', 'OUTPUT');
  assert.deepEqual(calls, [
    { guardrailIdentifier: 'gr-123', guardrailVersion: '2', source: 'OUTPUT', content: [{ text: { text: 'hello' } }] },
  ]);
});

test('returns the original text when the guardrail does not intervene', async () => {
  const { scan } = scannerReturning({ action: 'NONE', outputs: [] });
  assert.deepEqual(await scan('nothing here', 'INPUT'), { intervened: false, text: 'nothing here', findings: [] });
});

test('returns masked text and acted-on finding names, never matched values', async () => {
  const { scan } = scannerReturning({
    action: 'GUARDRAIL_INTERVENED',
    outputs: [{ text: 'member {NAME} id {MemberId}' }],
    assessments: [
      {
        sensitiveInformationPolicy: {
          piiEntities: [
            { type: 'NAME', match: 'Jane Roe', action: 'ANONYMIZED', detected: true },
            { type: 'AGE', match: '40 years', action: 'NONE', detected: true },
          ],
          regexes: [{ name: 'MemberId', match: 'M123456789', action: 'ANONYMIZED', detected: true }],
        },
      },
    ],
  });
  const result = await scan('member Jane Roe id M123456789, 40 years', 'OUTPUT');
  assert.deepEqual(result, { intervened: true, text: 'member {NAME} id {MemberId}', findings: ['NAME', 'MemberId'] });
  assert.doesNotMatch(JSON.stringify(result), /Jane Roe|M123456789/);
});

test('propagates guardrail errors so hooks can fail closed', async () => {
  const scan = createScanner(
    async () => {
      throw Object.assign(new Error('rate exceeded'), { name: 'ThrottlingException' });
    },
    'gr-123',
    '2',
  );
  await assert.rejects(scan('text', 'INPUT'), { name: 'ThrottlingException' });
});

const coverage = (guarded: number, total: number) => ({ textCharacters: { guarded, total } });

test('treats a complete scan as a scan', async () => {
  const { scan } = scannerReturning({ action: 'NONE', guardrailCoverage: coverage(5, 5) });
  assert.deepEqual(await scan('hello', 'OUTPUT'), { intervened: false, text: 'hello', findings: [] });
});

for (const action of ['NONE', 'GUARDRAIL_INTERVENED'] as const) {
  test(`rejects with PartialGuardrailCoverage when a ${action} scan covered fewer characters than sent`, async () => {
    const { scan } = scannerReturning({ action, outputs: [{ text: 'masked' }], guardrailCoverage: coverage(3, 5) });
    await assert.rejects(scan('hello', 'OUTPUT'), { name: 'PartialGuardrailCoverage', message: /3 of 5 characters/ });
  });
}

test('treats a coverage report without a guarded count as nothing scanned', async () => {
  const { scan } = scannerReturning({ action: 'NONE', guardrailCoverage: { textCharacters: { total: 5 } } });
  await assert.rejects(scan('hello', 'OUTPUT'), { name: 'PartialGuardrailCoverage', message: /0 of 5 characters/ });
});

test('a partial scan fails both hooks, whose entrypoints turn any scan error into a block or a withheld output', async () => {
  const { scan } = scannerReturning({ action: 'NONE', guardrailCoverage: coverage(3, 5) });
  await assert.rejects(checkPrompt('hello', scan), { name: 'PartialGuardrailCoverage' });
  const response = { stdout: 'hello', stderr: '', interrupted: false, isImage: false };
  await assert.rejects(maskBashOutput(response, scan), { name: 'PartialGuardrailCoverage' });
});

const sentinel = 'fake-sentinel-value';
const fullEnv = {
  TEST_GUARDRAIL_ID: `${sentinel}-id`,
  TEST_GUARDRAIL_VERSION: `${sentinel}-version`,
  TEST_AWS_REGION: `${sentinel}-region`,
  TEST_AWS_PROFILE: `${sentinel}-profile`,
};

test('readConfig reads the prefixed variables, including the optional profile', () => {
  assert.deepEqual(readConfig('TEST_', fullEnv), {
    guardrailId: `${sentinel}-id`,
    guardrailVersion: `${sentinel}-version`,
    region: `${sentinel}-region`,
    profile: `${sentinel}-profile`,
  });
});

test('readConfig leaves the profile unset when it is absent or empty', () => {
  const { TEST_AWS_PROFILE, ...withoutProfile } = fullEnv;
  assert.equal(readConfig('TEST_', withoutProfile).profile, undefined);
  assert.equal(readConfig('TEST_', { ...fullEnv, TEST_AWS_PROFILE: '' }).profile, undefined);
});

for (const name of ['GUARDRAIL_ID', 'GUARDRAIL_VERSION', 'AWS_REGION']) {
  test(`readConfig throws MissingGuardrailConfig naming ${name}, never any value`, () => {
    for (const value of [undefined, '']) {
      const env = { ...fullEnv, [`TEST_${name}`]: value };
      assert.throws(
        () => readConfig('TEST_', env),
        (error: Error) => {
          assert.equal(error.name, 'MissingGuardrailConfig');
          assert.match(error.message, new RegExp(`TEST_${name}`));
          assert.doesNotMatch(error.message, new RegExp(sentinel));
          return true;
        },
      );
    }
  });
}
