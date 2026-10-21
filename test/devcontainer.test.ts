// The devcontainer's managed agent config is plain text that only the agents read at
// startup, so a typo would silently drop phi-guard. These checks keep it in step with
// the shipped plugin manifests and hooks files.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
// `aws_profile` stays a plugin userConfig key for host installs, but the sandbox sets no
// profile: its hooks use the default credential chain over the mounted credentials file.
const sandboxOptionKeys = Object.keys(claudePlugin.userConfig).filter((key) => key !== 'aws_profile');
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
  assert.deepEqual(optionArgs.map(({ key }) => key).sort(), sandboxOptionKeys.sort());
});

// Server-managed settings from an org login replace the managed file, so every claude start
// goes through a wrapper that loads the plugin and its options from the command line too.
test('the claude on PATH is the wrapper, which loads the plugin from the command line', () => {
  const cli = '/usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe';
  assert.ok(dockerfile.includes(`RUN test -x ${cli} && rm /usr/local/bin/claude\n`));
  assert.match(dockerfile, /^COPY \.devcontainer\/claude\.sh \/usr\/local\/bin\/claude$/m);
  assert.match(dockerfile, /^RUN chmod 0755 \/usr\/local\/bin\/claude$/m);
  assert.ok(
    read('.devcontainer/claude.sh').includes(
      `exec ${cli} \\\n  --plugin-dir ${PLUGIN_DIR} --settings ${PLUGIN_DIR}/claude-settings.json "$@"\n`,
    ),
  );
});

test("the wrapper's settings carry the managed options under the inline plugin id, plus the env, permissions and status line", () => {
  const filter = /^RUN jq '(.+)' \\$/m.exec(dockerfile)?.[1];
  assert.ok(filter, 'the Dockerfile builds claude-settings.json with jq');
  assert.match(dockerfile, new RegExp(`\\n  ${SETTINGS} > ${PLUGIN_DIR}/claude-settings\\.json\\n`));
  const options = { guardrail_id: 'g', guardrail_version: '1', aws_region: 'us-east-1' };
  const managed = { ...claudeSettings, pluginConfigs: { [pluginId]: { options } } };
  const flags = JSON.parse(execFileSync('jq', [filter], { input: JSON.stringify(managed), encoding: 'utf8' }));
  assert.deepEqual(flags, {
    env: claudeSettings.env,
    permissions: claudeSettings.permissions,
    statusLine: claudeSettings.statusLine,
    pluginConfigs: { [`${claudePlugin.name}@inline`]: { options } },
  });
});

