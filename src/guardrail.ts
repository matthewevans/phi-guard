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

// Well under the hook timeouts in hooks/hooks.json, so a slow call lands in
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

export interface GuardrailConfig {
  guardrailId: string;
  guardrailVersion: string;
  region: string;
  profile?: string;
}

/** Reads `${prefix}GUARDRAIL_ID`, `_GUARDRAIL_VERSION`, `_AWS_REGION` and optional `_AWS_PROFILE`. */
export function readConfig(prefix: string, env: NodeJS.ProcessEnv = process.env): GuardrailConfig {
  const required = ['GUARDRAIL_ID', 'GUARDRAIL_VERSION', 'AWS_REGION'].map((name) => `${prefix}${name}`);
  const missing = required.filter((name) => !env[name]);
  if (missing.length > 0) {
    // Variable names only, never values.
    throw Object.assign(new Error(`${missing.join(', ')} must be set`), { name: 'MissingGuardrailConfig' });
  }
  const [guardrailId, guardrailVersion, region] = required.map((name) => env[name]!);
  return { guardrailId, guardrailVersion, region, profile: env[`${prefix}AWS_PROFILE`] || undefined };
}

export function createClient({ region, profile }: Pick<GuardrailConfig, 'region' | 'profile'>): BedrockRuntimeClient {
  // AWS_ENDPOINT_URL* and shared-config endpoint_url could otherwise redirect scans to a fake "NONE" answer.
  return new BedrockRuntimeClient({ region, ignoreConfiguredEndpointUrls: true, ...(profile && { profile }) });
}

export function scannerFromConfig(prefix: string): Scan {
  const { guardrailId, guardrailVersion, region, profile } = readConfig(prefix);
  const client = createClient({ region, profile });
  return createScanner(
    (input, abortSignal) => client.send(new ApplyGuardrailCommand(input), { abortSignal }),
    guardrailId,
    guardrailVersion,
  );
}

/** Error name only: messages can quote the input, and hook output may reach the model. */
export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}
