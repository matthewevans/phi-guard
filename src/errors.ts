// Error names and user-visible notices shared by the hooks. Imports nothing, so the
// SDK-free runner bundle can use it. evals/classify.ts parses these strings.

export const namedError = (name: string, message: string): Error => Object.assign(new Error(message), { name });

/** Errno code or error name only: messages can carry paths or quote the input, and hook output may reach the model. */
export function failureName(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^E[A-Z0-9_]+$/.test(code)) return code;
  return error instanceof Error ? error.name : 'UnknownError';
}

export const withheldNotice = (why: string) => `[phi-guard: output withheld, ${why}]`;

export const describeFindings = (findings: readonly string[]) => findings.join(', ') || 'sensitive data';
