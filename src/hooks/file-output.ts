// PostToolUse hook (matcher: Read|Grep): masks what the guardrail flags in file contents
// before the model sees them. Same contract as bash-output.ts: the tool already ran, so
// every failure path must replace the output itself. Grep's file names (files_with_matches
// mode) are not scanned.
import { describeFindings, namedError, withheldNotice } from '../errors.ts';
import type { Scan } from '../guardrail.ts';
import { replaceOutput, type PostToolUseOutput } from './bash-output.ts';

// The shapes Claude Code 2.1.296 sends (observed), with the fields phi-guard rewrites.
export interface ReadResponse {
  type: string;
  file: { filePath: string; content: string; [field: string]: unknown };
}
export interface GrepResponse {
  mode: string;
  content?: string;
  [field: string]: unknown;
}
export type FileTool = 'Read' | 'Grep';
type FileResponse = ReadResponse | GrepResponse;

const replaceContent = (tool: FileTool, response: FileResponse, content: string): FileResponse =>
  tool === 'Read'
    ? { ...(response as ReadResponse), file: { ...(response as ReadResponse).file, content } }
    : { ...(response as GrepResponse), content };

export function withheld(tool: FileTool, response: FileResponse, why: string): PostToolUseOutput<FileResponse> {
  const notice = withheldNotice(why);
  if (tool === 'Grep') return replaceOutput({ ...response, content: notice });
  // A text-shaped replacement, whatever the original type: an image or notebook keeps no
  // field the model could still read.
  const filePath = (response as Partial<ReadResponse> | undefined)?.file?.filePath ?? '';
  return replaceOutput({ type: 'text', file: { filePath, content: notice, numLines: 1, startLine: 1, totalLines: 1 } });
}

function contentOf(tool: FileTool, response: FileResponse): string | undefined {
  if (tool === 'Read') {
    const { file } = response as ReadResponse;
    if (typeof file?.content !== 'string')
      throw namedError('InvalidHookInput', 'Read tool_response has no file.content string');
    return file.content;
  }
  const { content } = response as GrepResponse;
  if (content !== undefined && typeof content !== 'string') {
    throw namedError('InvalidHookInput', 'Grep tool_response content is not a string');
  }
  return content;
}

export async function maskFileOutput(
  tool: string,
  response: FileResponse,
  scan: Scan,
): Promise<PostToolUseOutput<FileResponse> | undefined> {
  if (tool !== 'Read' && tool !== 'Grep') throw namedError('InvalidHookInput', 'unexpected tool_name');
  // Images, notebooks and PDFs come back in other shapes the guardrail cannot read.
  const { type } = response as ReadResponse;
  if (tool === 'Read' && type !== 'text') return withheld(tool, response, `${String(type)} content cannot be scanned`);
  const content = contentOf(tool, response);
  if (!content) return undefined;

  const result = await scan(content, 'OUTPUT');
  if (!result.intervened) return undefined;
  return replaceOutput(
    replaceContent(tool, response, result.text),
    `phi-guard masked ${describeFindings(result.findings)} in this output.`,
  );
}
