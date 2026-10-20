// Reads the files a Claude Code prompt @-mentions. Claude Code attaches their contents to
// the prompt without a tool call, so no PostToolUse hook sees them; the prompt hook scans
// them instead. A mention that names no file (a directory, a handle, a missing path) is
// skipped. A file that cannot be scanned throws, so the prompt is blocked.
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { namedError } from './errors.ts';
import type { Attachment } from './hooks/prompt.ts';

// `@path`, `@"path with spaces"`, after the start or whitespace, so an email address is not one.
const MENTION = /(?:^|\s)@(?:"([^"]+)"|(\S+))/g;
// The guardrail's sensitive-information quota is 1,000 text units, about 1,000,000 characters.
const MAX_BYTES = 1_000_000;

// A line range (`#L10-20`) is not part of the path, and trailing punctuation may not be either.
const withoutRange = (path: string) => path.replace(/#L\d+(?:-\d+)?$/, '');
const candidates = (raw: string) => [withoutRange(raw), withoutRange(raw.replace(/[.,;:!?)\]}'"]+$/, ''))];

const resolveFrom = (cwd: string, path: string) =>
  path === '~' || path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : resolve(cwd, path);

export function readMentions(prompt: string, cwd: string): Attachment[] {
  const seen = new Set<string>();
  const attachments: Attachment[] = [];
  for (const match of prompt.matchAll(MENTION)) {
    for (const mention of candidates(match[1] ?? match[2])) {
      const path = resolveFrom(cwd, mention);
      const stat = statSync(path, { throwIfNoEntry: false });
      if (!stat) continue;
      if (stat.isFile() && !seen.has(path)) {
        seen.add(path);
        if (stat.size > MAX_BYTES) throw namedError('AttachmentTooLarge', 'an @-mentioned file is over the scan limit');
        const contents = readFileSync(path);
        if (contents.includes(0)) throw namedError('UnscannableAttachment', 'an @-mentioned file is not text');
        if (contents.length > 0) attachments.push({ mention, text: contents.toString('utf8') });
      }
      break;
    }
  }
  return attachments;
}
