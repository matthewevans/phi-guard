// bin/nophi runs against PATH stubs for docker, devcontainer and aws that log their argv, in a
// throwaway git repo, with HOME and XDG_CACHE_HOME in a temp directory and fake credentials only.
// Git is real: the bundles nophi writes and reads are checked with it. The live path (real Docker,
// real devcontainer CLI) is checked by hand.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const nophi = fileURLToPath(new URL('../bin/nophi', import.meta.url));
const payload = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const config = join(payload, '.devcontainer/devcontainer.json');
const health = (agent: string) => `[bash] [/opt/phi-guard/health-check.sh] [${agent}]`;
const syncIn = (ref: string) => `[bash] [/opt/phi-guard/sync.sh] [in] [${ref}]`;
const syncOut = '[bash] [/opt/phi-guard/sync.sh] [out]';

const ACCESS_KEY = 'AKIAIOSFODNN7EXAMPLE';
const SECRET_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const SESSION_TOKEN = 'FAKESESSIONTOKEN/EXAMPLE+TOKEN==';
const CODEARTIFACT = 'fake-123456789012.d.codeartifact.us-east-1.amazonaws.com';

// Each stub appends "name [arg] [arg]" to $STUB_LOG, so an empty argument is visible.
// The STUB_* variables steer the answers: STUB_DOCKER_DOWN fails `docker info`; STUB_IDS is what
// `docker ps` prints for the nophi id labels; STUB_LEGACY (lines of "id<TAB>config path") is what it
// prints for the default devcontainer.local_folder label when --format comes without --quiet, and
// with both flags the stub prints ids only, as Docker 29 does; STUB_RM_STATUS is the exit of
// `docker rm`; STUB_UP_STATUS is the exit of `devcontainer up`, which also snapshots the exchange
// directory it was given; STUB_HEALTH_OUT and STUB_HEALTH_STATUS answer the health check (the exec
// that runs bash; the real script prints the block reason or nothing), STUB_AGENT_STATUS the other
// execs; STUB_SYNC_STATUS and STUB_SYNC_OUT_STATUS are the exits of the two sync.sh execs. A sync.sh out
// exec writes out/sandbox.bundle from the first of these files that sits next to the log: src.bundle
// (copied), src.link (holds the target of a symlink) or src.text (copied as is). STUB_AWS_STATUS is the exit of `aws`, and STUB_AWS_STATIC makes it print long-lived keys.
const LOG_ARGV = '{ printf %s "${0##*/}"; for a in "$@"; do printf " [%s]" "$a"; done; echo; } >> "$STUB_LOG"\n';
const STUBS = {
  docker:
    `#!/bin/sh\n${LOG_ARGV}` +
    [
      'case "$1" in',
      '  info) [ -z "$STUB_DOCKER_DOWN" ] || exit 1 ;;',
      '  ps)',
      '    shift',
      '    format=; quiet=; labelled=',
      '    for a in "$@"; do',
      '      case "$a" in',
      '        --format) format=1 ;;',
      '        -q | -aq | -qa | --quiet) quiet=1 ;;',
      '        label=nophi.schema=3) labelled=1 ;;',
      '      esac',
      '    done',
      '    if [ -n "$labelled" ]; then',
      '      [ -z "$STUB_IDS" ] || printf "%s\\n" $STUB_IDS',
      '    elif [ -n "$format" ] && [ -n "$quiet" ]; then',
      '      printf "%s\\n" "$STUB_LEGACY" | cut -f1',
      '    elif [ -n "$format" ]; then',
      '      printf "%s\\n" "$STUB_LEGACY"',
      '    fi ;;',
      '  rm) exit "${STUB_RM_STATUS:-0}" ;;',
      'esac',
      '',
    ].join('\n'),
  devcontainer:
    `#!/bin/sh\n${LOG_ARGV}` +
    [
      'if [ "$1" = up ]; then',
      '  printf %s "$NOPHI_EXCHANGE" > "$STUB_LOG.exchange"',
      '  cp "$NOPHI_EXCHANGE/in/aws/credentials" "$STUB_LOG.credentials" 2>/dev/null',
      '  cp "$NOPHI_EXCHANGE/in/npmrc" "$STUB_LOG.npmrc" 2>/dev/null',
      '  [ ! -f "$NOPHI_EXCHANGE/in/host.bundle" ] || : > "$STUB_LOG.hostbundle"',
      '  exit "${STUB_UP_STATUS:-0}"',
      'fi',
      'for a in "$@"; do',
      '  case "$a" in',
      '    /opt/phi-guard/health-check.sh) printf %s "$STUB_HEALTH_OUT"; exit "${STUB_HEALTH_STATUS:-0}" ;;',
      '    /opt/phi-guard/sync.sh) sync=1 ;;',
      '    in) [ -z "$sync" ] || exit "${STUB_SYNC_STATUS:-0}" ;;',
      '    out)',
      '      [ -n "$sync" ] || continue',
      '      src=$(dirname "$STUB_LOG")',
      '      target=$NOPHI_EXCHANGE/out/sandbox.bundle',
      '      rm -f "$target"',
      '      if [ -f "$src/src.bundle" ]; then cp "$src/src.bundle" "$target"',
      '      elif [ -f "$src/src.link" ]; then ln -s "$(cat "$src/src.link")" "$target"',
      '      elif [ -f "$src/src.text" ]; then cp "$src/src.text" "$target"',
      '      fi',
      '      exit "${STUB_SYNC_OUT_STATUS:-0}" ;;',
      '  esac',
      'done',
      'exit "${STUB_AGENT_STATUS:-0}"',
      '',
    ].join('\n'),
  aws:
    `#!/bin/sh\n${LOG_ARGV}` +
    [
      'if [ "${STUB_AWS_STATUS:-0}" != 0 ]; then echo "aws: the SSO session has expired" >&2; exit "$STUB_AWS_STATUS"; fi',
      `if [ -n "$STUB_AWS_STATIC" ]; then printf '{"Version":1,"AccessKeyId":"${ACCESS_KEY}","SecretAccessKey":"${SECRET_KEY}"}'; exit 0; fi`,
      `printf '{"Version":1,"AccessKeyId":"${ACCESS_KEY}","SecretAccessKey":"${SECRET_KEY}",` +
        `"SessionToken":"${SESSION_TOKEN}","Expiration":"2030-01-01T00:00:00+00:00"}'`,
      '',
    ].join('\n'),
};

