// The local overlay: cases for formats the public repo must not contain (member IDs,
// claim numbers). Gitignored JSON Lines in evals/local, one Case per line.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { caseProblem, type Case } from './case.ts';

/** Parses JSON Lines into cases. A bad row throws an error naming the source and the row number. */
export function parseCases(jsonl: string, source: string): Case[] {
  return jsonl.split('\n').flatMap((line, index) => {
    if (line.trim() === '') return [];
    const where = `${source} row ${index + 1}`;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      throw new Error(`${where}: not valid JSON`);
    }
    const problem = caseProblem(row);
    if (problem !== undefined) throw new Error(`${where}: ${problem}`);
    return [row as Case];
  });
}

export function readOverlay(directory: string): Case[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((file) => file.endsWith('.jsonl'))
    .sort()
    .flatMap((file) => parseCases(readFileSync(join(directory, file), 'utf8'), file));
}
