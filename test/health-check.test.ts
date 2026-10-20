// .devcontainer/health-check.sh runs against PATH stubs for claude, codex and node that
// answer from STUB_* variables. The live path (the real CLIs in the sandbox) is checked by hand.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../.devcontainer/health-check.sh', import.meta.url));

const STUBS = {
  claude: '#!/bin/sh\nprintf %s "$STUB_CLAUDE_OUT"\nexit "${STUB_CLAUDE_STATUS:-0}"\n',
  codex:
    '#!/bin/sh\n' +
    'if [ "$1" = login ]; then exit "${STUB_CODEX_LOGIN_STATUS:-1}"; fi\n' +
    'printf %s "$STUB_CODEX_OUT"\n',
  node: '#!/bin/sh\ncat >/dev/null\nprintf %s "$STUB_NODE_OUT"\n',
};

function check(agent: string, env: Record<string, string> = {}) {
  const stubs = mkdtempSync(join(tmpdir(), 'phi-guard-health-'));
  try {
    for (const [name, body] of Object.entries(STUBS)) {
      writeFileSync(join(stubs, name), body);
      chmodSync(join(stubs, name), 0o755);
    }
    const result = spawnSync('bash', [script, agent], {
      encoding: 'utf8',
      env: { PATH: `${stubs}:${process.env.PATH}`, ...env },
    });
    return { status: result.status, out: result.stdout.trim() };
  } finally {
    rmSync(stubs, { recursive: true, force: true });
  }
}

const claudeRun = (result: string, cost = 0) => JSON.stringify({ type: 'result', total_cost_usd: cost, result });
const BLOCKED =
  'UserPromptSubmit operation blocked by hook:\nphi-guard blocked this prompt: possible NAME, EMAIL. Remove it and resubmit.\n\nOriginal prompt: x';

test('claude passes only when phi-guard blocks the canary before any model call', () => {
  assert.deepEqual(check('claude', { STUB_CLAUDE_OUT: claudeRun(BLOCKED) }), { status: 0, out: '' });
});

test('claude fails with the reason when the hook could not scan', () => {
  const reason = 'phi-guard could not scan this prompt (CredentialsProviderError), so it was blocked.';
  const result = check('claude', {
    STUB_CLAUDE_OUT: claudeRun(`UserPromptSubmit operation blocked by hook:\n${reason}`),
  });
  assert.deepEqual(result, { status: 0, out: reason });
});

test('claude fails when the canary reached the model, printed nothing, or the CLI crashed', () => {
  const notRunning = 'phi-guard did not block the canary prompt, so its hooks are not running';
  assert.equal(check('claude', { STUB_CLAUDE_OUT: claudeRun('Hello! How can I help?', 0.02) }).out, notRunning);
  // A block message with a cost means the model ran anyway.
  assert.equal(check('claude', { STUB_CLAUDE_OUT: claudeRun(BLOCKED, 0.02) }).out, notRunning);
  assert.equal(check('claude', { STUB_CLAUDE_OUT: '' }).out, notRunning);
  assert.notEqual(check('claude', { STUB_CLAUDE_OUT: claudeRun(BLOCKED), STUB_CLAUDE_STATUS: '1' }).status, 0);
});

const codexEvents = (...events: object[]) =>
  ['Reading prompt from stdin...', ...events.map((e) => JSON.stringify(e))].join('\n');
const completed = (tokens: number) => ({ type: 'turn.completed', usage: { input_tokens: tokens, output_tokens: 0 } });

test('codex prints the guardrail reason, and skips the canary when signed out', () => {
  const reason = 'phi-guard could not scan this prompt (CredentialsProviderError), so it was blocked.';
  assert.deepEqual(check('codex', { STUB_NODE_OUT: JSON.stringify({ decision: 'block', reason }) }), {
    status: 0,
    out: reason,
  });
  assert.deepEqual(
    check('codex', { STUB_CODEX_OUT: codexEvents({ type: 'item.completed', item: { type: 'agent_message' } }) }),
    {
      status: 0,
      out: '',
    },
  );
});

test('a signed-in codex must block the canary with zero usage and no agent message', () => {
  const signedIn = { STUB_CODEX_LOGIN_STATUS: '0' };
  const notRunning = 'phi-guard did not block the canary prompt in Codex, so its hooks are not running';
  assert.equal(check('codex', { ...signedIn, STUB_CODEX_OUT: codexEvents(completed(0)) }).out, '');
  assert.equal(check('codex', { ...signedIn, STUB_CODEX_OUT: codexEvents(completed(812)) }).out, notRunning);
  const answered = codexEvents({ type: 'item.completed', item: { type: 'agent_message', text: 'hi' } }, completed(0));
  assert.equal(check('codex', { ...signedIn, STUB_CODEX_OUT: answered }).out, notRunning);
  assert.equal(check('codex', { ...signedIn, STUB_CODEX_OUT: '' }).out, notRunning);
});

test('an unknown agent is a usage error', () => {
  assert.equal(check('shell').status, 2);
});
