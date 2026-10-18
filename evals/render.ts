// Shapes labelled values the way each dev-facing format prints them. Positive and
// negative cases share these, so only the values differ between a leak and a false positive.
import type { Format } from './case.ts';
import { flatten, type Part } from './compose.ts';

/** Labelled values in the order a record prints them. */
export type Row = readonly (readonly [label: string, cell: Part])[];

const TIMESTAMP = '2026-10-01T12:00:00.000Z';
const PROSE_INTROS = [
  'Why does the save endpoint return a 500 for this record:',
  'Write a regression test for this failing record:',
  'Explain why validation rejects this payload:',
];
const STACK_FRAMES = [
  '    at validateRecord (/app/src/records/validate.ts:88:11)',
  '    at async saveRecord (/app/src/records/save.ts:41:5)',
  '    at async handler (/app/src/routes/records.ts:19:3)',
].join('\n');

const TICKET_INTRO = [
  'h3. Save fails for one record',
  '',
  '*Steps to reproduce*',
  '# Open the record below in the admin console.',
  '# Click Save.',
  '',
  '*Record*',
  '',
].join('\n');

const joined = (items: readonly Part[], separator: string): Part =>
  items.flatMap((item, index) => (index === 0 ? [item] : [separator, item]));
const quoted = (cell: Part): Part => ['"', cell, '"'];
/** Prints each labelled value with `show`, separated by `separator`. */
const each = (row: Row, show: (label: string, cell: Part) => Part, separator: string): Part =>
  joined(
    row.map(([label, cell]) => show(label, cell)),
    separator,
  );
const textOf = (cell: Part) => flatten(cell).text;

function csv(rows: readonly Row[]): Part {
  const header = rows[0].map(([label]) => label).join(',');
  const body = rows.map((row) =>
    joined(
      row.map(([, cell]) => (textOf(cell).includes(',') ? quoted(cell) : cell)),
      ',',
    ),
  );
  return joined([header, ...body], '\n');
}

// Mirrors psql's aligned output: columns padded to the widest cell, last column unpadded.
function psql(rows: readonly Row[]): Part {
  const labels = rows[0].map(([label]) => label);
  const widths = labels.map((label, column) =>
    Math.max(label.length, ...rows.map((row) => textOf(row[column][1]).length)),
  );
  const line = (cells: readonly Part[]): Part => [
    ' ',
    joined(
      cells.map((cell, column) =>
        column === cells.length - 1 ? cell : [cell, ' '.repeat(widths[column] - textOf(cell).length)],
      ),
      ' | ',
    ),
  ];
  const rule = widths.map((width) => '-'.repeat(width + 2)).join('+');
  const count = `(${rows.length} ${rows.length === 1 ? 'row' : 'rows'})`;
  return joined([line(labels), rule, ...rows.map((row) => line(row.map(([, cell]) => cell))), count], '\n');
}

export const ROW_FORMATS = [
  'prose',
  'log',
  'json',
  'csv',
  'psql',
  'stacktrace',
  'ticket',
] as const satisfies readonly Format[];
export type RowFormat = (typeof ROW_FORMATS)[number];

interface Renderer {
  /** Records the format prints at once. */
  rows: number;
  /** `variant` is the case's index within its shape, for formats that vary their wording. */
  render(rows: readonly Row[], variant: number): Part;
}

export const RENDERERS: Record<RowFormat, Renderer> = {
  prose: {
    rows: 1,
    render: ([row], variant) => [
      PROSE_INTROS[variant % PROSE_INTROS.length],
      ' ',
      each(row, (label, cell) => [label, ' ', cell], ', '),
      '.',
    ],
  },
  log: {
    rows: 1,
    render: ([row]) => [
      `${TIMESTAMP} ERROR record-service rejected record `,
      each(row, (label, cell) => [label, '=', quoted(cell)], ' '),
      `\n${TIMESTAMP} WARN  record-service will retry in 500ms`,
    ],
  },
  json: {
    rows: 1,
    render: ([row]) => [
      '{\n  "status": "error",\n  "record": {\n',
      each(row, (label, cell) => ['    ', quoted(label), ': ', quoted(cell)], ',\n'),
      '\n  }\n}',
    ],
  },
  csv: { rows: 2, render: csv },
  psql: { rows: 2, render: psql },
  stacktrace: {
    rows: 1,
    render: ([row]) => [
      'ValidationError: record rejected {',
      each(row, (label, cell) => [label, ': ', quoted(cell)], ', '),
      `}\n${STACK_FRAMES}`,
    ],
  },
  ticket: {
    rows: 1,
    render: ([row]) => [
      TICKET_INTRO,
      each(row, (label, cell) => ['* ', label, ': ', cell], '\n'),
      '\n\n*Expected*: the record saves.',
    ],
  },
};
