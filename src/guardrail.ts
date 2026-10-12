import {
  ApplyGuardrailCommand,
  BedrockRuntimeClient,
  type ApplyGuardrailCommandInput,
  type ApplyGuardrailCommandOutput,
  type GuardrailContentSource,
} from '@aws-sdk/client-bedrock-runtime';

export type ApplyGuardrail = (
  input: ApplyGuardrailCommandInput,
  abortSignal: AbortSignal,
) => Promise<ApplyGuardrailCommandOutput>;

export interface ScanResult {
  intervened: boolean;
  /** The guardrail's masked text when it intervened, otherwise the original text. */
  text: string;
  /** Detected PII entity types and regex names. Never the matched values. */
  findings: string[];
}

export type Scan = (text: string, source: GuardrailContentSource) => Promise<ScanResult>;

// Well under the hook timeouts in settings.example.json, so a slow call lands in
// the hook's own fail-closed path instead of being killed by Claude Code.
const SCAN_TIMEOUT_MS = 10_000;

export function createScanner(
  apply: ApplyGuardrail,
  guardrailIdentifier: string,
  guardrailVersion: string,
): Scan {
  return async (text, source) => {
    const response = await apply(
      { guardrailIdentifier, guardrailVersion, source, content: [{ text: { text } }] },
      AbortSignal.timeout(SCAN_TIMEOUT_MS),
    );
    if (response.action !== 'GUARDRAIL_INTERVENED') {
      return { intervened: false, text, findings: [] };
    }

    const policies = (response.assessments ?? []).flatMap((a) => a.sensitiveInformationPolicy ?? []);
    const findings = new Set([
      ...policies.flatMap((p) => p.piiEntities ?? []).filter((e) => e.action !== 'NONE').map((e) => e.type),
      ...policies.flatMap((p) => p.regexes ?? []).filter((r) => r.action !== 'NONE').map((r) => r.name),
    ]);
    return {
      intervened: true,
      text: (response.outputs ?? []).map((o) => o.text ?? '').join(''),
      findings: [...findings].filter((f) => f !== undefined),
    };
  };
}

export function scannerFromEnv(): Scan {
  const { PHI_GUARD_GUARDRAIL_ID: id, PHI_GUARD_GUARDRAIL_VERSION: version } = process.env;
  if (!id || !version) {
    throw Object.assign(new Error('PHI_GUARD_GUARDRAIL_ID and PHI_GUARD_GUARDRAIL_VERSION must be set'), {
      name: 'MissingGuardrailConfig',
    });
  }
  const client = new BedrockRuntimeClient({});
  return createScanner(
    (input, abortSignal) => client.send(new ApplyGuardrailCommand(input), { abortSignal }),
    id,
    version,
  );
}

/** Error name only: messages can quote the input, and hook output may reach the model. */
export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}
