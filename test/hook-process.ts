// Spawns a bundled hook entrypoint (dist/*.mjs, the shipped artifact) the way Claude Code
// does, with a clean slate of configuration.
import { spawnSync } from 'node:child_process';

// Stripped so a developer's own AWS or phi-guard setup can't leak into the runs.
const AMBIENT_CONFIG = /^(CLAUDE_PLUGIN_OPTION_|PHI_GUARD_|AWS_)/;

export function spawnHook(script: string, stdin: string, extraEnv: Record<string, string> = {}) {
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !AMBIENT_CONFIG.test(name))),
    ...extraEnv,
  };
  return spawnSync('node', [new URL(`../dist/${script}`, import.meta.url).pathname], {
    input: stdin,
    env,
    encoding: 'utf8',
  });
}
