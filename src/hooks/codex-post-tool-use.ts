// Codex PostToolUse hook (matcher: ^Bash$). Codex's `tool_response` is a plain string and
// `updatedToolOutput` is ignored, so output is replaced with `decision: "block"`, whose
// reason becomes the tool result. A wrapped command's `tool_response` holds only the
// runner's marker, so its capture file is read, deleted and scanned; every failure
// replaces the result with a withheld notice.
import { closeSync, constants, fstatSync, openSync, readSync, rmSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { describeFindings, failureName, namedError, withheldNotice } from '../errors.ts';
import type { Scan } from '../guardrail.ts';
import { commandOf, parseWrapped, verifyCaptureDir, type CodexPaths } from './codex-command.ts';
import type { BlockDecision } from './prompt.ts';

// Bytes shown to the model per command: the first and last halves of the capture,
// leaving room for the omitted-bytes line inside the budget.
const BUDGET_BYTES = 20_000;
const HALF = (BUDGET_BYTES - 100) / 2;

export function withheld(why: string): BlockDecision {
  return { decision: 'block', reason: withheldNotice(why) };
}

function readAt(fd: number, position: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const read = readSync(fd, buffer, filled, length - filled, position + filled);
    if (read === 0) break;
    filled += read;
  }
  return buffer.subarray(0, filled);
}

// Cutting by byte offset can split a multi-byte character. The head's StringDecoder holds
// back a trailing partial one, but would turn a leading one into U+FFFD, so the tail drops it.
function dropPartialHead(buffer: Buffer): Buffer {
  let start = 0;
  while (start < Math.min(3, buffer.length) && (buffer[start] & 0xc0) === 0x80) start++;
  return buffer.subarray(start);
}

/** Reads the capture, then deletes it so abandoned output never lingers. Throws on anything unsafe. */
function takeCapture(capturePath: string, { captureDir, uid }: CodexPaths): string {
  verifyCaptureDir(captureDir, uid);
  // Non-blocking: opening a FIFO would otherwise wait forever for a writer; the isFile check rejects it.
  const fd = openSync(capturePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== uid) {
      throw namedError('UnsafeCaptureFile', 'capture file failed verification');
    }

    if (stat.size <= BUDGET_BYTES) return readAt(fd, 0, stat.size).toString('utf8');
    // Never load the whole file: a command can write gigabytes.
    const head = new StringDecoder('utf8').write(readAt(fd, 0, HALF));
    const tail = dropPartialHead(readAt(fd, stat.size - HALF, HALF));
    const omitted = stat.size - Buffer.byteLength(head) - tail.length;
    return `${head}\n[phi-guard: ${omitted} bytes omitted]\n${tail.toString('utf8')}`;
  } finally {
    closeSync(fd);
    rmSync(capturePath, { force: true });
  }
}

function captureWithheld(error: unknown): BlockDecision {
  const name = failureName(error);
  if (name === 'ENOENT') {
    return withheld(
      'no capture file was written (ENOENT); the Codex sandbox must allow writes to /tmp (workspace-write or danger-full-access)',
    );
  }
  return withheld(`capture file unreadable (${name})`);
}

export async function maskCodexOutput(
  input: unknown,
  scan: Scan,
  paths: CodexPaths,
): Promise<BlockDecision | undefined> {
  const command = commandOf(input);
  const { tool_response } = input as { tool_response?: unknown };

  const capturePath = parseWrapped(paths, command);
  let text: string;
  if (capturePath === undefined) {
    // Not wrapped, so PreToolUse failed open and this is the command's real output.
    if (typeof tool_response !== 'string') {
      throw namedError('InvalidHookInput', 'tool_response is not a string');
    }
    if (tool_response === '') return undefined;
    text = tool_response;
  } else {
    try {
      text = takeCapture(capturePath, paths);
    } catch (error) {
      return captureWithheld(error);
    }
  }

  const result = await scan(text, 'OUTPUT');
  if (!result.intervened) {
    // The wrapped result is only the marker, so clean output must still replace it.
    return capturePath === undefined ? undefined : { decision: 'block', reason: result.text };
  }
  return {
    decision: 'block',
    reason: `${result.text}\n\n[phi-guard masked ${describeFindings(result.findings)} in this output.]`,
  };
}
