// The devcontainer's managed agent config is plain text that only the agents read at
// startup, so a typo would silently drop phi-guard. These checks keep it in step with
// the shipped plugin manifests and hooks files.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'smol-toml';

const root = new URL('../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');
const readJson = (path: string) => JSON.parse(read(path));

const PLUGIN_DIR = '/opt/phi-guard';

// smol-toml returns tables without a prototype, which strict deepEqual tells apart from plain objects.
const readToml = (path: string): Record<string, unknown> => JSON.parse(JSON.stringify(parse(read(path))));

// Narrows a parsed TOML value where a test needs to call array methods on it.
const stringsAt = (value: unknown): string[] => {
  assert.ok(Array.isArray(value) && value.every((item) => typeof item === 'string'));
  return value;
};

const claudePlugin = readJson('.claude-plugin/plugin.json');
const marketplace = readJson('.claude-plugin/marketplace.json');
const pluginId = `${claudePlugin.name}@${marketplace.name}`;
const claudeSettings = readJson('.devcontainer/claude-code/phi-guard.json');

const requirements = readToml('.devcontainer/codex/requirements.toml');
const managedConfig = readToml('.devcontainer/codex/managed_config.toml');
const devcontainer = JSON.parse(read('.devcontainer/devcontainer.json').replace(/^\/\/.*$/gm, ''));
const dockerfile = read('.devcontainer/Dockerfile');
// The image build adds the pluginConfigs options to the managed settings: one jq --arg
// per option, whose value is the build arg (and Codex env var) of the same name.
const optionArgs = [...dockerfile.matchAll(/--arg (\w+) "\$(PHI_GUARD_\w+)"/g)].map((match) => ({
  key: match[1],
  variable: match[2],
}));
const firewallScript = fileURLToPath(new URL('.devcontainer/init-firewall.sh', root));

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
        variable === 'PHI_GUARD_AWS_PROFILE'
          ? '${localEnv:PHI_GUARD_AWS_PROFILE:phi-guard}'
          : `\${localEnv:${variable}}`,
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
  assert.deepEqual(managedConfig.tui, {
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
  assert.match(
    dockerfile,
    /echo '\. \/opt\/phi-guard\/sandbox-banner\.sh' \| tee -a \/etc\/zsh\/zshrc \/etc\/bash\.bashrc/,
  );
  const banner = fileURLToPath(new URL('.devcontainer/sandbox-banner.sh', root));
  const env = { PATH: process.env.PATH, PHI_GUARD_FIREWALL: 'strict' };
  assert.equal(execFileSync('bash', ['-c', '. "$1"', 'bash', banner], { encoding: 'utf8', env }), '');
  const interactive = execFileSync('bash', ['--norc', '-ic', '. "$1"', 'bash', banner], {
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  assert.match(
    interactive,
    /^NO PHI IN THIS SANDBOX\.\n.*personal Claude\/ChatGPT subscription\.\nDo not paste, open or query patient data\. .*\n$/,
  );
});

test('the Dockerfile env gives Codex the same values as the Claude options, from the same build args', () => {
  const variables = optionArgs.map(({ variable }) => variable);
  assert.deepEqual(
    [...dockerfile.matchAll(/^ARG (PHI_GUARD_\w+)(?:=\S+)?$/gm)].map((match) => match[1]),
    variables,
  );
  assert.deepEqual(
    [...dockerfile.matchAll(/^ENV (PHI_GUARD_\w+)=\$(PHI_GUARD_\w+)$/gm)].map((match) => [match[1], match[2]]),
    variables.map((variable) => [variable, variable]),
  );
});

test('Codex managed hooks are the shipped hooks file pointed at the installed plugin', () => {
  const shipped = JSON.parse(read('hooks/codex-hooks.json').replaceAll('${PLUGIN_ROOT}', PLUGIN_DIR)).hooks;
  assert.deepEqual(requirements.hooks, { managed_dir: `${PLUGIN_DIR}/dist`, ...shipped });
});

test('Codex requirements pin hooks on, allow no MCP, and exclude the never approval policy', () => {
  assert.equal(requirements.allow_managed_hooks_only, true);
  assert.deepEqual(requirements.features, { hooks: true });
  assert.deepEqual(requirements.mcp_servers, {});
  assert.deepEqual(requirements.allowed_sandbox_modes, ['read-only', 'danger-full-access']);
  const approvals = stringsAt(requirements.allowed_approval_policies);
  assert.ok(approvals.length > 0 && !approvals.includes('never'));
});

test('Codex defaults pick danger-full-access (the container is the boundary) and an allowed approval policy', () => {
  assert.equal(managedConfig.sandbox_mode, 'danger-full-access');
  assert.ok(stringsAt(requirements.allowed_sandbox_modes).includes(managedConfig.sandbox_mode as string));
  assert.ok(stringsAt(requirements.allowed_approval_policies).includes(managedConfig.approval_policy as string));
  assert.deepEqual(Object.keys(managedConfig).sort(), ['approval_policy', 'sandbox_mode', 'tui']);
});

test('the image pins both CLIs and copies exactly the plugin runtime files', () => {
  assert.match(dockerfile, /^ARG CLAUDE_CODE_VERSION=\d+\.\d+\.\d+$/m);
  assert.match(dockerfile, /^ARG CODEX_VERSION=\d+\.\d+\.\d+$/m);
  assert.doesNotMatch(dockerfile, /^\s+bubblewrap \\$/m);
  const copied = [...dockerfile.matchAll(/^COPY (\S+) \/opt\/phi-guard\/\S+$/gm)].map((match) => match[1]);
  assert.deepEqual(copied, ['.claude-plugin', '.codex-plugin', 'hooks', 'dist']);
});

test('PHI_GUARD_FIREWALL defaults to web, and only the value off skips the firewall script', () => {
  assert.equal(devcontainer.containerEnv.PHI_GUARD_FIREWALL, '${localEnv:PHI_GUARD_FIREWALL:web}');
  assert.equal(devcontainer.containerEnv.PHI_GUARD_EXTRA_HOSTS, '${localEnv:PHI_GUARD_EXTRA_HOSTS:}');

  const stubs = mkdtempSync(join(tmpdir(), 'phi-guard-sudo-'));
  try {
    // Prints each argument in brackets, so an empty argument is visible.
    writeFileSync(
      join(stubs, 'sudo'),
      '#!/bin/sh\nprintf sudo; for arg in "$@"; do printf " [%s]" "$arg"; done; echo\n',
    );
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

// The firewall tests run the real script with every command that could touch the host network
// replaced by a stub that records its call and answers like a healthy host.
const SETTINGS = '/etc/claude-code/managed-settings.d/phi-guard.json';

const NETWORK_TOOLS = [
  'iptables',
  'iptables-save',
  'iptables-restore',
  'ip6tables',
  'ip6tables-save',
  'ip6tables-restore',
  'ipset',
  'nft',
  'ip',
  'dig',
  'curl',
  'jq',
  'aggregate',
] as const;

const NETWORK_STUBS: Record<(typeof NETWORK_TOOLS)[number], string> = {
  iptables: '',
  'iptables-save': '',
  'iptables-restore': '',
  ip6tables: '',
  'ip6tables-save': '',
  'ip6tables-restore': '',
  ipset: '',
  nft: '',
  aggregate: 'cat',
  ip: 'echo "default via 172.17.0.1 dev eth0"',
  dig: 'echo "$4. 300 IN A 192.0.2.10"',
  // Like behind the firewall, the metadata address and example.com are unreachable.
  curl: `case "$*" in *169.254.169.254*|*example.com*) exit 1 ;; *api.github.com/meta*) echo '{}' ;; esac`,
  jq: 'cat >/dev/null\ncase "$1" in -er) echo us-east-2 ;; -r) echo 192.0.2.0/24 ;; esac',
};

const runFirewall = (args: string[], stubOverrides: Partial<typeof NETWORK_STUBS> = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'phi-guard-iptables-'));
  try {
    const log = join(dir, 'calls');
    for (const [tool, body] of Object.entries({ ...NETWORK_STUBS, ...stubOverrides })) {
      writeFileSync(join(dir, tool), `#!/bin/sh\necho ${tool} "$*" >> "${log}"\n${body}\n`, { mode: 0o755 });
    }
    const env = { PATH: `${dir}:${process.env.PATH}` };
    const resolved = execFileSync('bash', ['-c', 'command -v "$@"', 'bash', ...NETWORK_TOOLS], {
      encoding: 'utf8',
      env,
    });
    assert.equal(
      resolved,
      NETWORK_TOOLS.map((tool) => `${join(dir, tool)}\n`).join(''),
      'refusing to run: a network tool does not resolve to its stub',
    );
    const result = spawnSync('bash', [firewallScript, ...args], { encoding: 'utf8', env });
    const calls = existsSync(log) ? readFileSync(log, 'utf8').trimEnd().split('\n') : [];
    return { status: result.status, stdout: result.stdout, calls };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const hostNetworkRules = [
  'iptables -A INPUT -s 172.17.0.0/24 -j ACCEPT',
  'iptables -A OUTPUT -d 172.17.0.0/24 -j ACCEPT',
];
const flushAndLocalRules = [
  'iptables -F',
  'iptables -X',
  'iptables -t nat -F',
  'iptables -t nat -X',
  'iptables -t mangle -F',
  'iptables -t mangle -X',
  'iptables -A OUTPUT -p udp --dport 53 -j ACCEPT',
  'iptables -A INPUT -p udp --sport 53 -j ACCEPT',
  'iptables -A OUTPUT -p tcp --dport 22 -j ACCEPT',
  'iptables -A INPUT -p tcp --sport 22 -m state --state ESTABLISHED -j ACCEPT',
  'iptables -A INPUT -i lo -j ACCEPT',
  'iptables -A OUTPUT -o lo -j ACCEPT',
];
const dropAndEstablishedRules = [
  'iptables -P INPUT DROP',
  'iptables -P FORWARD DROP',
  'iptables -P OUTPUT DROP',
  'iptables -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT',
  'iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT',
];
const iptablesRules = (calls: string[]) => calls.filter((call) => call.startsWith('iptables '));

test('the firewall rejects an unknown mode before any network tool runs', () => {
  for (const args of [[], [''], ['on'], ['WEB'], ['off'], ['bogus', 'a.example.com']]) {
    const result = runFirewall(args);
    assert.equal(result.status, 1, `args: ${JSON.stringify(args)}`);
    assert.match(result.stdout, /ERROR: firewall mode '\w*' is not web or strict/);
    assert.deepEqual(result.calls, [], `args: ${JSON.stringify(args)} called a network tool`);
  }
});

test('strict mode checks the region and that its hosts resolve before it changes a rule', () => {
  const badRegion = runFirewall(['strict'], { jq: 'echo not-a-region' });
  assert.equal(badRegion.status, 1);
  assert.match(badRegion.stdout, /'not-a-region' in \S+ is not an AWS region name/);
  assert.deepEqual(badRegion.calls, [`jq -er .pluginConfigs["phi-guard@phi-guard"].options.aws_region ${SETTINGS}`]);

  const unresolved = runFirewall(['strict'], { dig: '' });
  assert.equal(unresolved.status, 1);
  assert.match(unresolved.stdout, /bedrock-runtime\.us-east-2\.amazonaws\.com does not resolve/);
  assert.deepEqual(
    unresolved.calls.filter((call) => /^(iptables|ipset|ip6tables) /.test(call)),
    [],
  );
});

test('web mode accepts the host network, then rejects each private range, then drops, then accepts the public internet', () => {
  const { status, stdout, calls } = runFirewall(['web']);
  assert.equal(status, 0, stdout);
  assert.deepEqual(iptablesRules(calls), [
    ...flushAndLocalRules,
    ...hostNetworkRules,
    ...['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', '169.254.0.0/16'].map(
      (cidr) => `iptables -A OUTPUT -d ${cidr} -j REJECT --reject-with icmp-admin-prohibited`,
    ),
    ...dropAndEstablishedRules,
    'iptables -A OUTPUT -j ACCEPT',
  ]);
  assert.deepEqual(
    calls.filter((call) => /^(ipset|jq|dig) /.test(call)),
    ['ipset destroy allowed-domains'],
    'web mode has no allowlist, region or host lookups',
  );
  assert.match(stdout, /Firewall verification passed - unable to reach 169\.254\.169\.254 as expected/);
});

test('strict mode builds the allowlist first, then accepts only that set and rejects the rest', () => {
  const { status, stdout, calls } = runFirewall(['strict']);
  assert.equal(status, 0, stdout);
  assert.deepEqual(iptablesRules(calls), [
    ...flushAndLocalRules,
    ...hostNetworkRules,
    ...dropAndEstablishedRules,
    'iptables -A OUTPUT -m set --match-set allowed-domains dst -j ACCEPT',
    'iptables -A OUTPUT -j REJECT --reject-with icmp-admin-prohibited',
  ]);

  const ipsetCalls = calls.filter((call) => call.startsWith('ipset '));
  assert.deepEqual(ipsetCalls.slice(0, 2), ['ipset destroy allowed-domains', 'ipset create allowed-domains hash:net']);
  assert.ok(ipsetCalls.slice(2).every((call) => call.startsWith('ipset add allowed-domains ')));
  assert.ok(
    calls.lastIndexOf(ipsetCalls.at(-1)!) <
      calls.indexOf('iptables -A OUTPUT -m set --match-set allowed-domains dst -j ACCEPT'),
    'the allowlist is complete before the rule that uses it',
  );

  const resolved = calls.flatMap((call) => /^dig \+noall \+answer A (\S+)$/.exec(call)?.[1] ?? []);
  for (const host of [
    'api.anthropic.com',
    'claude.ai',
    'claude.com',
    'platform.claude.com',
    'api.openai.com',
    'chatgpt.com',
    'auth.openai.com',
    'bedrock-runtime.us-east-2.amazonaws.com',
    'sts.us-east-2.amazonaws.com',
  ]) {
    assert.ok(resolved.includes(host), host);
  }
  assert.match(stdout, /Firewall verification passed - unable to reach https:\/\/example\.com as expected/);
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
  const result = spawnSync('bash', ['-c', 'source "$1" && shift && "$@"', 'bash', firewallScript, fn, arg], {
    encoding: 'utf8',
  });
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
  assert.deepEqual(callFirewallFunction('codeartifact_hosts_from_npmrc', '/nonexistent/.npmrc'), {
    hosts: [],
    warnings: '',
  });
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
