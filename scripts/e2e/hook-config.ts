// Turns the shipped hook files into the session-level registrations scripts/e2e.sh
// feeds the installed CLIs, so the e2e runs exercise the hook entries exactly as
// shipped (commands, args, matchers, timeouts) rather than a hand-written copy.
//
//   hook-config.ts claude <repo> <events> [--swap <dist file>=<path>]... [--env <NAME>=<value>]...
//   hook-config.ts codex  <repo> <events> [--swap <dist file>=<path>]...
//
// `claude` prints a --settings JSON document registering the events from
// hooks/hooks.json (plus any `--env` pairs as the settings `env` block); `codex` prints one `hooks.<Event>=<TOML inline array>` override
// per line (for `-c`), built from hooks/codex-hooks.json. `<events>` is a comma
// separated list. `--swap` replaces `<repo>/dist/<file>` wherever it appears in a
// command, which is how a test-only canary bundle takes a shipped bundle's place.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

interface HookEntry {
  matcher?: string;
  hooks: Record<string, unknown>[];
}
type HookFile = { hooks: Record<string, HookEntry[]> };

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    swap: { type: 'string', multiple: true, default: [] },
    env: { type: 'string', multiple: true, default: [] },
  },
});
const [agent, repo, eventList] = positionals;
const events = eventList.split(',');
const swaps = values.swap.map((pair) => {
  const [file, replacement] = pair.split('=');
  return [join(repo, 'dist', file), replacement] as const;
});

const placeholder = agent === 'claude' ? '${CLAUDE_PLUGIN_ROOT}' : '${PLUGIN_ROOT}';
const hookFile = agent === 'claude' ? 'hooks.json' : 'codex-hooks.json';
const shipped = JSON.parse(readFileSync(join(repo, 'hooks', hookFile), 'utf8')) as HookFile;

const resolve = (value: unknown): unknown => {
  if (typeof value === 'string') {
    return swaps.reduce((text, [from, to]) => text.replaceAll(from, to), value.replaceAll(placeholder, repo));
  }
  return Array.isArray(value) ? value.map(resolve) : value;
};
const resolveHook = (hook: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(hook).map(([key, value]) => [key, resolve(value)]));

const selected = Object.fromEntries(
  events.map((event) => {
    const entries = shipped.hooks[event];
    if (!entries) throw new Error(`${hookFile} has no ${event} hook`);
    return [event, entries.map((entry) => ({ ...entry, hooks: entry.hooks.map(resolveHook) }))];
  }),
);

// A JSON string is a valid TOML basic string, so JSON.stringify quotes every value.
const toml = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(toml).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .map(([key, item]) => `${key}=${toml(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
};

if (agent === 'claude') {
  const env = Object.fromEntries(values.env.map((pair) => pair.split(/=(.*)/s)));
  console.log(JSON.stringify({ env, hooks: selected }));
} else {
  for (const [event, entries] of Object.entries(selected)) console.log(`hooks.${event}=${toml(entries)}`);
}
