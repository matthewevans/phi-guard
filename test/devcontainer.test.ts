// The devcontainer's managed agent config is plain text that only the agents read at
// startup, so a typo would silently drop phi-guard. These checks keep it in step with
// the shipped plugin manifests and hooks files. Codex requirements are TOML, parsed
// here by a tiny reader that only knows the shapes the file uses (no TOML dependency).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');
const readJson = (path: string) => JSON.parse(read(path));

const PLUGIN_DIR = '/opt/phi-guard';

type Table = { header: string; values: Record<string, unknown> };

// Values are JSON-compatible TOML: basic strings, integers, booleans and string arrays.
const parseToml = (text: string): { top: Record<string, unknown>; tables: Table[] } => {
  const top: Record<string, unknown> = {};
  const tables: Table[] = [];
  for (const line of text.split('\n')) {
    const content = line.trim();
    if (content === '' || content.startsWith('#')) continue;
    const header = /^\[{1,2}([\w.]+)\]{1,2}$/.exec(content);
    if (header) {
      tables.push({ header: header[1], values: {} });
      continue;
    }
    const pair = /^(\w+) = (.+)$/.exec(content);
    assert.ok(pair, `unsupported TOML line: ${content}`);
    (tables.at(-1)?.values ?? top)[pair[1]] = JSON.parse(pair[2]);
  }
  return { top, tables };
};

const claudePlugin = readJson('.claude-plugin/plugin.json');
const marketplace = readJson('.claude-plugin/marketplace.json');
const pluginId = `${claudePlugin.name}@${marketplace.name}`;
const claudeSettings = readJson('.devcontainer/claude-code/phi-guard.json');
const options: Record<string, string> = claudeSettings.pluginConfigs[pluginId].options;

const requirements = parseToml(read('.devcontainer/codex/requirements.toml'));
const managedConfig = parseToml(read('.devcontainer/codex/managed_config.toml'));
const devcontainer = JSON.parse(read('.devcontainer/devcontainer.json').replace(/^\/\/.*$/gm, ''));
const dockerfile = read('.devcontainer/Dockerfile');
const firewall = read('.devcontainer/init-firewall.sh');

const hookTables = (event: string) =>
  requirements.tables.filter((table) => table.header === `hooks.${event}.hooks`).map((table) => table.values);

test('Claude managed settings register and force-enable the plugin with matching option keys', () => {
  assert.deepEqual(claudeSettings.extraKnownMarketplaces[marketplace.name], {
    source: { source: 'directory', path: PLUGIN_DIR },
  });
  assert.equal(claudeSettings.enabledPlugins[pluginId], true);
  assert.deepEqual(Object.keys(options).sort(), Object.keys(claudePlugin.userConfig).sort());
});

test('Claude managed settings lock down bypass, MCP and non-managed hooks', () => {
  assert.equal(claudeSettings.permissions.disableBypassPermissionsMode, 'disable');
  assert.equal(claudeSettings.allowManagedMcpServersOnly, true);
  assert.deepEqual(claudeSettings.allowedMcpServers, []);
  assert.equal(claudeSettings.allowManagedHooksOnly, true);
});

test('Claude managed env fixes PATH and NODE_OPTIONS, which a project settings env could otherwise override', () => {
  assert.equal(claudeSettings.env.PATH, '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin');
  assert.equal(claudeSettings.env.NODE_OPTIONS, devcontainer.containerEnv.NODE_OPTIONS);
});

