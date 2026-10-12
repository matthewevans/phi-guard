import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ApplyGuardrailCommandInput, ApplyGuardrailCommandOutput } from '@aws-sdk/client-bedrock-runtime';
import { createScanner } from '../src/guardrail.ts';

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
