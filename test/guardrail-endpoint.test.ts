import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { ApplyGuardrailCommand, BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { createClient } from '../src/guardrail.ts';

const REDIRECT = 'http://127.0.0.1:9';
const REGION = 'us-east-1';

const saved = { ...process.env };
let dir: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'phi-guard-endpoint-'));
  const configFile = join(dir, 'config');
  writeFileSync(
    configFile,
    `[profile redirected]\nregion = ${REGION}\nendpoint_url = ${REDIRECT}\naws_access_key_id = AKIAFAKEFAKEFAKEFAKE\naws_secret_access_key = fake-secret\n`,
  );
  Object.assign(process.env, {
    AWS_ENDPOINT_URL: REDIRECT,
    AWS_ENDPOINT_URL_BEDROCK_RUNTIME: REDIRECT,
    AWS_CONFIG_FILE: configFile,
    AWS_SHARED_CREDENTIALS_FILE: join(dir, 'credentials'),
    AWS_PROFILE: 'redirected',
    AWS_EC2_METADATA_DISABLED: 'true',
  });
});

after(() => {
  process.env = saved;
  rmSync(dir, { recursive: true, force: true });
});

/** Sends an ApplyGuardrail request through a stub handler; reports the host it reached and how the send failed. */
async function send(client: BedrockRuntimeClient): Promise<{ hostname: string; error: Error }> {
  let hostname = '';
  client.config.requestHandler = {
    async handle(request: { hostname: string }) {
      hostname = request.hostname;
      throw new Error('stub: no network');
    },
    destroy() {},
  } as unknown as typeof client.config.requestHandler;
  const input = {
    guardrailIdentifier: 'gr-123',
    guardrailVersion: '1',
    source: 'INPUT' as const,
    content: [{ text: { text: 'fake text' } }],
  };
  const error = await client.send(new ApplyGuardrailCommand(input)).then(
    () => assert.fail('send unexpectedly succeeded'),
    (caught: Error) => caught,
  );
  return { hostname, error };
}

test('control: an unpinned client is redirected by env and shared config', async () => {
  assert.equal((await send(new BedrockRuntimeClient({ region: REGION }))).hostname, '127.0.0.1');
});

test('the client always targets the regional Bedrock endpoint despite env and shared-config overrides', async () => {
  for (const profile of [undefined, 'redirected']) {
    const { hostname } = await send(createClient({ region: REGION, profile }));
    assert.equal(hostname, `bedrock-runtime.${REGION}.amazonaws.com`);
  }
});

test('GovCloud and multi-segment regions resolve to the standard host', async () => {
  for (const region of ['us-gov-west-1', 'ap-southeast-2', 'eu-central-1']) {
    assert.equal((await send(createClient({ region }))).hostname, `bedrock-runtime.${region}.amazonaws.com`);
  }
});

test('a region that could inject a host is rejected before any request leaves', async () => {
  const { hostname, error } = await send(createClient({ region: 'us-east-1.evil.example/x' }));
  assert.equal(hostname, '');
  assert.doesNotMatch(error.message, /stub: no network/);
});
