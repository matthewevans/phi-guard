import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readMentions } from '../src/mentions.ts';

function inTempDir(files: Record<string, string | Buffer>, run: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'phi-guard-mentions-'));
  try {
    for (const [name, contents] of Object.entries(files)) writeFileSync(join(dir, name), contents);
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('reads plain, quoted, line-range and punctuated mentions, once per file', () => {
  inTempDir({ 'a.txt': 'alpha', 'b c.txt': 'bravo', 'd.ts': 'delta' }, (dir) => {
    const prompt = `@a.txt and @"b c.txt", then @d.ts#L2-4. Again: @a.txt, and @${join(dir, 'd.ts')}`;
    assert.deepEqual(readMentions(prompt, dir), [
      { mention: 'a.txt', text: 'alpha' },
      { mention: 'b c.txt', text: 'bravo' },
      { mention: 'd.ts', text: 'delta' },
    ]);
  });
});

test('skips email addresses, directories, missing paths and empty files', () => {
  inTempDir({ 'empty.txt': '' }, (dir) => {
    mkdirSync(join(dir, 'src'));
    assert.deepEqual(readMentions('mail jane@example.com about @src and @missing.txt and @empty.txt', dir), []);
  });
});

test('throws on a mentioned file it cannot scan, so the prompt is blocked', () => {
  inTempDir(
    { 'image.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a]), 'big.log': 'x'.repeat(1_000_001) },
    (dir) => {
      assert.throws(() => readMentions('look at @image.png', dir), { name: 'UnscannableAttachment' });
      assert.throws(() => readMentions('look at @big.log', dir), { name: 'AttachmentTooLarge' });
    },
  );
});
