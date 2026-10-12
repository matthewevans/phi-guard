// Codex fails open when a hook is killed at its timeout, so each Codex entrypoint
// enforces its own, shorter deadline and fails closed itself.
export const HOOK_DEADLINE_MS = 15_000;

export async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(Object.assign(new Error('hook deadline exceeded'), { name: 'HookDeadlineExceeded' })),
      ms,
    );
    timer.unref();
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/** Exits once `text` is flushed. An explicit exit also drops a stdin or socket the deadline left open. */
export function exitAfterWrite(stream: NodeJS.WriteStream, text: string | undefined, code: number): void {
  stream.write(text ?? '', () => process.exit(code));
}
