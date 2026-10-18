// Size probes: mixed log lines with three planted values, the last (one the detector should
// reliably flag) in the final 5% so a truncated scan is caught. The sizes bracket the ApplyGuardrail text-unit quota of 1,000
// (about 1,000,000 characters) in the large US Regions and 106 (about 106,000) elsewhere.
import type { Part, Recipe } from './compose.ts';
import { faker, makeSubject } from './synthetic.ts';

const SIZES = { '10k': 10_000, '100k': 100_000, '110k': 110_000, '990k': 990_000, '1010k': 1_010_000 };

const clock = (second: number) => new Date(Date.UTC(2026, 9, 1, 0, 0, second % 86_400)).toISOString();

const filler = (second: number) =>
  [
    clock(second),
    'INFO ',
    `worker-${faker.number.int({ min: 1, max: 8 })}`,
    `sync batch=${faker.string.hexadecimal({ length: 8, casing: 'lower', prefix: '' })}`,
    `rows=${faker.number.int({ min: 1, max: 999 })}`,
    `took=${faker.number.int({ min: 1, max: 900 })}ms`,
  ].join(' ');

function mixedLog(size: number): Part {
  const lines: Part[] = [];
  for (let length = 0; length < size;) {
    const line = filler(lines.length);
    lines.push(line);
    length += line.length + 1;
  }
  const subject = makeSubject();
  // Latest first, so the earlier insertion points keep their indexes.
  const planted: [fraction: number, line: Part][] = [
    [0.97, [`${clock(0)} ERROR member-sync rejected record ssn=`, subject.formatValidSsn]],
    [0.6, [`${clock(0)} INFO  sms-gateway delivered to `, subject.phone]],
    [0.25, [`${clock(0)} INFO  notifier sent receipt to `, subject.email]],
  ];
  for (const [fraction, line] of planted) lines.splice(Math.floor(lines.length * fraction), 0, line);
  return lines.flatMap((line, index) => (index === 0 ? [line] : ['\n', line]));
}

export const largeRecipes: Recipe[] = Object.entries(SIZES).map(([name, size]) => ({
  format: 'large',
  name,
  count: 1,
  build: () => mixedLog(size),
}));
