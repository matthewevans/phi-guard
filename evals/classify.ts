// Turns what a shipped hook printed into an outcome. The wording parsed here is produced
// by src/hooks, and test/evals.test.ts pins it against the real cores.

export const UNRECOGNIZED_OUTPUT = 'UnrecognizedHookOutput';

export type BashOutcome =
  | { kind: 'unchanged' }
  | { kind: 'masked'; text: string; types: string[] }
  /** The guardrail replaced the output with its BlockedOutputsMessaging. */
  | { kind: 'withheld' }
  | { kind: 'error'; name: string };

export type PromptOutcome =
  | { kind: 'passed' }
  | { kind: 'blocked'; types: string[] }
  | { kind: 'error'; name: string };

const unrecognized = { kind: 'error', name: UNRECOGNIZED_OUTPUT } as const;

const SCAN_FAILED = /^\[phi-guard: output withheld, scan failed \((\w+)\)\]$/;
const MASKED = /phi-guard masked (.+) in this output\./;
const BLOCKED = /^phi-guard blocked this prompt: possible (.+)\. Remove it and resubmit\.$/;
const COULD_NOT_SCAN = /^phi-guard could not scan this prompt \((\w+)\), so it was blocked\.$/;

// The hooks print "sensitive data" when the guardrail intervened without naming a type.
const typesIn = (listed: string) => (listed === 'sensitive data' ? [] : listed.split(', '));

interface BashHookOutput {
  hookSpecificOutput?: { updatedToolOutput?: { stdout?: unknown }; additionalContext?: unknown };
}

function parse<T>(stdout: string): T | undefined {
  try {
    return JSON.parse(stdout);
  } catch {
    return undefined;
  }
}

export function classifyBash(stdout: string, blockedOutputsMessaging: string): BashOutcome {
  if (stdout === '') return { kind: 'unchanged' };
  const output = parse<BashHookOutput>(stdout)?.hookSpecificOutput;
  const text = output?.updatedToolOutput?.stdout;
  if (typeof text !== 'string') return unrecognized;

  const failed = SCAN_FAILED.exec(text);
  if (failed) return { kind: 'error', name: failed[1] };
  if (text === blockedOutputsMessaging) return { kind: 'withheld' };
  const context = output?.additionalContext;
  const masked = typeof context === 'string' ? MASKED.exec(context) : null;
  return masked ? { kind: 'masked', text, types: typesIn(masked[1]) } : unrecognized;
}

export function classifyPrompt(stdout: string): PromptOutcome {
  if (stdout === '') return { kind: 'passed' };
  const reason = parse<{ reason?: unknown }>(stdout)?.reason;
  if (typeof reason !== 'string') return unrecognized;

  const blocked = BLOCKED.exec(reason);
  if (blocked) return { kind: 'blocked', types: typesIn(blocked[1]) };
  const failed = COULD_NOT_SCAN.exec(reason);
  return failed ? { kind: 'error', name: failed[1] } : unrecognized;
}
