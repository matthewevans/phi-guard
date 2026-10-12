// The Codex hooks file and manifest are only read by Codex, which silently ignores
// anything it does not understand (an exec-form hook never runs, so it fails open).
// These checks pin the shape Codex needs.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const readJson = (path: string) => JSON.parse(readFileSync(new URL(path, root), 'utf8'));

const manifest = readJson('.codex-plugin/plugin.json');
const hooks: Record<string, { matcher?: string; hooks: Record<string, unknown>[] }[]> = readJson(
  'hooks/codex-hooks.json',
).hooks;

test('the manifest names the plugin like the Claude Code one and points at an existing hooks file', () => {
  const claude = readJson('.claude-plugin/plugin.json');
  assert.equal(manifest.name, claude.name);
  assert.equal(manifest.version, claude.version);
  assert.match(manifest.hooks, /^\.\//, 'Codex requires ./-relative manifest paths');
  assert.ok(existsSync(new URL(manifest.hooks, root)));
  assert.equal(manifest.hooks, './hooks/codex-hooks.json');
});

test('hooks cover the prompt, and Bash before and after', () => {
  assert.deepEqual(Object.keys(hooks).sort(), ['PostToolUse', 'PreToolUse', 'UserPromptSubmit']);
  assert.equal(hooks.PreToolUse[0].matcher, '^Bash$');
  assert.equal(hooks.PostToolUse[0].matcher, '^Bash$');
});

test('every hook is a shell-string command that fails closed and names a shipped bundle', () => {
  const entries = Object.values(hooks).flatMap((groups) => groups.flatMap((group) => group.hooks));
  assert.equal(entries.length, 3);
  for (const entry of entries) {
    assert.equal(entry.type, 'command');
    assert.equal(typeof entry.command, 'string');
    assert.ok(!('args' in entry) && !('onFailure' in entry), 'Codex ignores args and onFailure');
    assert.equal(entry.timeout, 20);
    assert.equal(typeof entry.statusMessage, 'string');

    const match = /^node "\$\{PLUGIN_ROOT\}\/(dist\/[\w-]+\.mjs)" \|\| \{ echo '[^']+' >&2; exit 2; \}$/.exec(
      entry.command as string,
    );
    assert.ok(match, `unexpected command: ${entry.command}`);
    assert.ok(existsSync(new URL(match[1], root)), `${match[1]} must be built`);
  }
});

test('the runner and PreToolUse bundles never include the AWS SDK', () => {
  for (const bundle of ['codex-runner.mjs', 'codex-pre-tool-use.mjs']) {
    assert.doesNotMatch(readFileSync(new URL(`dist/${bundle}`, root), 'utf8'), /BedrockRuntime|ApplyGuardrail/);
  }
});
