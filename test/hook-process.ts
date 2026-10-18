// Spawns a bundled hook entrypoint (dist/*.mjs, the shipped artifact) the way Claude Code
// and Codex do, with a clean slate of configuration.
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';

export const dist = (script: string) => new URL(`../dist/${script}`, import.meta.url).pathname;

// Stripped so a developer's own AWS or phi-guard setup can't leak into the runs.
const AMBIENT_CONFIG = /^(CLAUDE_PLUGIN_OPTION_|PHI_GUARD_|AWS_)/;
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !AMBIENT_CONFIG.test(name)));

export function spawnHook(
  script: string,
  stdin: string,
  { env = {}, timeout }: { env?: Record<string, string>; timeout?: number } = {},
) {
  return spawnSync(process.execPath, [dist(script)], {
    input: stdin,
    env: { ...cleanEnv, ...env },
    encoding: 'utf8',
    timeout,
  });
}

/** Runs a hook whose stdin never closes, so only its own deadline can end it. */
export async function spawnHangingHook(script: string) {
  const started = Date.now();
  const child = spawn(process.execPath, [dist(script)], { env: cleanEnv, stdio: ['pipe', 'pipe', 'ignore'] });
  let stdout = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  try {
    const [status] = await once(child, 'exit');
    return { status: status as number | null, stdout, ms: Date.now() - started };
  } finally {
    child.kill('SIGKILL');
  }
}
