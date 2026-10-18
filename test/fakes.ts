// Scanner fakes shared by the unit tests: no AWS, no network.
import type { Scan } from '../src/guardrail.ts';

export const clean: Scan = async (text) => ({ intervened: false, text, findings: [] });

/** Masks every occurrence of `secret` as {NAME}. */
export const masking =
  (secret: string): Scan =>
  async (text) =>
    text.includes(secret)
      ? { intervened: true, text: text.replaceAll(secret, '{NAME}'), findings: ['NAME'] }
      : { intervened: false, text, findings: [] };

/** A clean scanner that also records every text it was asked to scan. */
export function recording() {
  const seen: string[] = [];
  const scan: Scan = async (text, source) => {
    seen.push(text);
    return clean(text, source);
  };
  return { scan, seen };
}
