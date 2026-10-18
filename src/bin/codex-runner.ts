// Runs a Codex shell command with its output captured in a file instead of on stdout,
// because output printed here reaches the model before PostToolUse can scan it. Offline
// by design: it runs inside Codex's command sandbox, so it reads no config and never
// imports the AWS SDK. Usage: codex-runner <capture path> <base64 command>
import { spawn } from 'node:child_process';
import { closeSync, constants, openSync, writeSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import { failureName, namedError, withheldNotice } from '../errors.ts';
import { exitAfterWrite } from '../hook-io.ts';

const MARKER = '[phi-guard: output captured for scanning]\n';
const [capturePath, encoded] = process.argv.slice(2);

let fd: number | undefined;
try {
  if (!capturePath || !encoded) throw namedError('InvalidArguments', 'missing arguments');
  // Exclusive and no-follow: never write through a path another process planted.
  fd = openSync(capturePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);

  // Own session: no controlling tty, so the command can't write around the capture to /dev/tty.
  const child = spawn(process.env.SHELL || '/bin/sh', ['-c', Buffer.from(encoded, 'base64').toString('utf8')], {
    detached: true,
    stdio: ['pipe', fd, fd],
  });
  const stdin = child.stdin!;
  stdin.on('error', () => {});
  process.stdin.pipe(stdin);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => {
      try {
        process.kill(-child.pid!, signal);
      } catch {
        // The group already exited.
      }
    });
  }

  const code = await new Promise<number>((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (exitCode, signal) => resolve(signal ? 128 + osConstants.signals[signal] : (exitCode ?? 1)));
  });
  // Leading newline: the command's output may not end with one.
  writeSync(fd, `\n[exit code ${code}]\n`);
  closeSync(fd);
  exitAfterWrite(process.stdout, MARKER, code);
} catch (error) {
  const why = fd === undefined ? 'capture dir not writable under the current sandbox' : 'runner failed';
  const line = withheldNotice(`${why} (${failureName(error)})`) + '\n';
  if (fd !== undefined) {
    // PostToolUse reads the capture, so leave the cause there instead of an empty file.
    try {
      writeSync(fd, line);
      closeSync(fd);
    } catch {
      // Best effort: the stdout line below still carries the cause.
    }
  }
  exitAfterWrite(process.stdout, line, 1);
}