test('zsh reads its startup files from a root-owned directory, not the home of user node', () => {
  const zdotdir = /^ENV ZDOTDIR=(\S+)$/m.exec(dockerfile)?.[1];
  assert.match(zdotdir ?? '', /^\/etc\//);
});

test('required options are placeholders that cannot pass for real values', () => {
  for (const [key, definition] of Object.entries<{ required?: boolean }>(claudePlugin.userConfig)) {
    if (definition.required) assert.match(options[key], /^REPLACE_IN_PART_2_\w+$/, key);
  }
});

test('the Dockerfile env and AWS profile repeat the Claude placeholders for Codex', () => {
  const env = Object.fromEntries(
    [...dockerfile.matchAll(/^ENV (PHI_GUARD_\w+)=(\S+)$/gm)].map((match) => [match[1], match[2]]),
  );
  assert.deepEqual(env, {
    PHI_GUARD_GUARDRAIL_ID: options.guardrail_id,
    PHI_GUARD_GUARDRAIL_VERSION: options.guardrail_version,
    PHI_GUARD_AWS_REGION: options.aws_region,
    PHI_GUARD_AWS_PROFILE: options.aws_profile,
  });

  assert.equal(
    read('.devcontainer/aws-config').replace(/^#.*\n/gm, ''),
    `[profile ${options.aws_profile}]\nregion = ${options.aws_region}\n`,
  );
});

test('Codex managed hooks are the shipped hooks file pointed at the installed plugin', () => {
  const shipped: Record<string, { matcher?: string; hooks: Record<string, unknown>[] }[]> =
    readJson('hooks/codex-hooks.json').hooks;
  assert.deepEqual(
    requirements.tables.filter((table) => /^hooks\.\w+$/.test(table.header)).map((table) => table.header.slice(6)),
    Object.keys(shipped),
  );
  for (const [event, groups] of Object.entries(shipped)) {
    const groupTables = requirements.tables.filter((table) => table.header === `hooks.${event}`);
    assert.deepEqual(
      groupTables.map((table) => table.values.matcher),
      groups.map((group) => group.matcher),
      `${event} matchers`,
    );
    assert.deepEqual(
      hookTables(event),
      groups.flatMap((group) =>
        group.hooks.map((hook) => ({
          type: hook.type,
          command: (hook.command as string).replaceAll('${PLUGIN_ROOT}', PLUGIN_DIR),
          timeout: hook.timeout,
          statusMessage: hook.statusMessage,
        })),
      ),
      `${event} hooks`,
    );
  }
  assert.equal(requirements.tables.find((table) => table.header === 'hooks')?.values.managed_dir, `${PLUGIN_DIR}/dist`);
});

test('Codex requirements pin hooks on, allow no MCP, and exclude the never approval policy', () => {
  assert.equal(requirements.top.allow_managed_hooks_only, true);
  assert.deepEqual(requirements.tables.find((table) => table.header === 'features')?.values, { hooks: true });
  assert.deepEqual(requirements.tables.find((table) => table.header === 'mcp_servers')?.values, {});
  assert.deepEqual(requirements.top.allowed_sandbox_modes, ['read-only', 'danger-full-access']);
  const approvals = requirements.top.allowed_approval_policies as string[];
  assert.ok(approvals.length > 0 && !approvals.includes('never'));
});

test('Codex defaults pick danger-full-access (the container is the boundary) and an allowed approval policy', () => {
  assert.equal(managedConfig.top.sandbox_mode, 'danger-full-access');
  assert.ok((requirements.top.allowed_sandbox_modes as string[]).includes(managedConfig.top.sandbox_mode as string));
  assert.ok((requirements.top.allowed_approval_policies as string[]).includes(managedConfig.top.approval_policy as string));
  assert.deepEqual(managedConfig.tables, []);
});

test('the image pins both CLIs and copies exactly the plugin runtime files', () => {
  assert.match(dockerfile, /^ARG CLAUDE_CODE_VERSION=\d+\.\d+\.\d+$/m);
  assert.match(dockerfile, /^ARG CODEX_VERSION=\d+\.\d+\.\d+$/m);
  assert.doesNotMatch(dockerfile, /^\s+bubblewrap \\$/m);
  const copied = [...dockerfile.matchAll(/^COPY (\S+) \/opt\/phi-guard\/\S+$/gm)].map((match) => match[1]);
  assert.deepEqual(copied, ['.claude-plugin', '.codex-plugin', 'hooks', 'dist']);
});

test('the firewall validates the region before flushing and allows the agents and Bedrock', () => {
  const script = fileURLToPath(new URL('.devcontainer/init-firewall.sh', root));
  execFileSync('bash', ['-n', script]);
  assert.ok(firewall.includes('/etc/claude-code/managed-settings.d/phi-guard.json'));
  assert.ok(
    firewall.indexOf('is not an AWS region name') < firewall.indexOf('iptables -F'),
    'region validation must come before any flush',
  );
  for (const host of [
    'api.anthropic.com',
    'claude.ai',
    'claude.com',
    'platform.claude.com',
    'api.openai.com',
    'chatgpt.com',
    'auth.openai.com',
    'bedrock-runtime.${REGION}.amazonaws.com',
    'sts.${REGION}.amazonaws.com',
  ]) {
    assert.ok(firewall.includes(host), host);
  }
});

test('PHI_GUARD_FIREWALL defaults to on, and only the value off skips the firewall script', () => {
  assert.equal(devcontainer.containerEnv.PHI_GUARD_FIREWALL, '${localEnv:PHI_GUARD_FIREWALL:on}');

  const stubs = mkdtempSync(join(tmpdir(), 'phi-guard-sudo-'));
  try {
    writeFileSync(join(stubs, 'sudo'), '#!/bin/sh\necho "sudo $*"\n');
    chmodSync(join(stubs, 'sudo'), 0o755);
    const run = (value: string) =>
      execFileSync('sh', ['-c', devcontainer.postStartCommand], {
        encoding: 'utf8',
        env: { PATH: `${stubs}:${process.env.PATH}`, PHI_GUARD_FIREWALL: value },
      });

    assert.equal(run('on'), 'sudo /usr/local/bin/init-firewall.sh\n');
    assert.equal(run(''), 'sudo /usr/local/bin/init-firewall.sh\n');
    assert.equal(run('off'), 'phi-guard: egress firewall disabled (PHI_GUARD_FIREWALL=off)\n');
  } finally {
    rmSync(stubs, { recursive: true, force: true });
  }
});
