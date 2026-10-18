// bin/nophi runs against PATH stubs for docker and devcontainer that log their argv, in a
// throwaway git repo. The live path (real Docker, real devcontainer CLI) is checked by hand.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const nophi = fileURLToPath(new URL('../bin/nophi', import.meta.url));
const payload = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const config = join(payload, '.devcontainer/devcontainer.json');
const HEALTH_SCRIPT = 'printf %s "$1" | node /opt/phi-guard/dist/codex-prompt.mjs';
const HEALTH_INPUT = '{"prompt":"nophi health check"}';

// Each stub appends "name [arg] [arg]" to $STUB_LOG, so an empty argument is visible.
// The STUB_* variables steer the answers: STUB_DOCKER_DOWN fails `docker info`, STUB_IDS is
// what `docker ps` prints, STUB_UP_STATUS is the exit of `devcontainer up`, STUB_HEALTH_OUT and
// STUB_HEALTH_STATUS answer the health check (the exec that runs sh), STUB_AGENT_STATUS the
// other execs.
const LOG_ARGV = '{ printf %s "${0##*/}"; for a in "$@"; do printf " [%s]" "$a"; done; echo; } >> "$STUB_LOG"\n';
const STUBS = {
  docker:
    `#!/bin/sh\n${LOG_ARGV}` +
    'case "$1" in\n' +
    '  info) [ -z "$STUB_DOCKER_DOWN" ] || exit 1 ;;\n' +
    '  ps) [ -z "$STUB_IDS" ] || printf "%s\\n" $STUB_IDS ;;\n' +
    '  rm) exit "${STUB_RM_STATUS:-0}" ;;\n' +
    'esac\n',
  devcontainer:
    `#!/bin/sh\n${LOG_ARGV}` +
    'if [ "$1" = up ]; then exit "${STUB_UP_STATUS:-0}"; fi\n' +
    'for a in "$@"; do\n' +
    '  if [ "$a" = sh ]; then printf %s "$STUB_HEALTH_OUT"; exit "${STUB_HEALTH_STATUS:-0}"; fi\n' +
    'done\n' +
    'exit "${STUB_AGENT_STATUS:-0}"\n',
};

type Launch = { status: number | null; stdout: string; stderr: string; calls: string[]; repo: string };

// Runs nophi in a fresh git repo that `setup` may fill, and returns the stubs' call log.
// `cwd` is relative to the repo root.
const launch = (
  args: string[],
  { env = {}, setup, cwd = '.', repo = true, link = false }: {
    env?: Record<string, string>;
    setup?: (repo: string) => void;
    cwd?: string;
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
    const work = join(dir, 'repo');
    mkdirSync(work);
    if (repo) execFileSync('git', ['init', '-q'], { cwd: work });
    setup?.(work);
    const log = join(dir, 'calls');
    writeFileSync(log, '');
    // A Homebrew install runs nophi through a symlink into libexec.
    const entry = link ? join(dir, 'nophi') : nophi;
    if (link) symlinkSync(nophi, entry);
    const result = spawnSync(entry, args, {
      cwd: join(work, cwd),
      encoding: 'utf8',
      env: { PATH: `${stubs}:${process.env.PATH}`, STUB_LOG: log, ...env },
    });
    const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean);
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls, repo: work };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const write = (repo: string, path: string, content = 'x\n') => {
  mkdirSync(join(repo, path, '..'), { recursive: true });
  writeFileSync(join(repo, path), content);
};

const dc = (repo: string) => `[--workspace-folder] [${repo}] [--config] [${config}]`;
const callsOf = (name: string, result: Launch) => result.calls.filter((call) => call.startsWith(name));