test('the image ships the health check and the sync script that bin/nophi runs', () => {
  for (const script of ['health-check', 'sync']) {
    assert.match(dockerfile, new RegExp(`^COPY .*\\.devcontainer/${script}\\.sh .*/opt/phi-guard/$`, 'm'));
    assert.match(dockerfile, new RegExp(`^RUN chmod 0755 .*/opt/phi-guard/${script}\\.sh`, 'm'));
  }
  const launcher = read('bin/nophi');
  assert.ok(launcher.includes(`bash ${PLUGIN_DIR}/health-check.sh "$cmd"`));
  assert.ok(launcher.includes(`bash ${PLUGIN_DIR}/sync.sh in "$ref"`));
  assert.ok(launcher.includes(`bash ${PLUGIN_DIR}/sync.sh out`));
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

test('the host environment feeds the three build args, and the image knows no AWS profile', () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(devcontainer.build.args).filter(([name]) => name.startsWith('PHI_GUARD_'))),
    Object.fromEntries(optionArgs.map(({ variable }) => [variable, `\${localEnv:${variable}}`])),
  );
  assert.equal(optionArgs.length, 3);
  assert.doesNotMatch(dockerfile, /AWS_PROFILE/);
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
  assert.equal(run({}), 'NO PHI · personal subscription sandbox · firewall: strict\n');
  assert.equal(run({ PHI_GUARD_FIREWALL: 'web' }), 'NO PHI · personal subscription sandbox · firewall: web\n');
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

test('the image has a root-owned /etc/phi-guard for the firewall pin, which the script defaults to', () => {
  assert.match(dockerfile, /^ {2}mkdir -p \/etc\/phi-guard && \\$/m);
  assert.match(read('.devcontainer/init-firewall.sh'), /^PIN=\$\{FIREWALL_ARGS:-\/etc\/phi-guard\/firewall-args\}$/m);
});

test('the image pins both CLIs and copies exactly the plugin runtime files', () => {
  assert.match(dockerfile, /^ARG CLAUDE_CODE_VERSION=\d+\.\d+\.\d+$/m);
  assert.match(dockerfile, /^ARG CODEX_VERSION=\d+\.\d+\.\d+$/m);
  assert.doesNotMatch(dockerfile, /^\s+bubblewrap \\$/m);
  const copied = [...dockerfile.matchAll(/^COPY (\S+) \/opt\/phi-guard\/\S+$/gm)].map((match) => match[1]);
  assert.deepEqual(copied, ['.claude-plugin', '.codex-plugin', 'hooks', 'dist']);
});

test('PHI_GUARD_FIREWALL defaults to strict, and only the value off skips the firewall script', () => {
  assert.equal(devcontainer.containerEnv.PHI_GUARD_FIREWALL, '${localEnv:PHI_GUARD_FIREWALL:strict}');
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
// replaced by a stub that records its call and answers like a healthy host. The script's two
// test-only overrides point it at a fake resolv.conf and a pin file in the temp directory.
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

// Two IPv4 resolvers among the lines the script must skip.
const RESOLV_CONF = [
  '# Generated by Docker Engine',
  'search example.com',
  'nameserver 192.0.2.53',
  'nameserver 2001:db8::1',
  'nameserver 198.51.100.7',
  'options ndots:0',
  '',
].join('\n');
const resolvers = ['192.0.2.53', '198.51.100.7'];

type FirewallFiles = { pin?: string; resolv?: string };

const runFirewall = (
  args: string[],
  stubOverrides: Partial<typeof NETWORK_STUBS> = {},
  { pin, resolv = RESOLV_CONF }: FirewallFiles = {},
) => {
  const dir = mkdtempSync(join(tmpdir(), 'phi-guard-iptables-'));
  try {
    const log = join(dir, 'calls');
    for (const [tool, body] of Object.entries({ ...NETWORK_STUBS, ...stubOverrides })) {
      writeFileSync(join(dir, tool), `#!/bin/sh\necho ${tool} "$*" >> "${log}"\n${body}\n`, { mode: 0o755 });
    }
    const pinFile = join(dir, 'firewall-args');
    const resolvFile = join(dir, 'resolv.conf');
    if (pin !== undefined) writeFileSync(pinFile, pin);
    writeFileSync(resolvFile, resolv);
    const env = { PATH: `${dir}:${process.env.PATH}`, FIREWALL_ARGS: pinFile, RESOLV_CONF: resolvFile };
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
    return {
      status: result.status,
      stdout: result.stdout,
      calls,
      pin: existsSync(pinFile) ? readFileSync(pinFile, 'utf8') : undefined,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const hostNetworkRules = [
  'iptables -A INPUT -s 172.17.0.0/24 -j ACCEPT',
  'iptables -A OUTPUT -d 172.17.0.0/24 -j ACCEPT',
];
const flushRules = [
  'iptables -F',
  'iptables -X',
  'iptables -t nat -F',
  'iptables -t nat -X',
  'iptables -t mangle -F',
  'iptables -t mangle -X',
];
const referenceDnsAndSshRules = [
  'iptables -A OUTPUT -p udp --dport 53 -j ACCEPT',
  'iptables -A INPUT -p udp --sport 53 -j ACCEPT',
  'iptables -A OUTPUT -p tcp --dport 22 -j ACCEPT',
  'iptables -A INPUT -p tcp --sport 22 -m state --state ESTABLISHED -j ACCEPT',
];
const resolverDnsRules = resolvers.flatMap((ns) => [
  `iptables -A OUTPUT -p udp --dport 53 -d ${ns} -j ACCEPT`,
  `iptables -A OUTPUT -p tcp --dport 53 -d ${ns} -j ACCEPT`,
]);
const loopbackRules = ['iptables -A INPUT -i lo -j ACCEPT', 'iptables -A OUTPUT -o lo -j ACCEPT'];
const dropAndEstablishedRules = [
  'iptables -P INPUT DROP',
  'iptables -P FORWARD DROP',
  'iptables -P OUTPUT DROP',
  'iptables -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT',
  'iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT',
];
const iptablesRules = (calls: string[]) => calls.filter((call) => call.startsWith('iptables '));
const ruleCalls = (calls: string[]) => calls.filter((call) => /^(iptables|ipset|ip6tables) /.test(call));

test('the firewall rejects an unknown mode before any network tool runs or a pin is written', () => {
  for (const args of [[], [''], ['on'], ['WEB'], ['off'], ['bogus', 'a.example.com']]) {
    const result = runFirewall(args);
    assert.equal(result.status, 1, `args: ${JSON.stringify(args)}`);
    assert.match(result.stdout, /ERROR: firewall mode '\w*' is not web or strict/);
    assert.deepEqual(result.calls, [], `args: ${JSON.stringify(args)} called a network tool`);
    assert.equal(result.pin, undefined);
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
  assert.deepEqual(ruleCalls(unresolved.calls), []);
});

test('strict mode needs an IPv4 nameserver and checks for one before it flushes a rule', () => {
  for (const resolv of ['', '# only a comment\nnameserver 2001:db8::1\nnameserver not-an-address\n']) {
    const result = runFirewall(['strict'], {}, { resolv });
    assert.equal(result.status, 1, resolv);
    assert.match(result.stdout, /ERROR: no IPv4 nameserver in \S+/);
    assert.deepEqual(ruleCalls(result.calls), [], 'no rule changed');
    assert.ok(!result.calls.some((call) => call.startsWith('iptables-save')), 'nothing reached the flush');
  }
});

test('web mode accepts the host network, then rejects each private range, then drops, then accepts the public internet', () => {
  const { status, stdout, calls } = runFirewall(['web'], {}, { resolv: '' });
  assert.equal(status, 0, stdout);
  assert.deepEqual(iptablesRules(calls), [
    ...flushRules,
    ...referenceDnsAndSshRules,
    ...loopbackRules,
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

test('strict mode binds DNS to the resolvers, allows no blanket SSH, then builds the allowlist and rejects the rest', () => {
  const { status, stdout, calls } = runFirewall(['strict']);
  assert.equal(status, 0, stdout);
  assert.deepEqual(iptablesRules(calls), [
    ...flushRules,
    ...resolverDnsRules,
    ...loopbackRules,
    ...hostNetworkRules,
    ...dropAndEstablishedRules,
    'iptables -A OUTPUT -m set --match-set allowed-domains dst -j ACCEPT',
    'iptables -A OUTPUT -j REJECT --reject-with icmp-admin-prohibited',
  ]);
  assert.ok(!calls.some((call) => call.includes('--dport 22') || call.includes('--sport 22')), 'no port-22 accept');
  assert.ok(
    !iptablesRules(calls).some((call) => call.includes('--dport 53') && !call.includes(' -d ')),
    'every DNS accept names a resolver',
  );

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
    'registry.npmjs.org',
    'api.anthropic.com',
    'claude.ai',
    'claude.com',
    'platform.claude.com',
    'api.openai.com',
    'chatgpt.com',
    'auth.openai.com',
    'bedrock-runtime.us-east-2.amazonaws.com',
  ]) {
    assert.ok(resolved.includes(host), host);
  }
  assert.deepEqual(
    resolved.filter((host) => /^sts\.|visualstudio\.com$|vscode\.blob/.test(host)),
    [],
    'no STS host and no VS Code host',
  );
  assert.match(stdout, /Firewall verification passed - unable to reach https:\/\/example\.com as expected/);
});

test('the first run pins the arguments, an identical run proceeds, and any other run exits before it touches a rule', () => {
  const first = runFirewall(['strict', 'a.example.com']);
  assert.equal(first.status, 0, first.stdout);
  assert.equal(first.pin, 'strict\na.example.com\n');

  const again = runFirewall(['strict', 'a.example.com'], {}, { pin: first.pin });
  assert.equal(again.status, 0, again.stdout);
  assert.ok(iptablesRules(again.calls).length > 0, 'identical arguments refresh the rules');

  for (const args of [['web'], ['strict'], ['strict', 'b.example.com'], ['strict', 'a.example.com,b.example.com']]) {
    const different = runFirewall(args, {}, { pin: first.pin });
    assert.equal(different.status, 1, `args: ${JSON.stringify(args)}`);
    assert.match(different.stdout, /ERROR: firewall arguments differ from the ones this container was created with/);
    assert.deepEqual(different.calls, [], `args: ${JSON.stringify(args)} called a network tool`);
    assert.equal(different.pin, first.pin);
  }

  const web = runFirewall(['web'], {}, { pin: 'web\n' });
  assert.equal(web.status, 0, web.stdout);
  assert.equal(runFirewall(['strict'], {}, { pin: web.pin }).status, 1, 'a web container cannot become strict');
});

test('the mounts are the launcher exchange directory, read-only, so the sandbox holds one session credential and a filtered npmrc', () => {
  const mounts: string[] = devcontainer.mounts;
  for (const [source, target] of [
    ['in/aws', '.aws'],
    ['in/npmrc', '.npmrc'],
  ]) {
    assert.ok(
      mounts.includes(`source=\${localEnv:NOPHI_EXCHANGE}/${source},target=/home/node/${target},type=bind,readonly`),
      target,
    );
  }
  assert.ok(!mounts.some((mount) => mount.includes('localEnv:HOME')), 'nothing mounts from the host home');
  assert.equal(devcontainer.initializeCommand, undefined, 'nothing runs on the host at start');
});

test('the workspace is the clone in the exchange directory, and the bundles cross by two mounts', () => {
  const mounts: string[] = devcontainer.mounts;
  assert.equal(
    devcontainer.workspaceMount,
    'source=${localEnv:NOPHI_EXCHANGE}/workspace,target=/workspace,type=bind,consistency=delegated',
  );
  assert.equal(devcontainer.workspaceFolder, '/workspace');
  assert.ok(mounts.includes('source=${localEnv:NOPHI_EXCHANGE}/in,target=/nophi/in,type=bind,readonly'));
  assert.ok(mounts.includes('source=${localEnv:NOPHI_EXCHANGE}/out,target=/nophi/out,type=bind'));
  assert.ok(!JSON.stringify(devcontainer).includes('localWorkspaceFolder}/'), 'the host working tree is not mounted');
});

// sync.sh runs in the container as an unprivileged user; here it runs on temp directories.
const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const syncScript = fileURLToPath(new URL('.devcontainer/sync.sh', root));

const withSync = (check: (sync: (...args: string[]) => SpawnSyncReturns<string>, dirs: SyncDirs) => void) => {
  const dir = mkdtempSync(join(tmpdir(), 'sync-'));
  try {
    const dirs = { dir, workspace: join(dir, 'workspace'), in: join(dir, 'in'), out: join(dir, 'out') };
    for (const path of [dirs.workspace, dirs.in, dirs.out]) mkdirSync(path);
    const sync = (...args: string[]) =>
      spawnSync('bash', [syncScript, ...args], {
        encoding: 'utf8',
        env: { ...gitEnv, WORKSPACE: dirs.workspace, NOPHI_IN: dirs.in, NOPHI_OUT: dirs.out },
      });
    check(sync, dirs);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
type SyncDirs = { dir: string; workspace: string; in: string; out: string };

// A host repo on `main` with a commit, bundled the way bin/nophi does.
const hostBundle = ({ dir, in: inDir }: SyncDirs, { detach = false } = {}) => {
  const host = join(dir, 'host');
  if (!existsSync(host)) {
    mkdirSync(host);
    git(host, 'init', '-q', '-b', 'main');
  }
  git(host, 'commit', '-q', '--allow-empty', '-m', 'host work');
  if (detach) git(host, 'checkout', '-q', '--detach');
  git(host, 'bundle', 'create', '-q', join(inDir, 'host.bundle'), '--branches', '--tags', 'HEAD');
  return host;
};

test('sync.sh in builds the clone on the host branch, tracking host/<branch>', () => {
  withSync((sync, dirs) => {
    const host = hostBundle(dirs);
    git(host, 'tag', 'v1');
    hostBundle(dirs);
    const result = sync('in', 'main');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(git(dirs.workspace, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
    assert.equal(git(dirs.workspace, 'rev-parse', '--abbrev-ref', '@{u}'), 'host/main');
    assert.equal(git(dirs.workspace, 'rev-parse', 'HEAD'), git(host, 'rev-parse', 'main'));
    assert.equal(git(dirs.workspace, 'remote', 'get-url', 'host'), join(dirs.in, 'host.bundle'));
    assert.equal(git(dirs.workspace, 'rev-parse', 'v1'), git(host, 'rev-parse', 'v1'));
  });
});

test('a second sync.sh in moves host/<branch> and leaves the checkout and local work alone', () => {
  withSync((sync, dirs) => {
    const host = hostBundle(dirs);
    assert.equal(sync('in', 'main').status, 0);
    git(dirs.workspace, 'commit', '-q', '--allow-empty', '-m', 'sandbox work');
    const mine = git(dirs.workspace, 'rev-parse', 'HEAD');
    hostBundle(dirs);
    const result = sync('in', 'main');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /the host moved: main$/m);
    assert.equal(git(dirs.workspace, 'rev-parse', 'HEAD'), mine);
    assert.equal(git(dirs.workspace, 'rev-parse', 'host/main'), git(host, 'rev-parse', 'main'));
    assert.equal(sync('in', 'main').stdout, '', 'an unchanged host prints nothing');
  });
});

test('sync.sh in with a commit id checks it out detached, from the explicitly fetched HEAD', () => {
  withSync((sync, dirs) => {
    const host = hostBundle(dirs, { detach: true });
    const sha = git(host, 'rev-parse', 'HEAD');
    const result = sync('in', sha);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(git(dirs.workspace, 'rev-parse', 'HEAD'), sha);
    assert.equal(git(dirs.workspace, 'rev-parse', 'refs/remotes/host/HEAD'), sha);
    assert.equal(spawnSync('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: dirs.workspace, env: gitEnv }).status, 1);
  });
});

test('sync.sh out writes a bundle git accepts, listing HEAD, and writes nothing from an empty clone', () => {
  withSync((sync, dirs) => {
    const empty = sync('out');
    assert.equal(empty.status, 0);
    assert.match(empty.stderr, /nothing in .* to send back/);
    assert.equal(existsSync(join(dirs.out, 'sandbox.bundle')), false);
    assert.equal(existsSync(join(dirs.out, 'sandbox.bundle.tmp')), false);

    hostBundle(dirs);
    assert.equal(sync('in', 'main').status, 0);
    git(dirs.workspace, 'commit', '-q', '--allow-empty', '-m', 'sandbox work');
    git(dirs.workspace, 'checkout', '-q', '--detach');
    git(dirs.workspace, 'commit', '-q', '--allow-empty', '-m', 'detached work');
    const result = sync('out');
    assert.equal(result.status, 0, result.stderr);
    const bundle = join(dirs.out, 'sandbox.bundle');
    git(dirs.workspace, 'bundle', 'verify', bundle);
    const heads = git(dirs.workspace, 'bundle', 'list-heads', bundle);
    assert.ok(heads.includes(`${git(dirs.workspace, 'rev-parse', 'HEAD')} HEAD`));
    assert.ok(heads.includes('refs/heads/main'));
    assert.equal(existsSync(`${bundle}.tmp`), false);
  });
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
