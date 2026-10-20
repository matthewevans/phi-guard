// PostToolUse hook (matcher: Bash): masks what the guardrail flags in command output
// before the model sees it. onFailure "block" can't withhold output on PostToolUse
// (the tool already ran), so every failure path here must replace the output itself.
import { describeFindings, namedError, withheldNotice } from '../errors.ts';
import type { Scan } from '../guardrail.ts';

export interface BashResponse {
  stdout: string;
  stderr: string;
  interrupted: boolean;
  isImage: boolean;
}

export interface PostToolUseOutput<Response = BashResponse> {
  hookSpecificOutput: {
    hookEventName: 'PostToolUse';
    updatedToolOutput: Response;
    additionalContext?: string;
  };
}

export function replaceOutput<Response>(
  updatedToolOutput: Response,
  additionalContext?: string,
): PostToolUseOutput<Response> {
  return { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput, additionalContext } };
}

export function withheld(response: BashResponse, why: string): PostToolUseOutput {
  // Spread keeps any extra fields Bash returns: a shape mismatch makes Claude Code
  // silently fall back to the original, unmasked output.
  // The leading defaults give the documented Bash shape even when the response lacks fields.
  return replaceOutput({
    interrupted: false,
    ...(response as Partial<BashResponse>),
    stdout: withheldNotice(why),
    stderr: '',
    isImage: false,
  });
}

export async function maskBashOutput(response: BashResponse, scan: Scan): Promise<PostToolUseOutput | undefined> {
  // A renamed or nested field would otherwise read as empty output and pass unscanned.
  if (typeof response?.stdout !== 'string' || typeof response.stderr !== 'string') {
    throw namedError('InvalidHookInput', 'tool_response has no stdout and stderr strings');
  }
  if (response.isImage) return withheld(response, 'image output cannot be scanned');

  const [stdout, stderr] = await Promise.all(
    [response.stdout, response.stderr].map((text) => (text ? scan(text, 'OUTPUT') : undefined)),
  );
  if (!stdout?.intervened && !stderr?.intervened) return undefined;

  const findings = new Set([...(stdout?.findings ?? []), ...(stderr?.findings ?? [])]);
  return replaceOutput(
    { ...response, stdout: stdout?.text ?? response.stdout, stderr: stderr?.text ?? response.stderr },
    `phi-guard masked ${describeFindings([...findings])} in this output.`,
  );
}