const CREDENTIALS = `[default]\naws_access_key_id = ${ACCESS_KEY}\naws_secret_access_key = ${SECRET_KEY}\naws_session_token = ${SESSION_TOKEN}\n`;

// The git environment of the test's own commands: no user or system config, a fixed identity.
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
const commit = (repo: string, message = 'work') => git(repo, 'commit', '-q', '--allow-empty', '-m', message);
const refsIn = (repo: string) => git(repo, 'for-each-ref', '--format=%(refname)').split('\n').filter(Boolean);
const headsIn = (bundle: string) => git(tmpdir(), 'bundle', 'list-heads', bundle);

type Paths = {
  dir: string;
  home: string;
  exchange: string;
  // The directory nophi runs in and treats as the repo root; the repo `setup` receives is always <dir>/repo.
  repo: string;
};
type Launch = Paths & {
  status: number | null;
  stdout: string;
  stderr: string;
  calls: string[];
  // What `devcontainer up` saw: the NOPHI_EXCHANGE it was given, copies of the two mounted files, and
  // whether in/host.bundle already existed.
  atUp: { exchange?: string; credentials?: string; npmrc?: string; hostBundle: boolean };
};

const readIfPresent = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : undefined);
const modeOf = (path: string) => statSync(path).mode & 0o777;

