// What the Codex PreToolUse and PostToolUse hooks agree on: the runner command line
// PreToolUse emits, the capture directory it points into, and the failure names
// both report. Must not import the AWS SDK: the runner bundle shares this module.
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface CodexPaths {
  execPath: string;
  runnerPath: string;
  /** `<realpath /tmp>/phi-guard-<uid>`: writable in Codex's workspace-write and danger-full-access sandboxes. */
  captureDir: string;
  uid: number;
}

/** Paths for the entrypoint bundle at `moduleUrl`; the runner is its sibling in dist/. */
export function currentPaths(moduleUrl: string): CodexPaths {
  const uid = process.getuid!();
  return {
    execPath: process.execPath,
    runnerPath: fileURLToPath(new URL('./codex-runner.mjs', moduleUrl)),
    captureDir: `${realpathSync('/tmp')}/phi-guard-${uid}`,
    uid,
  };
}

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const BASE64 = '(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?';

export function wrapCommand({ execPath, runnerPath, captureDir }: CodexPaths, command: string, id: string = randomUUID()) {
  const capturePath = `${captureDir}/${id}.out`;
  const encoded = Buffer.from(command, 'utf8').toString('base64');
  return `${quote(execPath)} ${quote(runnerPath)} ${quote(capturePath)} ${encoded}`;
}

/**
 * The capture path when `command` is exactly the line `wrapCommand` emits, else undefined.
 * A full-string match: a command that merely mentions the runner must still be wrapped.
 */
export function parseWrapped({ execPath, runnerPath, captureDir }: CodexPaths, command: string): string | undefined {
  const form = new RegExp(
    `^${escapeRegExp(quote(execPath))} ${escapeRegExp(quote(runnerPath))} ` +
      `'(${escapeRegExp(quote(captureDir).slice(1, -1))}/${UUID}\\.out)' ${BASE64}$`,
  );
  const quotedPath = form.exec(command)?.[1];
  return quotedPath?.replaceAll("'\\''", "'");
}

/** A real directory owned by `uid` with no group or other access: the capture files hold raw output. */
export function verifyCaptureDir(dir: string, uid: number): void {
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o077) !== 0) {
    throw Object.assign(new Error('capture dir failed verification'), { name: 'UnsafeCaptureDir' });
  }
}

export function ensureCaptureDir(dir: string, uid: number): void {
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (error) {
    if (failureName(error) !== 'EEXIST') throw error;
  }
  verifyCaptureDir(dir, uid);
}

/** Errno code or error name only: messages can carry paths or quote the input. */
export function failureName(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^E[A-Z0-9_]+$/.test(code)) return code;
  return error instanceof Error ? error.name : 'UnknownError';
}
