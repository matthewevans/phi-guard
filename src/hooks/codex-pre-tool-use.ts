// Codex PreToolUse hook (matcher: ^Bash$): rewrites every shell command to run through
// the buffering runner, so its output reaches the model only via PostToolUse. Codex
// fails open on every hook failure except exit 2, so callers turn any throw into exit 2.
import { ensureCaptureDir, parseWrapped, wrapCommand, type CodexPaths } from './codex-command.ts';

export interface PreToolUseOutput {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'allow';
    updatedInput: { command: string };
  };
}

export function rewriteCommand(input: unknown, paths: CodexPaths): PreToolUseOutput | undefined {
  const command = (input as { tool_input?: { command?: unknown } } | null)?.tool_input?.command;
  if (typeof command !== 'string' || command === '') {
    throw Object.assign(new Error('missing tool_input.command'), { name: 'InvalidHookInput' });
  }
  if (parseWrapped(paths, command) !== undefined) return undefined;

  ensureCaptureDir(paths.captureDir, paths.uid);
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput: { command: wrapCommand(paths, command) },
    },
  };
}