// Runs nophi in a fresh git repo with one commit on `main` that `setup` may fill, and returns the stubs'
// call log. `at` names the directory under the temp dir that nophi runs in (a worktree test points it
// elsewhere), `cwd` is relative to it, `npmrc` becomes the fake host ~/.npmrc, `then` runs between a
// first launch and a second one (the result is the second), and `inspect` runs before the temp
// directory goes away.
const launch = (
  args: string[],
  {
    env = {},
    setup,
    then,
    inspect,
    npmrc,
    cwd = '.',
    at = 'repo',
    commits = true,
    repo = true,
    link = false,
  }: {
    env?: Record<string, string>;
    setup?: (repo: string, paths: Paths) => void;
    then?: (paths: Paths) => void;
    inspect?: (paths: Paths) => void;
    npmrc?: string;
    cwd?: string;
    at?: string;
    commits?: boolean;
    repo?: boolean;
    link?: boolean;
  } = {},
): Launch => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nophi-')));
  try {
    const stubs = join(dir, 'stubs');
    mkdirSync(stubs);
    for (const [name, body] of Object.entries(STUBS)) {
      writeFileSync(join(stubs, name), body);
      chmodSync(join(stubs, name), 0o755);
    }
    const home = join(dir, 'home');
    mkdirSync(home);
    if (npmrc !== undefined) writeFileSync(join(home, '.npmrc'), npmrc);
    const work = join(dir, 'repo');
    mkdirSync(work);
    if (repo) git(work, 'init', '-q', '-b', 'main');
    if (repo && commits) commit(work, 'first');
    const root = join(dir, at);
    const hash = createHash('sha1').update(root).digest('hex').slice(0, 8);
    const paths = { dir, home, repo: root, exchange: join(dir, 'cache', 'nophi', `${at}-${hash}`) };
    setup?.(work, paths);
    const log = join(dir, 'calls');
    // A Homebrew install runs nophi through a symlink into libexec.
    const entry = link ? join(dir, 'nophi') : nophi;
    if (link) symlinkSync(nophi, entry);
    const run = () => {
      writeFileSync(log, '');
      return spawnSync(entry, args, {
        cwd: join(root, cwd),
        encoding: 'utf8',
        env: {
          PATH: `${stubs}:${process.env.PATH}`,
          HOME: home,
          XDG_CACHE_HOME: join(dir, 'cache'),
          GIT_CONFIG_SYSTEM: '/dev/null',
          STUB_LOG: log,
          ...env,
        },
      });
    };
    let result = run();
    if (then) {
      then(paths);
      result = run();
    }
    const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean);
    inspect?.(paths);
    return {
      ...paths,
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      calls,
      atUp: {
        exchange: readIfPresent(`${log}.exchange`),
        credentials: readIfPresent(`${log}.credentials`),
        npmrc: readIfPresent(`${log}.npmrc`),
        hostBundle: existsSync(`${log}.hostbundle`),
      },
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const write = (repo: string, path: string, content = 'x\n') => {
  mkdirSync(join(repo, path, '..'), { recursive: true });
  writeFileSync(join(repo, path), content);
};

const dc = (repo: string) =>
  `[--workspace-folder] [${repo}] [--config] [${config}] [--id-label] [nophi.schema=3] [--id-label] [nophi.repo=${repo}]`;
const legacyPs = (repo: string) =>
  `docker [ps] [-a] [--filter] [label=devcontainer.local_folder=${repo}] [--format] [{{.ID}}\\t{{.Label "devcontainer.config_file"}}]`;
const idPs = (repo: string) =>
  `docker [ps] [-aq] [--filter] [label=nophi.schema=3] [--filter] [label=nophi.repo=${repo}]`;
const mint = (profile = 'phi-guard') =>
  `aws [configure] [export-credentials] [--profile] [${profile}] [--format] [process]`;
const callsOf = (name: string, result: Launch) => result.calls.filter((call) => call.startsWith(name));

// Seeds the exchange directory, as an earlier launch would have left it.
const seed = ({ exchange }: Paths, files: Record<string, string>) => {
  for (const [path, content] of Object.entries(files)) write(exchange, path, content);
};

const homebrewConfig = '/opt/homebrew/Cellar/nophi/0.1.0/libexec/.devcontainer/devcontainer.json';
const legacy = (...rows: [string, string][]) => rows.map(([id, path]) => `${id}\t${path}`).join('\n');

test('untracked data files no longer stop a launch, and --i-checked-no-phi is gone', () => {
  const result = launch(['claude'], { setup: (repo) => write(repo, 'export.csv') });
  assert.equal(result.status, 0, result.stderr);
  const flag = launch(['--i-checked-no-phi', 'claude']);
  assert.equal(flag.status, 2);
  assert.doesNotMatch(flag.stderr, /i-checked-no-phi/);
});

test('claude removes legacy containers, mints credentials, then runs up, the health check and the agent, passing its args through', () => {
  const result = launch(['claude', '--model', 'sonnet', '-p', 'hi there']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, [
    'docker [info]',
    legacyPs(result.repo),
    mint(),
    `devcontainer [up] ${dc(result.repo)}`,
    `devcontainer [exec] ${dc(result.repo)} ${health('claude')}`,
    `devcontainer [exec] ${dc(result.repo)} ${syncIn('main')}`,
    `devcontainer [exec] ${dc(result.repo)} [--remote-env] [CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1] [claude] ` +
      '[--model] [sonnet] [-p] [hi there]',
    `devcontainer [exec] ${dc(result.repo)} ${syncOut}`,
  ]);
});

test('--rebuild recreates the container', () => {
  const result = launch(['--rebuild', 'codex']);
  assert.equal(result.status, 0, result.stderr);
  const [up, check, , agent] = callsOf('devcontainer', result);
  assert.equal(up, `devcontainer [up] ${dc(result.repo)} [--remove-existing-container]`);
  assert.equal(check, `devcontainer [exec] ${dc(result.repo)} ${health('codex')}`);
  assert.match(agent, /\[codex\]$/);
});

test('the payload path is normalised when nophi runs through a symlink', () => {
  const result = launch(['shell'], { link: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(callsOf('devcontainer', result)[0], `devcontainer [up] ${dc(result.repo)}`);
});

test('a health check that reports a block exits 1 with the reason and the ApplyGuardrail hint, and runs no agent', () => {
  const reason = 'phi-guard could not scan this prompt (CredentialsProviderError), so it was blocked.';
  const result = launch(['claude'], {
    env: { STUB_HEALTH_OUT: reason },
  });
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes(reason));
  assert.match(result.stderr, /bedrock:ApplyGuardrail on the guardrail/);
  assert.equal(callsOf('devcontainer', result).length, 2);
});

test('a health check that exits non-zero with no output also fails', () => {
  const result = launch(['codex'], { env: { STUB_HEALTH_STATUS: '3' } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /exit status 3/);
  assert.match(result.stderr, /bedrock:ApplyGuardrail on the guardrail/);
  assert.equal(callsOf('devcontainer', result).length, 2);
});

test('shell and codex login skip the health check and still sync in and out', () => {
  const shell = launch(['shell']);
  assert.equal(shell.status, 0, shell.stderr);
  assert.deepEqual(callsOf('devcontainer', shell).slice(1), [
    `devcontainer [exec] ${dc(shell.repo)} ${syncIn('main')}`,
    `devcontainer [exec] ${dc(shell.repo)} [--remote-env] [CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1] [zsh]`,
    `devcontainer [exec] ${dc(shell.repo)} ${syncOut}`,
  ]);

  const login = launch(['codex', 'login', '--device-auth'], { env: { STUB_HEALTH_STATUS: '3' } });
  assert.equal(login.status, 0, login.stderr);
  assert.equal(callsOf('devcontainer', login).length, 4);
  assert.match(login.calls.at(-2) ?? '', /\[codex\] \[login\] \[--device-auth\]$/);
  assert.equal(login.calls.at(-1), `devcontainer [exec] ${dc(login.repo)} ${syncOut}`);
});

test('the agent exit status propagates after the sync out, and a failing sync out never changes it', () => {
  const result = launch(['claude'], { env: { STUB_AGENT_STATUS: '7' } });
  assert.equal(result.status, 7);
  assert.equal(result.calls.at(-1), `devcontainer [exec] ${dc(result.repo)} ${syncOut}`);

  const broken = launch(['claude'], { env: { STUB_AGENT_STATUS: '7', STUB_SYNC_OUT_STATUS: '1' } });
  assert.equal(broken.status, 7);
  assert.match(broken.stderr, /sandbox commits were not copied back/);
  assert.equal(launch(['shell'], { env: { STUB_SYNC_OUT_STATUS: '1' } }).status, 0);
});

test('a failed sync in stops the launch before the agent', () => {
  const result = launch(['claude'], { env: { STUB_SYNC_STATUS: '1' } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /could not copy the repo into the sandbox/);
  assert.equal(callsOf('devcontainer', result).length, 3);
});

test('a failed start removes the container the CLI left behind, found through the nophi id labels', () => {
  const result = launch(['claude'], { env: { STUB_UP_STATUS: '1', STUB_IDS: 'abc123' } });
  assert.equal(result.status, 1);
  assert.equal(callsOf('devcontainer', result).length, 1);
  assert.deepEqual(result.calls.slice(-2), [idPs(result.repo), 'docker [rm] [-f] [abc123]']);
});

test('down removes the labelled containers and their credentials, and starts nothing', () => {
  const result = launch(['down'], {
    env: { STUB_IDS: 'abc123 def456' },
    setup: (_repo, paths) => seed(paths, { 'in/aws/credentials': CREDENTIALS, 'in/npmrc': 'x\n' }),
    inspect: ({ exchange }) => {
      assert.equal(existsSync(join(exchange, 'in/aws/credentials')), false);
      assert.equal(readFileSync(join(exchange, 'in/npmrc'), 'utf8'), 'x\n');
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /removed 2 sandbox container/);
  assert.deepEqual(result.calls, [
    'docker [info]',
    legacyPs(result.repo),
    idPs(result.repo),
    'docker [rm] [-f] [abc123] [def456]',
  ]);
});

test('a failed start still reports the log path when removing the left-behind container fails', () => {
  const result = launch(['claude'], { env: { STUB_UP_STATUS: '1', STUB_IDS: 'abc123', STUB_RM_STATUS: '1' } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /could not start the sandbox; full log: /);
});

test('down exits non-zero when docker rm fails, and has already deleted the credentials', () => {
  const result = launch(['down'], {
    env: { STUB_IDS: 'abc123', STUB_RM_STATUS: '1' },
    setup: (_repo, paths) => seed(paths, { 'in/aws/credentials': CREDENTIALS }),
    inspect: ({ exchange }) => assert.equal(existsSync(join(exchange, 'in/aws/credentials')), false),
  });
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stdout, /removed/);
});

test('down with nothing running removes nothing', () => {
  const result = launch(['down']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /removed 0 sandbox container/);
  assert.ok(!result.calls.some((call) => call.includes('[rm]')));
});

test('nophi outside a git repo exits 1', () => {
  const result = launch(['claude'], { repo: false });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /git repo/);
  assert.deepEqual(result.calls, []);
});

test('a stopped Docker exits 1 before any devcontainer call', () => {
  const result = launch(['claude'], { env: { STUB_DOCKER_DOWN: '1' } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Docker is not running/);
  assert.deepEqual(callsOf('devcontainer', result), []);
});

test('--help works anywhere and an unknown subcommand exits 2', () => {
  const help = launch(['--help'], { repo: false });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^Usage: nophi /);
  assert.match(help.stdout, /PHI_GUARD_AWS_PROFILE/);
  assert.deepEqual(help.calls, []);
  for (const args of [[], ['bogus'], ['--bogus', 'claude']]) {
    const result = launch(args);
    assert.equal(result.status, 2, `args: ${JSON.stringify(args)}`);
    assert.match(result.stderr, /^Usage: nophi /);
  }
});

test('the exchange directory sits under XDG_CACHE_HOME, is private, and holds the minted credentials before up', () => {
  const result = launch(['claude'], {
    inspect: ({ exchange }) => {
      for (const dir of ['', 'in', 'in/aws', 'out', 'workspace'])
        assert.equal(modeOf(join(exchange, dir)), 0o700, `mode of ${dir}`);
      assert.equal(modeOf(join(exchange, 'in/aws/credentials')), 0o600);
      assert.equal(readFileSync(join(exchange, 'in/aws/credentials'), 'utf8'), CREDENTIALS);
      assert.deepEqual(readdirSync(join(exchange, 'in/aws')), ['credentials'], 'no temp file is left behind');
      assert.equal(modeOf(join(exchange, 'in/npmrc')), 0o600);
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.atUp.exchange, result.exchange);
  assert.equal(result.atUp.credentials, CREDENTIALS);
});

test('the exchange directory falls back to ~/.cache without XDG_CACHE_HOME', () => {
  const result = launch(['shell'], { env: { XDG_CACHE_HOME: '' } });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.atUp.exchange?.startsWith(join(result.home, '.cache/nophi/repo-')), result.atUp.exchange);
});

test('the credentials come from PHI_GUARD_AWS_PROFILE, and an empty value means phi-guard', () => {
  const work = launch(['claude'], { env: { PHI_GUARD_AWS_PROFILE: 'work' } });
  assert.equal(callsOf('aws', work)[0], mint('work'));
  const empty = launch(['claude'], { env: { PHI_GUARD_AWS_PROFILE: '' } });
  assert.equal(callsOf('aws', empty)[0], mint('phi-guard'));
});

test('no credential value reaches argv, stdout or stderr', () => {
  const envs: Record<string, string>[] = [{}, { STUB_AWS_STATIC: '1' }];
  for (const env of envs) {
    const result = launch(['claude'], { env });
    for (const secret of [SECRET_KEY, SESSION_TOKEN]) {
      assert.ok(!result.calls.some((call) => call.includes(secret)), 'argv');
      assert.ok(!result.stdout.includes(secret), 'stdout');
      assert.ok(!result.stderr.includes(secret), 'stderr');
    }
  }
});

test('a failed export stops claude and codex before up, with the good-morning hint and no credentials file', () => {
  for (const agent of ['claude', 'codex']) {
    const result = launch([agent], {
      env: { STUB_AWS_STATUS: '1', PHI_GUARD_AWS_PROFILE: 'work' },
      inspect: ({ exchange }) => assert.deepEqual(readdirSync(join(exchange, 'in/aws')), []),
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /could not get credentials for AWS profile work; run good-morning/);
    assert.match(result.stderr, /the SSO session has expired/);
    assert.deepEqual(callsOf('devcontainer', result), []);
  }
});

test('a long-lived static key export is refused', () => {
  const result = launch(['claude'], {
    env: { STUB_AWS_STATIC: '1' },
    inspect: ({ exchange }) => assert.deepEqual(readdirSync(join(exchange, 'in/aws')), []),
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /static keys, which are not accepted/);
  assert.deepEqual(callsOf('devcontainer', result), []);
});

test('a failed export only warns for shell and codex login, and the launch continues', () => {
  for (const args of [['shell'], ['codex', 'login', '--device-auth']]) {
    const result = launch(args, { env: { STUB_AWS_STATUS: '1' } });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /warning: could not get credentials for AWS profile phi-guard/);
    assert.equal(callsOf('devcontainer', result).length, 4);
  }
});

test('a failed export leaves an earlier credentials file in place', () => {
  const result = launch(['shell'], {
    env: { STUB_AWS_STATUS: '1' },
    setup: (_repo, paths) => seed(paths, { 'in/aws/credentials': 'earlier\n' }),
    inspect: ({ exchange }) => assert.equal(readFileSync(join(exchange, 'in/aws/credentials'), 'utf8'), 'earlier\n'),
  });
  assert.equal(result.status, 0, result.stderr);
});

test('the npmrc keeps only the CodeArtifact registry lines and those hosts tokens, and never prints a token', () => {
  const kept = [
    `registry=https://${CODEARTIFACT}/npm/repo/`,
    `@acme:registry="https://${CODEARTIFACT}/npm/other/"`,
    `//${CODEARTIFACT}/npm/repo/:_authToken=fake-codeartifact-token`,
  ];
  const npmrc = [
    kept[0],
    '@evil:registry=https://npm.example.com/',
    kept[1],
    '//npm.pkg.github.com/:_authToken=fake-github-token',
    kept[2],
    'always-auth=true',
    '//npm.example.com/:_authToken=fake-other-token',
    '',
  ].join('\n');
  const result = launch(['shell'], { npmrc });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.atUp.npmrc, `${kept.join('\n')}\n`);
  assert.ok(!result.stdout.includes('fake-') && !result.stderr.includes('fake-'));
});

test('a missing host npmrc gives an empty file, and an existing one is rewritten in place', () => {
  const missing = launch(['shell']);
  assert.equal(missing.atUp.npmrc, '');

  let inode = 0;
  const reused = launch(['shell'], {
    npmrc: `registry=https://${CODEARTIFACT}/npm/repo/\n`,
    setup: (_repo, paths) => {
      seed(paths, { 'in/npmrc': 'stale\n' });
      inode = statSync(join(paths.exchange, 'in/npmrc')).ino;
    },
    inspect: ({ exchange }) => assert.equal(statSync(join(exchange, 'in/npmrc')).ino, inode),
  });
  assert.equal(reused.atUp.npmrc, `registry=https://${CODEARTIFACT}/npm/repo/\n`);
});

test('legacy containers with this payload config or a Homebrew config are removed at launch, and others are left', () => {
  const result = launch(['claude'], {
    env: {
      STUB_LEGACY: legacy(
        ['abc123', config],
        ['def456', homebrewConfig],
        ['ghi789', '/elsewhere/.devcontainer/devcontainer.json'],
      ),
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /removed 2 container\(s\) from an earlier version/);
  const removal = result.calls.indexOf('docker [rm] [-f] [abc123] [def456]');
  assert.ok(removal > 0, 'removes exactly the two matching containers');
  assert.ok(removal < result.calls.findIndex((call) => call.startsWith('devcontainer [up]')), 'before up');
  assert.equal(callsOf('docker [rm]', result).length, 1);
});

test('down removes legacy containers too, and fails when it cannot', () => {
  const env = { STUB_LEGACY: legacy(['abc123', homebrewConfig]) };
  const result = launch(['down'], { env });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.calls.includes('docker [rm] [-f] [abc123]'));
  assert.match(result.stderr, /removed 1 container\(s\) from an earlier version/);

  const failed = launch(['down'], { env: { ...env, STUB_RM_STATUS: '1' } });
  assert.notEqual(failed.status, 0);
  assert.doesNotMatch(failed.stdout, /removed/);
});

test('a failed legacy removal only warns at launch', () => {
  const result = launch(['claude'], { env: { STUB_LEGACY: legacy(['abc123', config]), STUB_RM_STATUS: '1' } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /warning: could not remove containers from an earlier version/);
  assert.equal(callsOf('devcontainer', result).length, 5);
});

// A sandbox bundle the way sync.sh out writes it, built from a repo of its own in <dir>/sandbox.
const sandboxBundle = ({ dir }: Paths, { detached = false, extra = '' } = {}) => {
  const sandbox = join(dir, 'sandbox');
  if (!existsSync(sandbox)) {
    mkdirSync(sandbox);
    git(sandbox, 'init', '-q', '-b', 'main');
    commit(sandbox, 'base');
    git(sandbox, 'checkout', '-q', '-b', 'feature');
    git(sandbox, 'tag', 'evil');
  }
  commit(sandbox, `feature work ${extra}`);
  if (detached) git(sandbox, 'checkout', '-q', '--detach');
  git(sandbox, 'bundle', 'create', '-q', join(dir, 'src.bundle'), '--branches', '--tags', 'HEAD');
};

test('launch bundles the committed content before up: branches, tags and HEAD, and no stash or staged blob', () => {
  let staged = '';
  let stash = '';
  const result = launch(['shell'], {
    setup: (repo) => {
      write(repo, 'tracked.txt', 'tracked\n');
      git(repo, 'add', 'tracked.txt');
      commit(repo, 'second');
      git(repo, 'tag', 'v1');
      git(repo, 'branch', 'side');
      write(repo, 'tracked.txt', 'changed and stashed\n');
      git(repo, 'stash', '-q');
      stash = git(repo, 'rev-parse', 'refs/stash');
      write(repo, 'staged.txt', 'staged then reset\n');
      git(repo, 'add', 'staged.txt');
      staged = git(repo, 'rev-parse', ':staged.txt');
      git(repo, 'reset', '-q');
    },
    inspect: ({ exchange, dir, repo }) => {
      const bundle = join(exchange, 'in/host.bundle');
      git(repo, 'bundle', 'verify', bundle);
      const heads = headsIn(bundle);
      for (const ref of ['refs/heads/main', 'refs/heads/side', 'refs/tags/v1', 'HEAD']) {
        assert.ok(heads.includes(ref), ref);
      }
      git(dir, 'clone', '-q', bundle, join(dir, 'clone'));
      for (const object of [staged, stash]) {
        assert.throws(() => git(join(dir, 'clone'), 'cat-file', '-e', object));
      }
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.atUp.hostBundle, true);
  assert.equal(callsOf('devcontainer', result)[1], `devcontainer [exec] ${dc(result.repo)} ${syncIn('main')}`);
});

test('an empty repo is refused with its own message, before any minting or devcontainer call', () => {
  const result = launch(['claude'], {
    commits: false,
    inspect: ({ exchange }) => assert.equal(existsSync(exchange), false),
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /the repo has no commits yet; commit first/);
  assert.deepEqual(callsOf('devcontainer', result), []);
  assert.deepEqual(callsOf('aws', result), []);
});

test('a detached HEAD records the commit id and the bundle lists HEAD', () => {
  let sha = '';
  const result = launch(['shell'], {
    setup: (repo) => {
      commit(repo, 'second');
      git(repo, 'checkout', '-q', '--detach');
      sha = git(repo, 'rev-parse', 'HEAD');
    },
    inspect: ({ exchange }) => assert.match(headsIn(join(exchange, 'in/host.bundle')), new RegExp(`${sha} HEAD`)),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.calls.includes(`devcontainer [exec] ${dc(result.repo)} ${syncIn(sha)}`));
});

test('a dirty working tree prints one note, and a clean one prints none', () => {
  const dirty = launch(['shell'], { setup: (repo) => write(repo, 'untracked.txt') });
  assert.equal(dirty.stderr.match(/uncommitted changes stay on this machine/g)?.length, 1);
  assert.doesNotMatch(launch(['shell']).stderr, /uncommitted changes/);
});

test('a symlink left at returned.bundle.tmp is removed, and the copy never writes through it', () => {
  const victim = (home: string) => join(home, '.zshrc');
  const result = launch(['shell'], {
    setup: (_repo, paths) => {
      sandboxBundle(paths);
      mkdirSync(paths.exchange, { recursive: true });
      writeFileSync(victim(paths.home), 'original\n');
      symlinkSync(victim(paths.home), join(paths.exchange, 'returned.bundle.tmp'));
    },
    inspect: (paths) => {
      assert.equal(readFileSync(victim(paths.home), 'utf8'), 'original\n');
      const returned = join(paths.exchange, 'returned.bundle');
      assert.ok(lstatSync(returned).isFile());
      assert.match(readFileSync(returned, 'latin1').split('\n')[0], /^# v[23] git bundle$/);
      assert.equal(existsSync(join(paths.exchange, 'returned.bundle.tmp')), false);
    },
  });
  assert.equal(result.status, 0, result.stderr);
});

test('sandbox commits come back through the validated copy and the nophi remote, without sandbox tags', () => {
  const fetchNophi = ({ repo, exchange }: Paths) => {
    git(repo, 'fetch', '-q', 'nophi');
    assert.equal(git(repo, 'remote', 'get-url', 'nophi'), join(exchange, 'returned.bundle'));
    assert.equal(git(repo, 'config', 'remote.nophi.tagOpt'), '--no-tags');
    assert.ok(!refsIn(repo).includes('refs/tags/evil'));
  };
  const first = launch(['shell'], {
    setup: (_repo, paths) => sandboxBundle(paths, { detached: true }),
    inspect: (paths) => {
      fetchNophi(paths);
      assert.ok(refsIn(paths.repo).includes('refs/remotes/nophi/feature'));
      assert.ok(refsIn(paths.repo).includes('refs/remotes/nophi/HEAD'), 'work on a detached checkout returns');
    },
  });
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /sandbox commits are in remote 'nophi' \(git fetch nophi\)/);

  const second = launch(['shell'], {
    setup: (_repo, paths) => sandboxBundle(paths),
    then: (paths) => sandboxBundle(paths, { extra: 'again' }),
    inspect: (paths) => {
      fetchNophi(paths);
      assert.equal(
        git(paths.repo, 'remote')
          .split('\n')
          .filter((name) => name === 'nophi').length,
        1,
      );
      const tip = git(paths.repo, 'rev-parse', 'refs/remotes/nophi/feature');
      assert.equal(git(join(paths.dir, 'sandbox'), 'rev-parse', 'feature'), tip, 'the second run replaced the copy');
    },
  });
  assert.equal(second.status, 0, second.stderr);
});

test('a symlink or a gitdir pointer at out/sandbox.bundle is rejected and the earlier copy stays', () => {
  const variants: [string, (paths: Paths, third: string) => void][] = [
    [
      'symlink to a bundle file',
      ({ dir }, third) => writeFileSync(join(dir, 'src.link'), join(third, '../third.bundle')),
    ],
    ['symlink to a repository', ({ dir }, third) => writeFileSync(join(dir, 'src.link'), join(third, '.git'))],
    [
      'gitdir pointer file',
      ({ dir }, third) => writeFileSync(join(dir, 'src.text'), `gitdir: ${join(third, '.git')}\n`),
    ],
    [
      'v3 bundle with a filter capability',
      ({ dir }, third) => {
        git(third, 'bundle', 'create', '-q', '--version=3', join(dir, 'v3.bundle'), '--all');
        const bundle = readFileSync(join(dir, 'v3.bundle'), 'latin1');
        writeFileSync(
          join(dir, 'src.text'),
          bundle.replace('\n@object-format=sha1\n', '\n@object-format=sha1\n@filter=blob:none\n'),
          'latin1',
        );
      },
    ],
  ];
  for (const [name, plant] of variants) {
    let copy = '';
    const result = launch(['shell'], {
      setup: (_repo, paths) => {
        const third = join(paths.dir, 'third');
        mkdirSync(third);
        git(third, 'init', '-q', '-b', 'stolen');
        commit(third, 'secret history');
        git(third, 'bundle', 'create', '-q', join(paths.dir, 'third.bundle'), '--all');
        sandboxBundle(paths);
      },
      then: (paths) => {
        copy = readFileSync(join(paths.exchange, 'returned.bundle'), 'latin1');
        rmSync(join(paths.dir, 'src.bundle'));
        plant(paths, join(paths.dir, 'third'));
      },
      inspect: (paths) => {
        assert.equal(readFileSync(join(paths.exchange, 'returned.bundle'), 'latin1'), copy, name);
        git(paths.repo, 'fetch', '-q', 'nophi');
        assert.deepEqual(
          refsIn(paths.repo).filter((ref) => ref.includes('stolen')),
          [],
          name,
        );
        assert.doesNotMatch(headsIn(join(paths.exchange, 'in/host.bundle')), /stolen/, name);
        assert.deepEqual(
          readdirSync(join(paths.repo, '.git/objects/pack')).filter((f) => f.endsWith('.promisor')),
          [],
          name,
        );
      },
    });
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
    assert.match(result.stderr, /sandbox commits were not copied back/, name);
    assert.doesNotMatch(result.stdout, /are in remote/, name);
  }
});

test('config planted in the sandbox clone runs nothing on the host, through a launch and a fetch', () => {
  const result = launch(['shell'], {
    setup: (_repo, paths) => {
      const { dir, exchange } = paths;
      const clone = join(exchange, 'workspace');
      mkdirSync(clone, { recursive: true });
      git(clone, 'init', '-q');
      const hooks = join(dir, 'hooks');
      mkdirSync(hooks);
      const plant = (name: string) => {
        const script = join(hooks, name);
        writeFileSync(script, `#!/bin/sh\ntouch ${join(dir, 'marker')}\n`);
        chmodSync(script, 0o755);
        return script;
      };
      for (const hook of ['pre-commit', 'post-checkout', 'post-merge', 'reference-transaction']) plant(hook);
      git(clone, 'config', 'core.hooksPath', hooks);
      git(clone, 'config', 'core.fsmonitor', plant('fsmonitor'));
      git(clone, 'config', 'remote.origin.url', clone);
      git(clone, 'config', 'remote.origin.uploadpack', plant('upload-pack'));
      sandboxBundle(paths);
    },
    inspect: ({ dir, repo }) => {
      git(repo, 'fetch', '-q', 'nophi');
      assert.equal(existsSync(join(dir, 'marker')), false);
    },
  });
  assert.equal(result.status, 0, result.stderr);
});

test('repos with one basename get one exchange directory each, keyed by the root path', () => {
  const first = launch(['shell']);
  const second = launch(['shell']);
  assert.match(first.atUp.exchange ?? '', /\/repo-[0-9a-f]{8}$/);
  assert.match(second.atUp.exchange ?? '', /\/repo-[0-9a-f]{8}$/);
  assert.notEqual(first.atUp.exchange, second.atUp.exchange);
});

test('a git worktree gets its own exchange directory, bundles its branch and syncs that branch in', () => {
  const result = launch(['shell'], {
    at: 'wt',
    setup: (repo, { dir }) => git(repo, 'worktree', 'add', '-q', '-b', 'wtb', join(dir, 'wt')),
    inspect: ({ exchange }) => {
      const heads = headsIn(join(exchange, 'in/host.bundle'));
      assert.ok(heads.includes('refs/heads/wtb') && heads.includes('refs/heads/main') && heads.includes('HEAD'));
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.exchange, /\/wt-[0-9a-f]{8}$/);
  assert.equal(result.atUp.exchange, result.exchange);
  assert.ok(result.calls.includes(`devcontainer [exec] ${dc(result.repo)} ${syncIn('wtb')}`));
});

test('nophi refuses to start from inside the sandbox clone, before any git or stub call', () => {
  const result = launch(['claude'], {
    cwd: '../cache/nophi/repo-clone/workspace',
    setup: (_repo, { dir }) => {
      const clone = join(dir, 'cache/nophi/repo-clone/workspace');
      mkdirSync(clone, { recursive: true });
      git(clone, 'init', '-q');
      commit(clone);
      const monitor = join(dir, 'monitor');
      writeFileSync(monitor, `#!/bin/sh\ntouch ${join(dir, 'marker')}\n`);
      chmodSync(monitor, 0o755);
      git(clone, 'config', 'core.fsmonitor', monitor);
    },
    inspect: ({ dir }) => assert.equal(existsSync(join(dir, 'marker')), false),
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /run nophi from your repo, not from the sandbox clone/);
  assert.deepEqual(result.calls, []);
});
