// The devcontainer's managed agent config is plain text that only the agents read at
// startup, so a typo would silently drop phi-guard. These checks keep it in step with
// the shipped plugin manifests and hooks files. Codex requirements are TOML, parsed
// here by a tiny reader that only knows the shapes the file uses (no TOML dependency).
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

const requirements = parseToml(read('.devcontainer/codex/requirements.toml'));
const managedConfig = parseToml(read('.devcontainer/codex/managed_config.toml'));
const devcontainer = JSON.parse(read('.devcontainer/devcontainer.json').replace(/^\/\/.*$/gm, ''));
const dockerfile = read('.devcontainer/Dockerfile');
// The image build adds the pluginConfigs options to the managed settings: one jq --arg
// per option, whose value is the build arg (and Codex env var) of the same name.
const optionArgs = [...dockerfile.matchAll(/--arg (\w+) "\$(PHI_GUARD_\w+)"/g)].map((match) => ({
  key: match[1],
  variable: match[2],
}));
const firewall = read('.devcontainer/init-firewall.sh');

const hookTables = (event: string) =>
  requirements.tables.filter((table) => table.header === `hooks.${event}.hooks`).map((table) => table.values);

test('Claude managed settings register and force-enable the plugin with matching option keys', () => {
  assert.deepEqual(claudeSettings.extraKnownMarketplaces[marketplace.name], {
    source: { source: 'directory', path: PLUGIN_DIR },
  });
  assert.equal(claudeSettings.enabledPlugins[pluginId], true);
  assert.equal(claudeSettings.pluginConfigs, undefined, 'the image build adds the options');
  assert.ok(dockerfile.includes(`'.pluginConfigs["${pluginId}"].options = $ARGS.named'`));
  assert.deepEqual(optionArgs.map(({ key }) => key).sort(), Object.keys(claudePlugin.userConfig).sort());
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

test('the Dockerfile refuses to build unless every required option has a value', () => {
  const required = Object.entries<{ required?: boolean }>(claudePlugin.userConfig)
    .filter(([, definition]) => definition.required)
    .map(([key]) => `PHI_GUARD_${key.toUpperCase()}`);
  assert.equal(/^  for name in (.+); do \\$/m.exec(dockerfile)?.[1], required.join(' '));
  for (const { key, variable } of optionArgs) assert.equal(variable, `PHI_GUARD_${key.toUpperCase()}`);
});

test('the host environment feeds the build args, and the AWS profile defaults to phi-guard', () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(devcontainer.build.args).filter(([name]) => name.startsWith('PHI_GUARD_'))),
    Object.fromEntries(
      optionArgs.map(({ variable }) => [
        variable,
        variable === 'PHI_GUARD_AWS_PROFILE' ? '${localEnv:PHI_GUARD_AWS_PROFILE:phi-guard}' : `\${localEnv:${variable}}`,
      ]),
    ),
  );
  assert.match(dockerfile, /^ARG PHI_GUARD_AWS_PROFILE=phi-guard$/m);
});

test('the sandbox logins live in fixed named volumes shared by every repo, apart from the host config', () => {
  const mounts: string[] = devcontainer.mounts;
  for (const [volume, dir] of [
    ['phi-guard-claude-config', '.claude'],
    ['phi-guard-codex-config', '.codex'],
  ]) {
    assert.ok(mounts.includes(`source=${volume},target=/home/node/${dir},type=volume`), volume);
  }
});

test('the container hostname and the Codex TUI show the sandbox, with item ids valid for each list', () => {
  assert.ok(devcontainer.runArgs.includes('--hostname=phi-guard-sandbox'));
  // Ids come from the Codex source (StatusLineItem and TerminalTitleItem). The title list
  // has no hostname item, and an invalid id only produces a warning in the TUI.
  assert.deepEqual(managedConfig.tables.find((table) => table.header === 'tui')?.values, {
    status_line: ['hostname', 'model-with-reasoning', 'five-hour-limit', 'weekly-limit', 'current-dir'],
    terminal_title: ['activity', 'project-name'],
  });
});

