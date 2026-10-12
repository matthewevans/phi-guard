// PostToolUse hook (matcher: Bash): masks what the guardrail flags in command output
// before the model sees it. onFailure "block" can't withhold output on PostToolUse
// (the tool already ran), so every failure path here must replace the output itself.
import type { Scan } from '../guardrail.ts';

export interface BashResponse {
  stdout: string;
  stderr: string;
  interrupted: boolean;
  isImage: boolean;
}

export interface PostToolUseOutput {
  hookSpecificOutput: {
    hookEventName: 'PostToolUse';
    updatedToolOutput: BashResponse;
    additionalContext?: string;
  };
}

function replaceOutput(updatedToolOutput: BashResponse, additionalContext?: string): PostToolUseOutput {
  return { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput, additionalContext } };
}

export function withheld(response: BashResponse, why: string): PostToolUseOutput {
  // Spread keeps any extra fields Bash returns: a shape mismatch makes Claude Code
  // silently fall back to the original, unmasked output.
  return replaceOutput({ ...response, stdout: `[phi-guard: output withheld, ${why}]`, stderr: '', isImage: false });
}

export async function maskBashOutput(response: BashResponse, scan: Scan): Promise<PostToolUseOutput | undefined> {
  if (response.isImage) return withheld(response, 'image output cannot be scanned');

  const [stdout, stderr] = await Promise.all(
    [response.stdout, response.stderr].map((text) => (text ? scan(text, 'OUTPUT') : undefined)),
  );
  if (!stdout?.intervened && !stderr?.intervened) return undefined;

  const findings = new Set([...(stdout?.findings ?? []), ...(stderr?.findings ?? [])]);
  return replaceOutput(
    { ...response, stdout: stdout?.text ?? response.stdout, stderr: stderr?.text ?? response.stderr },
    `phi-guard masked ${[...findings].join(', ') || 'sensitive data'} in this output.`,
  );
}
