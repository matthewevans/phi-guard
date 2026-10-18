// Dev output that looks like identifiers but is not PHI: authors, timestamps, ids,
// versions, test cards and code that names patient fields without holding values.
import type { Format } from './case.ts';
import type { Part, Recipe } from './compose.ts';
import { RENDERERS, type Row } from './render.ts';
import { TEST_PANS, faker } from './synthetic.ts';

const hex = (length: number) => faker.string.hexadecimal({ length, casing: 'lower', prefix: '' });
const timestamp = () => faker.date.recent({ days: 30 }).toISOString();
const isoDate = () => timestamp().slice(0, 10);
const username = () => faker.internet.username().toLowerCase();
const author = () => `${faker.person.firstName()} ${faker.person.lastName()} <${username()}@example.com>`;
const int = (min: number, max: number) => faker.number.int({ min, max });
const lines = (count: number, make: () => string, separator = '\n') =>
  Array.from({ length: count }, make).join(separator);

// Common Log Format timestamp, e.g. 29/Sep/2026:14:03:22 +0000.
function accessLogTime(): string {
  const [, day, month, year, time] = faker.date.recent({ days: 30 }).toUTCString().split(/[ ,]+/);
  return `${day}/${month}/${year}:${time} +0000`;
}

const auditRow = (): Row => [
  ['id', String(int(1000, 9999))],
  ['created_at', timestamp()],
  ['updated_at', timestamp()],
  ['status', faker.helpers.arrayElement(['queued', 'running', 'done'])],
];

const releaseRow = (): Row => [
  ['package', faker.word.noun()],
  ['from_version', faker.system.semver()],
  ['to_version', faker.system.semver()],
  ['release_date', isoDate()],
];

const commit = () =>
  [
    `commit ${hex(40)}`,
    `Author: ${author()}`,
    `Date:   ${faker.date.recent({ days: 90 }).toUTCString()}`,
    '',
    `    ${faker.git.commitMessage()}`,
  ].join('\n');

const request = () =>
  `${timestamp()} INFO  api-gateway request id=${faker.string.uuid()} ` +
  `method=GET path=/v1/jobs status=200 duration_ms=${int(5, 900)}`;

const deployment = () =>
  `${timestamp()} INFO  deploy assumed arn:aws:iam::123456789012:role/${faker.word.noun()}-deployer, ` +
  `wrote arn:aws:s3:::${faker.word.noun()}-artifacts/${hex(12)}.zip`;

const release = () => `## [${faker.system.semver()}] - ${isoDate()}\n### Fixed\n- ${faker.git.commitMessage()}`;

const probe = () =>
  `10.${int(0, 255)}.${int(0, 255)}.${int(1, 254)} - - [${accessLogTime()}] ` +
  '"GET /healthz HTTP/1.1" 200 2 "-" "kube-probe/1.29"';

const installOutput = () => {
  const added = int(20, 400);
  const fourPartVersion = [int(0, 255), int(0, 255), int(0, 255), int(0, 255)].join('.');
  return [
    `Packages: +${added}`,
    `Progress: resolved ${added + 40}, reused ${added - 10}, downloaded 10, added ${added}, done`,
    '',
    'dependencies:',
    `+ ${faker.word.noun()} ${faker.system.semver()}`,
    `+ ${faker.word.noun()} ${faker.system.semver()}`,
    `+ chromium ${fourPartVersion}`,
    `Done in ${faker.number.float({ min: 0.5, max: 9, fractionDigits: 1 })}s`,
  ].join('\n');
};

const paymentTest = () =>
  [
    "// Payment SDK fixtures: the provider's published test cards.",
    `const TEST_CARD = '${faker.helpers.arrayElement(TEST_PANS)}';`,
    '',
    "it('charges the test card', async () => {",
    '  const charge = await sdk.charges.create({ card: TEST_CARD, amount: 1000 });',
    "  expect(charge.status).toBe('succeeded');",
    '});',
  ].join('\n');

function patientFieldCode(): string {
  const record = faker.helpers.arrayElement(['patient', 'member', 'claimant']);
  const fields = faker.helpers.arrayElements(
    ['firstName', 'lastName', 'dateOfBirth', 'phone', 'email', 'postalCode'],
    3,
  );
  return [
    `export function summarize(${record}: ${record[0].toUpperCase()}${record.slice(1)}): string {`,
    `  return [${fields.map((field) => `${record}.${field}`).join(', ')}].join(' ');`,
    '}',
  ].join('\n');
}

function memberSchema(): string {
  const columns = faker.helpers.arrayElements(
    ['first_name text', 'last_name text', 'dob date', 'ssn text', 'phone text', 'email text'],
    4,
  );
  return [
    `CREATE TABLE ${faker.helpers.arrayElement(['members', 'patients', 'enrollees'])} (`,
    '  id uuid PRIMARY KEY,',
    ...columns.map((column) => `  ${column},`),
    '  created_at timestamptz NOT NULL DEFAULT now(),',
    '  updated_at timestamptz NOT NULL DEFAULT now()',
    ');',
  ].join('\n');
}

const notificationDocs = () =>
  [
    '# Notifications',
    '',
    `Alerts go to ${username()}@example.com. Escalate to ${username()}@example.org.`,
    '',
    '```bash',
    `curl -H "Authorization: Bearer $TOKEN" https://api.example.com/v1/jobs/${faker.string.uuid()}`,
    '```',
  ].join('\n');

const refactorPrompt = () =>
  `${faker.helpers.arrayElement(['Refactor', 'Add tests for', 'Document', 'Speed up'])} ` +
  `${faker.helpers.arrayElement(['the claims parser', 'the eligibility client', 'the enrollment importer'])}. ` +
  `The patient.firstName and member.dateOfBirth fields stay required, and the release is planned for ${isoDate()}.`;

const uuidRecord = (): Row => [
  ['id', faker.string.uuid()],
  ['created_at', timestamp()],
  ['updated_at', timestamp()],
  ['owner_id', faker.string.uuid()],
];

const negative = (format: Format, name: string, build: () => Part): Recipe => ({ format, name, count: 7, build });

export const negativeRecipes: Recipe[] = [
  negative('git-log', 'authors', () => lines(3, commit, '\n\n')),
  negative('git-log', 'oneline-dates', () => lines(6, () => `${hex(7)} ${isoDate()} ${faker.git.commitMessage()}`)),
  negative('log', 'timestamps', () => lines(6, request)),
  negative('log', 'arns', () => lines(4, deployment)),
  negative('json', 'uuids', () => RENDERERS.json.render([uuidRecord()], 0)),
  negative('csv', 'audit-columns', () => RENDERERS.csv.render([auditRow(), auditRow()], 0)),
  negative('psql', 'audit-columns', () => RENDERERS.psql.render([auditRow(), auditRow()], 0)),
  negative('changelog', 'release-dates', () => lines(3, release, '\n\n')),
  negative('docs', 'example-addresses', notificationDocs),
  negative('package-output', 'versions', installOutput),
  negative('code', 'test-cards', paymentTest),
  negative('code', 'patient-fields', patientFieldCode),
  negative('ddl', 'member-schema', memberSchema),
  negative('access-log', 'private-addresses', () => lines(5, probe)),
  negative('prose', 'refactor-prompt', refactorPrompt),
  negative('ticket', 'dependency-upgrade', () => RENDERERS.ticket.render([releaseRow()], 0)),
];