test('the managed Claude status line is the root-owned script that says no PHI and names the firewall mode', () => {
  assert.deepEqual(claudeSettings.statusLine, { type: 'command', command: `${PLUGIN_DIR}/statusline.sh` });
  assert.match(dockerfile, /^COPY .*\.devcontainer\/statusline\.sh .* \/opt\/phi-guard\/$/m);
  assert.match(dockerfile, /^RUN chmod 0755 \/opt\/phi-guard\/statusline\.sh/m);
  const script = fileURLToPath(new URL('.devcontainer/statusline.sh', root));
  const run = (env: Record<string, string>) =>
    execFileSync(script, { encoding: 'utf8', input: '{}', env: { PATH: process.env.PATH, ...env } });
  assert.equal(run({}), 'NO PHI · personal subscription sandbox · firewall: web\n');
  assert.equal(run({ PHI_GUARD_FIREWALL: 'strict' }), 'NO PHI · personal subscription sandbox · firewall: strict\n');
});

test('both system rc files source the banner, which stays silent unless the shell is interactive', () => {
  assert.match(dockerfile, /echo '\. \/opt\/phi-guard\/sandbox-banner\.sh' \| tee -a \/etc\/zsh\/zshrc \/etc\/bash\.bashrc/);
  const banner = fileURLToPath(new URL('.devcontainer/sandbox-banner.sh', root));
  const env = { PATH: process.env.PATH, PHI_GUARD_FIREWALL: 'strict' };
  assert.equal(execFileSync('bash', ['-c', '. "$1"', 'bash', banner], { encoding: 'utf8', env }), '');
  const interactive = execFileSync('bash', ['--norc', '-ic', '. "$1"', 'bash', banner], {
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  assert.match(interactive, /^NO PHI IN THIS SANDBOX\.\n.*personal Claude\/ChatGPT subscription\.\nDo not paste, open or query patient data\. .*\n$/);
});

test('the Dockerfile env gives Codex the same values as the Claude options, from the same build args', () => {
  const variables = optionArgs.map(({ variable }) => variable);
  assert.deepEqual([...dockerfile.matchAll(/^ARG (PHI_GUARD_\w+)(?:=\S+)?$/gm)].map((match) => match[1]), variables);
  assert.deepEqual(
    [...dockerfile.matchAll(/^ENV (PHI_GUARD_\w+)=\$(PHI_GUARD_\w+)$/gm)].map((match) => [match[1], match[2]]),
    variables.map((variable) => [variable, variable]),
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
  assert.deepEqual(managedConfig.tables.map((table) => table.header), ['tui']);
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
  assert.ok(
    firewall.indexOf('optional_hosts=$(') < firewall.indexOf('iptables -F'),
    'optional host validation must come before any flush',
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

test('PHI_GUARD_FIREWALL defaults to web, and only the value off skips the firewall script', () => {
  assert.equal(devcontainer.containerEnv.PHI_GUARD_FIREWALL, '${localEnv:PHI_GUARD_FIREWALL:web}');
  assert.equal(devcontainer.containerEnv.PHI_GUARD_EXTRA_HOSTS, '${localEnv:PHI_GUARD_EXTRA_HOSTS:}');

  const stubs = mkdtempSync(join(tmpdir(), 'phi-guard-sudo-'));
  try {
    // Prints each argument in brackets, so an empty argument is visible.
    writeFileSync(join(stubs, 'sudo'), '#!/bin/sh\nprintf sudo; for arg in "$@"; do printf " [%s]" "$arg"; done; echo\n');
    chmodSync(join(stubs, 'sudo'), 0o755);
    const run = (firewall: string, extraHosts: string) =>
      execFileSync('sh', ['-c', devcontainer.postStartCommand], {
        encoding: 'utf8',
        env: { PATH: `${stubs}:${process.env.PATH}`, PHI_GUARD_FIREWALL: firewall, PHI_GUARD_EXTRA_HOSTS: extraHosts },
      });

    assert.equal(run('web', ''), 'sudo [/usr/local/bin/init-firewall.sh] [web] []\n');
    assert.equal(
      run('strict', 'a.example.com,b.example.com'),
      'sudo [/usr/local/bin/init-firewall.sh] [strict] [a.example.com,b.example.com]\n',
    );
    // Any other value reaches the script, which rejects it.
    assert.equal(run('', ''), 'sudo [/usr/local/bin/init-firewall.sh] [] []\n');
    assert.equal(run('off', 'a.example.com'), 'phi-guard: egress firewall disabled (PHI_GUARD_FIREWALL=off)\n');
  } finally {
    rmSync(stubs, { recursive: true, force: true });
  }
});

test('the firewall rejects an unknown mode before any iptables call', () => {
  const script = fileURLToPath(new URL('.devcontainer/init-firewall.sh', root));
  const stubs = mkdtempSync(join(tmpdir(), 'phi-guard-iptables-'));
  try {
    // Every firewall tool the script could call records its name in a log.
    const log = join(stubs, 'calls');
    for (const tool of ['iptables', 'iptables-save', 'ipset', 'curl', 'jq', 'dig']) {
      writeFileSync(join(stubs, tool), `#!/bin/sh\necho ${tool} >> "${log}"\n`);
      chmodSync(join(stubs, tool), 0o755);
    }
    for (const args of [[], [''], ['on'], ['WEB'], ['off'], ['bogus', 'a.example.com']]) {
      const result = spawnSync('bash', [script, ...args], {
        encoding: 'utf8',
        env: { PATH: `${stubs}:${process.env.PATH}` },
      });
      assert.equal(result.status, 1, `args: ${JSON.stringify(args)}`);
      assert.match(result.stdout, /ERROR: firewall mode '\w*' is not web or strict/);
      assert.equal(existsSync(log), false, `args: ${JSON.stringify(args)} called a firewall tool`);
    }
  } finally {
    rmSync(stubs, { recursive: true, force: true });
  }
});

test('the web mode needs no region and rejects each private range after the host-network accepts', () => {
  assert.match(firewall, /if \[ "\$MODE" = strict \]; then\n    REGION=\$\(jq /, 'region lookup is for strict mode only');
  assert.match(firewall, /if \[ "\$MODE" = strict \]; then\n    # Create ipset/, 'the allowlist is for strict mode only');
  const accept = firewall.indexOf('iptables -A OUTPUT -d "$HOST_NETWORK" -j ACCEPT');
  const rejects = /for cidr in ([\d./ ]+); do\n\s+iptables -A OUTPUT -d "\$cidr" -j REJECT/.exec(firewall);
  assert.ok(rejects, 'private ranges are rejected in a loop');
  assert.deepEqual(rejects[1].split(' '), [
    '10.0.0.0/8',
    '172.16.0.0/12',
    '192.168.0.0/16',
    '100.64.0.0/10',
    '169.254.0.0/16',
  ]);
  const rejectAt = firewall.indexOf(rejects[0]);
  assert.ok(accept !== -1 && accept < rejectAt, 'host-network accept must come before the private rejects');
  assert.ok(rejectAt < firewall.indexOf('iptables -P OUTPUT DROP'), 'private rejects come before the DROP policy');
  assert.ok(
    firewall.indexOf('iptables -A OUTPUT -j ACCEPT') > firewall.indexOf('iptables -P OUTPUT DROP'),
    'the public accept comes last',
  );
  assert.match(
    firewall,
    /if \[ "\$MODE" = web \]; then\n\s+#[^\n]*\n\s+iptables -A OUTPUT -j ACCEPT\nelse/,
    'the public accept is web-only',
  );
});

test('the host ~/.aws and ~/.npmrc are bind-mounted read-only, so the agent cannot plant a credential_process', () => {
  const mounts: string[] = devcontainer.mounts;
  for (const name of ['.aws', '.npmrc']) {
    assert.ok(
      mounts.includes(`source=\${localEnv:HOME}/${name},target=/home/node/${name},type=bind,readonly`),
      `${name} mount`,
    );
  }
});

test('initializeCommand creates the mount sources and leaves an existing ~/.npmrc alone', () => {
  const home = mkdtempSync(join(tmpdir(), 'phi-guard-home-'));
  try {
    writeFileSync(join(home, '.npmrc'), 'fake-line\n');
    execFileSync('sh', ['-c', devcontainer.initializeCommand], { env: { PATH: process.env.PATH, HOME: home } });
    assert.ok(statSync(join(home, '.aws')).isDirectory());
    assert.equal(readFileSync(join(home, '.npmrc'), 'utf8'), 'fake-line\n');

    rmSync(join(home, '.npmrc'));
    execFileSync('sh', ['-c', devcontainer.initializeCommand], { env: { PATH: process.env.PATH, HOME: home } });
    assert.ok(existsSync(join(home, '.npmrc')));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// Sources the firewall script, which only defines functions then, and calls one.
const callFirewallFunction = (fn: string, arg: string) => {
  const script = fileURLToPath(new URL('.devcontainer/init-firewall.sh', root));
  const result = spawnSync('bash', ['-c', 'source "$1" && shift && "$@"', 'bash', script, fn, arg], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return { hosts: result.stdout.split('\n').filter(Boolean), warnings: result.stderr };
};

const withFile = (content: string, check: (path: string) => void) => {
  const dir = mkdtempSync(join(tmpdir(), 'phi-guard-fw-'));
  try {
    const path = join(dir, 'file');
    writeFileSync(path, content);
    check(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test('the firewall derives SSO hosts from each valid sso_region in the AWS config', () => {
  const config = [
    '[default]',
    'region = us-east-1',
    '[profile phi-guard]',
    'sso_session = corp',
    'sso_account_id = 123456789012',
    '[sso-session corp]',
    'sso_start_url = https://example.awsapps.com/start',
    'sso_region = us-east-2',
    '[profile other]',
    '  sso_region = eu-west-1  ',
    'sso_region = us-east-2',
    'sso_region = evil.com;rm -rf /',
    '',
  ].join('\n');
  withFile(config, (path) => {
    const { hosts, warnings } = callFirewallFunction('sso_hosts_from_config', path);
    assert.deepEqual(hosts, [
      'portal.sso.eu-west-1.amazonaws.com',
      'oidc.eu-west-1.amazonaws.com',
      'portal.sso.us-east-2.amazonaws.com',
      'oidc.us-east-2.amazonaws.com',
    ]);
    assert.match(warnings, /invalid sso_region 'evil\.com;rm -rf \/'/);
  });
  assert.deepEqual(callFirewallFunction('sso_hosts_from_config', '/nonexistent/config'), { hosts: [], warnings: '' });
});

test('the firewall derives only CodeArtifact registry hosts from the npmrc and never prints a token', () => {
  const npmrc = [
    'registry=https://corp-123456789012.d.codeartifact.us-east-2.amazonaws.com/npm/repo/',
    '@acme:registry="https://acme-123456789012.d.codeartifact.eu-west-1.amazonaws.com/npm/other/"',
    '//corp-123456789012.d.codeartifact.us-east-2.amazonaws.com/npm/repo/:_authToken=fake-token-do-not-print',
    '@evil:registry=https://evil.example.com/npm/',
    'registry=https://corp-123456789012.d.codeartifact.us-east-2.amazonaws.com.evil.com/npm/',
    'registry=http://corp-123456789012.d.codeartifact.us-east-2.amazonaws.com/npm/',
    '',
  ].join('\n');
  withFile(npmrc, (path) => {
    const result = callFirewallFunction('codeartifact_hosts_from_npmrc', path);
    assert.deepEqual(result, {
      hosts: [
        'acme-123456789012.d.codeartifact.eu-west-1.amazonaws.com',
        'corp-123456789012.d.codeartifact.us-east-2.amazonaws.com',
      ],
      warnings: '',
    });
  });
  assert.deepEqual(callFirewallFunction('codeartifact_hosts_from_npmrc', '/nonexistent/.npmrc'), { hosts: [], warnings: '' });
});

test('the firewall accepts only plain hostnames from PHI_GUARD_EXTRA_HOSTS', () => {
  const { hosts, warnings } = callFirewallFunction(
    'extra_hosts_from_list',
    'pypi.example.com, files-123456789012.example.com ,evil.com;rm -rf /,https://x/y,*.foo,host:443,,under_score.com,',
  );
  assert.deepEqual(hosts, ['pypi.example.com', 'files-123456789012.example.com']);
  for (const rejected of ['evil.com;rm -rf /', 'https://x/y', '*.foo', 'host:443', 'under_score.com']) {
    assert.ok(warnings.includes(`'${rejected}'`), rejected);
  }
  assert.deepEqual(callFirewallFunction('extra_hosts_from_list', ''), { hosts: [], warnings: '' });
});
