// Runs the shipped hook bundles the way Claude Code does: the command, args and timeout
// come from hooks/hooks.json, stdin carries the event JSON and the process reads its
// configuration from the environment.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

type HookEvent = 'UserPromptSubmit' | 'PostToolUse';

interface HooksFile {
  hooks: Record<HookEvent, { matcher?: string; hooks: { command: string; args: string[]; timeout: number }[] }[]>;
}

export interface HookSpec {
  command: string;
  args: string[];
  timeoutMs: number;
}

/** The entry for `event` whose matcher is `matcher` (none for UserPromptSubmit). */
export function hookSpec(event: HookEvent, matcher?: string): HookSpec {
  const file: HooksFile = JSON.parse(readFileSync(join(root, 'hooks/hooks.json'), 'utf8'));
  const entry = file.hooks[event].find((candidate) => candidate.matcher === matcher);
  if (!entry) throw new Error(`hooks/hooks.json has no ${event} entry with matcher ${matcher}`);
  const { command, args, timeout } = entry.hooks[0];
  return {
    command,
    args: args.map((arg) => arg.replaceAll('${CLAUDE_PLUGIN_ROOT}', root)),
    timeoutMs: timeout * 1000,
  };
}

export interface HookRun {
  stdout: string;
  ms: number;
  /** Set when the process was killed at its timeout or exited nonzero. */
  failure?: 'HookTimeout' | 'HookCrashed';
}

export function runHook(
  { command, args, timeoutMs }: HookSpec,
  stdin: string,
  env: NodeJS.ProcessEnv,
): Promise<HookRun> {
  return new Promise((resolveRun, reject) => {
    const started = performance.now();
    const child = spawn(command, args, {
      env,
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
    });
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.once('error', reject);
    child.once('close', (code, signal) =>
      resolveRun({
        stdout,
        ms: performance.now() - started,
        failure: signal ? 'HookTimeout' : code === 0 ? undefined : 'HookCrashed',
      }),
    );
    // A hook that exits before reading all of stdin breaks the pipe; 'close' reports the exit.
    child.stdin.on('error', () => undefined);
    child.stdin.end(stdin);
  });
}
