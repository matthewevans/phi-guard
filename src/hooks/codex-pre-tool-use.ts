// Codex PreToolUse hook (matcher: ^Bash$): rewrites every shell command to run through
// the buffering runner, so its output reaches the model only via PostToolUse. Codex
// fails open on every hook failure except exit 2, so callers turn any throw into exit 2.
import { namedError } from '../errors.ts';
import { commandOf, ensureCaptureDir, parseWrapped, wrapCommand, type CodexPaths } from './codex-command.ts';

export interface PreToolUseOutput {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'allow';
    updatedInput: { command: string };
  };
}

export function rewriteCommand(input: unknown, paths: CodexPaths): PreToolUseOutput | undefined {
  const command = commandOf(input);
  // The runner rejects an empty command, so wrapping one would only fail later.
  if (command === '') throw namedError('InvalidHookInput', 'empty tool_input.command');
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