test('untracked and ignored data files stop the launch before any devcontainer call', () => {
  const result = launch(['claude'], {
    setup: (repo) => {
      write(repo, '.gitignore', 'dump.sql\n');
      write(repo, 'export.csv');
      write(repo, 'dump.sql');
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /export\.csv/);
  assert.match(result.stderr, /dump\.sql/);
  assert.match(result.stderr, /--i-checked-no-phi/);
  assert.deepEqual(callsOf('devcontainer', result), []);
});

test('the data-file stop looks from the repo root and ignores the case of the extension', () => {
  const result = launch(['claude'], {
    cwd: 'src',
    setup: (repo) => {
      mkdirSync(join(repo, 'src'));
      write(repo, 'data/Members.CSV');
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /data\/Members\.CSV/);
  assert.deepEqual(callsOf('devcontainer', result), []);
});

test('the data-file stop lists ten paths and counts the rest', () => {
  const result = launch(['claude'], {
    setup: (repo) => {
      for (let i = 0; i < 12; i++) write(repo, `export${i}.csv`);
    },
  });
  assert.equal(result.status, 1);
  assert.equal(result.stderr.match(/^ {2}export\d+\.csv$/gm)?.length, 10);
  assert.match(result.stderr, /12 files in all/);
});

test('a tracked data file does not stop the launch', () => {
  const result = launch(['claude'], {
    setup: (repo) => {
      write(repo, 'fixtures.csv');
      execFileSync('git', ['add', 'fixtures.csv'], { cwd: repo });
    },
  });
  assert.equal(result.status, 0, result.stderr);
});

test('--i-checked-no-phi skips the data-file stop', () => {
  const result = launch(['--i-checked-no-phi', 'claude'], { setup: (repo) => write(repo, 'export.csv') });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(callsOf('devcontainer', result).length, 3);
});

test('claude runs up, the health check and the agent in order, passing its args through', () => {
  const result = launch(['claude', '--model', 'sonnet', '-p', 'hi there']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, [
    'docker [info]',
    `devcontainer [up] ${dc(result.repo)}`,
    `devcontainer [exec] ${dc(result.repo)} [sh] [-c] [${HEALTH_SCRIPT}] [_] [${HEALTH_INPUT}]`,
    `devcontainer [exec] ${dc(result.repo)} [--remote-env] [CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1] [claude] ` +
      '[--model] [sonnet] [-p] [hi there]',
  ]);
});

test('--rebuild recreates the container', () => {
  const result = launch(['--rebuild', 'codex']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.calls[1], `devcontainer [up] ${dc(result.repo)} [--remove-existing-container]`);
  assert.match(result.calls[3], /\[codex\]$/);
});

test('the payload path is normalised when nophi runs through a symlink', () => {
  const result = launch(['shell'], { link: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.calls[1], `devcontainer [up] ${dc(result.repo)}`);
});

test('a health check that reports a block exits 1 with the reason and the good-morning hint, and runs no agent', () => {
  const reason = 'phi-guard could not scan this prompt (CredentialsProviderError), so it was blocked.';
  const result = launch(['claude'], {
    env: { STUB_HEALTH_OUT: JSON.stringify({ decision: 'block', reason }) },
  });
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes(reason));
  assert.match(result.stderr, /good-morning/);
  assert.equal(callsOf('devcontainer', result).length, 2);
});

test('a health check that exits non-zero with no output also fails', () => {
  const result = launch(['codex'], { env: { STUB_HEALTH_STATUS: '3' } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /exit status 3/);
  assert.match(result.stderr, /good-morning/);
  assert.equal(callsOf('devcontainer', result).length, 2);
});

test('shell and codex login skip the health check', () => {
  const shell = launch(['shell']);
  assert.equal(shell.status, 0, shell.stderr);
  assert.equal(shell.calls.at(-1), `devcontainer [exec] ${dc(shell.repo)} [--remote-env] [CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1] [zsh]`);
  assert.equal(shell.calls.length, 3);

  const login = launch(['codex', 'login', '--device-auth'], { env: { STUB_HEALTH_STATUS: '3' } });
  assert.equal(login.status, 0, login.stderr);
  assert.equal(login.calls.length, 3);
  assert.match(login.calls.at(-1) ?? '', /\[codex\] \[login\] \[--device-auth\]$/);
});

test('the agent exit status propagates', () => {
  const result = launch(['claude'], { env: { STUB_AGENT_STATUS: '7' } });
  assert.equal(result.status, 7);
});

test('a failed start removes the container the CLI left behind', () => {
  const result = launch(['claude'], { env: { STUB_UP_STATUS: '1', STUB_IDS: 'abc123' } });
  assert.equal(result.status, 1);
  assert.equal(callsOf('devcontainer', result).length, 1);
  assert.deepEqual(result.calls.slice(-2), [
    `docker [ps] [-aq] [--filter] [label=devcontainer.local_folder=${result.repo}] [--filter] ` +
      `[label=devcontainer.config_file=${config}]`,
    'docker [rm] [-f] [abc123]',
  ]);
});

test('down removes the labelled containers and starts nothing', () => {
  const result = launch(['down'], { env: { STUB_IDS: 'abc123 def456' } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /removed 2 sandbox container/);
  assert.deepEqual(result.calls, [
    'docker [info]',
    `docker [ps] [-aq] [--filter] [label=devcontainer.local_folder=${result.repo}] [--filter] ` +
      `[label=devcontainer.config_file=${config}]`,
    'docker [rm] [-f] [abc123] [def456]',
  ]);
});

test('down exits non-zero when docker rm fails', () => {
  const result = launch(['down'], { env: { STUB_IDS: 'abc123', STUB_RM_STATUS: '1' } });
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stdout, /removed/);
});

test('down with nothing running removes nothing', () => {
  const result = launch(['down'], { setup: (repo) => write(repo, 'export.csv') });
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
  assert.deepEqual(help.calls, []);
  for (const args of [[], ['bogus'], ['--bogus', 'claude']]) {
    const result = launch(args);
    assert.equal(result.status, 2, `args: ${JSON.stringify(args)}`);
    assert.match(result.stderr, /^Usage: nophi /);
  }
});
