// Offline checks for the detection evals: the corpus rules, the taxonomy's agreement with
// infra/guardrail.yaml, how hook output is classified and scored, and the metric math.
// Nothing here calls a guardrail.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Scan } from '../src/guardrail.ts';
import { maskBashOutput } from '../src/hooks/bash-output.ts';
import { maskFileOutput } from '../src/hooks/file-output.ts';
import { checkPrompt } from '../src/hooks/prompt.ts';
import { caseProblem, plant, type Case } from '../evals/case.ts';
import { UNRECOGNIZED_OUTPUT, classifyBash, classifyPrompt, classifyRead } from '../evals/classify.ts';
import { buildCorpus } from '../evals/corpus.ts';
import { hookSpec } from '../evals/hooks.ts';
import {
  estimatedCost,
  fileSurface,
  gateFailures,
  latency,
  rate,
  runFailed,
  summarizeOutput,
  summarizePrompt,
  surfaceDifferences,
  textUnits,
  type Run,
} from '../evals/metrics.ts';
import { parseCases } from '../evals/overlay.ts';
import { categoryRows, promptCategoryRows, sizeProbeRows } from '../evals/report.ts';
import { scoreOutput, scorePrompt } from '../evals/score.ts';
import { defaultTarget, hookEnv, parseTarget } from '../evals/targets.ts';
import { CATEGORIES, TAXONOMY } from '../evals/taxonomy.ts';
import { RESERVED_EMAIL_DOMAINS, TEST_PANS } from '../evals/synthetic.ts';
import { parseTemplate, readTemplate } from '../evals/template.ts';
import { clean } from './fakes.ts';
import { spawnHook } from './hook-process.ts';

const corpus = buildCorpus();
const template = readTemplate();
const regexNames = template.regexes.map(({ name }) => name);

const positives = (category: string) => corpus.filter(({ planted }) => planted.some((p) => p.category === category));
const valuesOf = (category: string, sub: string) =>
  corpus.flatMap(({ planted }) => planted.filter((p) => p.category === category && p.sub === sub).map((p) => p.value));

// --- corpus ---

test('the corpus is deterministic', () => {
  assert.deepEqual(buildCorpus(), corpus);
});

test('a few cases match a committed snapshot, so wall-clock or generator drift fails', () => {
  const text = (id: string) => corpus.find((c) => c.id === id)?.text;
  assert.equal(
    text('prose/birth-date-long-001'),
    'Why does the save endpoint return a 500 for this record: date_of_birth November 21, 1973.',
  );
  assert.equal(
    text('prose/stay-dates-002'),
    'Write a regression test for this failing record: admission_date 2026-01-08, discharge_date 01/22/2026.',
  );
  assert.equal(
    text('log/ssn-never-issued-001'),
    '2026-10-01T12:00:00.000Z ERROR record-service rejected record ssn="677-00-1613"\n' +
      '2026-10-01T12:00:00.000Z WARN  record-service will retry in 500ms',
  );
});

test('ids are unique and shaped <format>/<scenario>-<nnn>', () => {
  assert.equal(new Set(corpus.map(({ id }) => id)).size, corpus.length);
  for (const { id, format } of corpus) assert.match(id, new RegExp(`^${format}/[a-z0-9-]+-\\d{3}$`));
});

test('every planted value occurs once, in its own insertion', () => {
  for (const testCase of corpus) assert.equal(caseProblem(testCase), undefined, testCase.id);
});

test('JSON and FHIR cases parse', () => {
  for (const { id, format, text } of corpus) {
    if (format === 'json' || format === 'fhir') assert.doesNotThrow(() => JSON.parse(text), id);
  }
});

test('synthetic values stay inside reserved or never-issued ranges', () => {
  const domains = RESERVED_EMAIL_DOMAINS.map((domain) => domain.replace('.', '\\.')).join('|');
  for (const email of valuesOf('email', 'email')) assert.match(email, new RegExp(`@(${domains})$`));
  const phones = [...valuesOf('phone', 'phone'), ...valuesOf('fax', 'fax')];
  for (const phone of phones) assert.match(phone, /555[-. ]01\d\d$/);
  for (const ip of valuesOf('ip', 'ip')) assert.match(ip, /^(192\.0\.2|198\.51\.100|203\.0\.113)\.\d+$/);
  for (const url of valuesOf('url', 'url')) assert.match(url, /^https:\/\/portal\.example\.org\//);

  const luhnValid = (pan: string) =>
    [...pan].reverse().reduce((sum, digit, index) => {
      const n = Number(digit) * (index % 2 === 1 ? 2 : 1);
      return sum + (n > 9 ? n - 9 : n);
    }, 0) %
      10 ===
    0;
  const cards = valuesOf('account', 'card');
  assert.ok(cards.length > 0);
  for (const card of cards) {
    assert.ok((TEST_PANS as readonly string[]).includes(card));
    assert.ok(luhnValid(card), 'test PANs are Luhn-valid');
  }
});

test('SSN sub-categories hold: never-issued numbers cannot be issued, format-valid ones look issued', () => {
  const parts = (ssn: string) => {
    assert.match(ssn, /^\d{3}-\d{2}-\d{4}$/);
    return ssn.split('-');
  };
  for (const ssn of valuesOf('ssn', 'never-issued')) {
    const [area, group, serial] = parts(ssn);
    assert.ok(area === '000' || area === '666' || group === '00' || serial === '0000', 'could be issued');
    assert.ok(area < '900', 'areas from 900 are ITIN-shaped');
  }
  const formatValid = valuesOf('ssn', 'format-valid');
  assert.ok(formatValid.length > 0);
  for (const ssn of formatValid) {
    const [area, group, serial] = parts(ssn);
    assert.ok(area !== '000' && area !== '666' && area < '900' && group !== '00' && serial !== '0000');
  }
});

test('minimum counts hold for every category the committed corpus covers', () => {
  for (const category of CATEGORIES) {
    const cases = positives(category);
    if (TAXONOMY[category].coverage === 'overlay') {
      assert.equal(cases.length, 0, `${category} cases come from evals/local only`);
      continue;
    }
    assert.ok(cases.length >= 20, `${category} has ${cases.length} cases`);
    assert.ok(new Set(cases.map(({ format }) => format)).size >= 3, `${category} spans too few formats`);
  }
});

test('there are at least 80 negatives over the dev formats', () => {
  const negatives = corpus.filter(({ planted }) => planted.length === 0);
  assert.ok(negatives.length >= 80, `${negatives.length} negatives`);
  assert.ok(new Set(negatives.map(({ format }) => format)).size >= 10);
});

test('size probes bracket both text-unit quotas and plant a value in the final 5%', () => {
  const probes = corpus.filter(({ format }) => format === 'large');
  assert.ok(probes.length >= 5);
  const units = probes.map(({ text }) => textUnits(text));
  assert.ok(
    units.some((n) => n <= 106),
    'under the 106-unit quota',
  );
  assert.ok(
    units.some((n) => n > 106 && n <= 1000),
    'between the two quotas',
  );
  assert.ok(
    units.some((n) => n > 1000),
    'over the 1,000-unit quota',
  );
  for (const { id, text, planted } of probes) {
    assert.ok(planted.length >= 3, id);
    const last = planted.at(-1)!;
    assert.ok(['email', 'format-valid'].includes(last.sub), `${id}: the final value is one the detector should flag`);
    const start = text.indexOf(last.value);
    assert.ok(start >= 0.95 * text.length, `${id}: the final value starts at ${start / text.length}`);
  }
});

// --- taxonomy against infra/guardrail.yaml ---

test('each category is marked detectable, overlay or gap consistently with the template', () => {
  const parameterised = (type: string) => (template.regexes.find(({ name }) => name === type)?.refs.length ?? 0) > 0;
  const known = new Set([...template.entityTypes, ...regexNames]);
  for (const category of CATEGORIES) {
    const types = Object.values(TAXONOMY[category].subs).flat() as string[];
    for (const type of types) assert.ok(known.has(type), `${category}: ${type} is not defined in the template`);
    const derived = types.length === 0 ? 'gap' : types.every(parameterised) ? 'overlay' : 'detectable';
    assert.equal(TAXONOMY[category].coverage, derived, category);
  }
});

test('every regex in the template is at most 500 characters', () => {
  const patterns = template.regexes.flatMap(({ patterns }) => patterns);
  assert.ok(patterns.length > 0);
  for (const pattern of patterns) assert.ok(pattern.length <= 500, `${pattern.length} characters`);
});

test('PersonDate masks keyed person dates by default, and DatePolicy All also masks bare dates', () => {
  const personDate = template.regexes.find(({ name }) => name === 'PersonDate');
  assert.equal(personDate?.patterns.length, 2, 'one pattern per DatePolicy value');
  const [keyed, all] = personDate!.patterns.map((pattern) => new RegExp(pattern));

  const keyedDates = [
    'dob: 1961-03-04',
    '"birthDate": "1961-03-04"',
    'Date of Birth: 03/04/1961',
    'date_of_birth: March 3, 1961',
    'admission_date=2026-01-02',
    'AdmitDate 2026-01-02',
    'dischargeDate: 01/02/2026',
    'DOS 2026-03-04',
    'service_date | 2026-03-04',
    'date_of_death: 2026-01-02',
  ];
  const bareDates = [
    'created_at: 2026-03-04',
    'released on March 3, 1961',
    '2026-03-04T10:00:00Z INFO started',
    'on 03/04/2026',
  ];
  for (const text of keyedDates) assert.match(text, keyed, text);
  for (const text of bareDates) assert.doesNotMatch(text, keyed, text);
  for (const text of [...keyedDates, ...bareDates]) assert.match(text, all, text);
  for (const text of ['10.0.0.15', 'version 1.2.3', 'v20.11.1']) assert.doesNotMatch(text, all, text);
});

const guardrail = (properties: string) =>
  `Resources:\n  Guardrail:\n    Properties:\n${properties.replaceAll(/^/gm, '      ')}\n`;

test('the template reader assembles each variant of a joined pattern from its parts', () => {
  const { regexes } = parseTemplate(
    guardrail(
      [
        "BlockedOutputsMessaging: 'x'",
        'SensitiveInformationPolicyConfig:',
        '  PiiEntitiesConfig: []',
        '  RegexesConfig:',
        '    - Name: D',
        "      Pattern: !Join ['', ['a''b', !If [C, '|c', '']]]",
      ].join('\n'),
    ),
  );
  assert.deepEqual(regexes, [{ name: 'D', refs: [], patterns: ["a'b", "a'b|c"] }]);
});

test('the template reader finds the blocked-output message, entities and parameterised regexes', () => {
  const parsed = parseTemplate(
    guardrail(
      [
        "BlockedOutputsMessaging: 'it''s blocked'",
        'SensitiveInformationPolicyConfig:',
        '  PiiEntitiesConfig:',
        '    - { Type: NAME, Action: BLOCK }',
        '  RegexesConfig:',
        '    - Name: Id',
        '      Pattern: !Ref IdPattern',
      ].join('\n'),
    ),
  );
  assert.deepEqual(parsed, {
    blockedOutputsMessaging: "it's blocked",
    entityTypes: ['NAME'],
    regexes: [{ name: 'Id', refs: ['IdPattern'], patterns: [] }],
  });
});

// --- classification, pinned against the production hooks ---

const bash = { stdout: 'x', stderr: '', interrupted: false, isImage: false };
const flagging =
  (findings: string[], masked: string): Scan =>
  async () => ({ intervened: true, text: masked, findings });
const blockedMessage = template.blockedOutputsMessaging;

test('classifies what maskBashOutput produces: masked, withheld by the guardrail and unchanged', async () => {
  const masked = await maskBashOutput(bash, flagging(['NAME', 'PersonDate'], '{NAME} {PersonDate}'));
  assert.deepEqual(classifyBash(JSON.stringify(masked), blockedMessage), {
    kind: 'masked',
    text: '{NAME} {PersonDate}',
    types: ['NAME', 'PersonDate'],
  });

  const unnamed = await maskBashOutput(bash, flagging([], '{X}'));
  assert.deepEqual(classifyBash(JSON.stringify(unnamed), blockedMessage), { kind: 'masked', text: '{X}', types: [] });

  const withheld = await maskBashOutput(bash, flagging(['NAME'], blockedMessage));
  assert.deepEqual(classifyBash(JSON.stringify(withheld), blockedMessage), { kind: 'withheld' });

  assert.equal(await maskBashOutput(bash, clean), undefined);
  assert.deepEqual(classifyBash('', blockedMessage), { kind: 'unchanged' });
});

test('classifies what maskFileOutput produces for a Read result: masked, withheld by the guardrail and unchanged', async () => {
  const read = { type: 'text', file: { filePath: '/workspace/x', content: 'x' } };
  const masked = await maskFileOutput('Read', read, flagging(['NAME'], '{NAME}'));
  assert.deepEqual(classifyRead(JSON.stringify(masked), blockedMessage), {
    kind: 'masked',
    text: '{NAME}',
    types: ['NAME'],
  });

  const withheld = await maskFileOutput('Read', read, flagging(['NAME'], blockedMessage));
  assert.deepEqual(classifyRead(JSON.stringify(withheld), blockedMessage), { kind: 'withheld' });

  assert.equal(await maskFileOutput('Read', read, clean), undefined);
  assert.deepEqual(classifyRead('', blockedMessage), { kind: 'unchanged' });
  assert.deepEqual(
    classifyBash(JSON.stringify(masked), blockedMessage),
    { kind: 'error', name: UNRECOGNIZED_OUTPUT },
    'each surface reads its own field',
  );
});

test('classifies what checkPrompt produces: blocked with its types, or passed', async () => {
  const blocked = await checkPrompt('x', flagging(['NAME', 'EMAIL'], 'x'));
  assert.deepEqual(classifyPrompt(JSON.stringify(blocked)), { kind: 'blocked', types: ['NAME', 'EMAIL'] });
  const unnamed = await checkPrompt('x', flagging([], 'x'));
  assert.deepEqual(classifyPrompt(JSON.stringify(unnamed)), { kind: 'blocked', types: [] });

  assert.equal(await checkPrompt('x', clean), undefined);
  assert.deepEqual(classifyPrompt(''), { kind: 'passed' });
});

test('classifies the shipped bundles failing closed, by spawning them without configuration', () => {
  const prompt = spawnHook('prompt.mjs', JSON.stringify({ prompt: 'x' }));
  assert.equal(prompt.status, 0, prompt.stderr);
  assert.deepEqual(classifyPrompt(prompt.stdout), { kind: 'error', name: 'MissingGuardrailConfig' });

  const output = spawnHook('bash-output.mjs', JSON.stringify({ tool_response: bash }));
  assert.equal(output.status, 0, output.stderr);
  assert.deepEqual(classifyBash(output.stdout, blockedMessage), { kind: 'error', name: 'MissingGuardrailConfig' });

  const read = { type: 'text', file: { filePath: '/workspace/x', content: 'x' } };
  const file = spawnHook('file-output.mjs', JSON.stringify({ tool_name: 'Read', tool_response: read }));
  assert.equal(file.status, 0, file.stderr);
  assert.deepEqual(classifyRead(file.stdout, blockedMessage), { kind: 'error', name: 'MissingGuardrailConfig' });
});

test('output it cannot read is an error of its own, never a detection', () => {
  const unreadable = { kind: 'error', name: UNRECOGNIZED_OUTPUT };
  assert.deepEqual(classifyBash('not json', blockedMessage), unreadable);
  const withoutContext = '{"hookSpecificOutput":{"updatedToolOutput":{"stdout":"changed"}}}';
  assert.deepEqual(classifyBash(withoutContext, blockedMessage), unreadable);
  assert.deepEqual(classifyPrompt('{"decision":"block","reason":"something else"}'), unreadable);
  assert.deepEqual(classifyPrompt('null'), unreadable);
});

// --- scoring ---

const jane = plant('name', 'first', 'Jane');
const roe = plant('name', 'last', 'Roe');
const email = plant('email', 'email', 'jr@example.com');
const positive: Case = { id: 'csv/x-001', format: 'csv', text: 'Jane,Roe,jr@example.com', planted: [jane, roe, email] };
const negative: Case = { id: 'git-log/x-001', format: 'git-log', text: 'Author: Someone', planted: [] };

test('scores leaks by planted index and records mask tags the original did not contain', () => {
  const masked = scoreOutput(positive, { kind: 'masked', text: '{NAME},Roe,{EMAIL}', types: ['NAME', 'EMAIL'] }, 12);
  assert.deepEqual(masked, {
    outcome: 'masked',
    types: ['NAME', 'EMAIL'],
    tags: ['NAME', 'EMAIL'],
    leaked: [1],
    ms: 12,
  });

  const unchanged = scoreOutput(positive, { kind: 'unchanged' }, 5);
  assert.deepEqual(unchanged.leaked, [0, 1, 2]);

  assert.deepEqual(scoreOutput(positive, { kind: 'withheld' }, 5).leaked, []);
  const failed = scoreOutput(positive, { kind: 'error', name: 'ThrottlingException' }, 5);
  assert.deepEqual([failed.errorName, failed.leaked], ['ThrottlingException', []]);

  const tagged = { ...positive, text: 'Jane {NAME} Roe jr@example.com' };
  const result = scoreOutput(tagged, { kind: 'masked', text: 'Jane {NAME} Roe {EMAIL}', types: [] }, 1);
  assert.deepEqual(result.tags, ['EMAIL'], 'a tag already in the original is not evidence');
});

test('a prompt is caught only when blocked with every expected type, and unknown types are recorded', () => {
  const known = new Set(['NAME', 'EMAIL']);
  assert.deepEqual(scorePrompt(positive, { kind: 'blocked', types: ['NAME', 'EMAIL', 'PHONE'] }, 3, known), {
    outcome: 'blocked',
    types: ['NAME', 'EMAIL', 'PHONE'],
    missing: [],
    unknown: ['PHONE'],
    ms: 3,
  });
  assert.deepEqual(scorePrompt(positive, { kind: 'blocked', types: ['NAME'] }, 3, known).missing, ['EMAIL']);
  assert.deepEqual(scorePrompt(positive, { kind: 'passed' }, 3, known).missing, []);
  assert.equal(scorePrompt(negative, { kind: 'error', name: 'X' }, 3, known).errorName, 'X');
});

// --- metrics ---

test('Wilson intervals match known values', () => {
  const { low, high } = rate(8, 10);
  assert.ok(Math.abs(low - 0.4902) < 1e-3 && Math.abs(high - 0.9433) < 1e-3, `${low} ${high}`);
  assert.ok(Math.abs(rate(10, 10).low - 0.7225) < 1e-3);
  assert.equal(rate(10, 10).high, 1);
  assert.ok(Number.isNaN(rate(0, 0).value));
});

test('latency uses nearest-rank percentiles', () => {
  assert.deepEqual(latency([50, 10, 30, 20, 40]), { p50: 30, p95: 50, max: 50 });
  assert.equal(latency([]), undefined);
});

test('text units are one per started 1,000 characters, and cost follows the PII filter rate', () => {
  assert.deepEqual(
    [0, 1, 1000, 1001, 2500].map((length) => textUnits('a'.repeat(length))),
    [0, 1, 1, 2, 3],
  );
  assert.ok(Math.abs(estimatedCost(1000) - 0.1) < 1e-12);
});

const run = (testCase: Case, output: Partial<Run['output']>, prompt?: Partial<NonNullable<Run['prompt']>>): Run => ({
  testCase,
  output: { outcome: 'masked', types: [], tags: [], leaked: [], ms: 10, ...output },
  prompt: prompt && { outcome: 'blocked', types: [], missing: [], unknown: [], ms: 10, ...prompt },
});

test('output summary counts values, false positives and errors apart, and narrows by category', () => {
  const runs = [
    run(positive, { leaked: [1], tags: ['NAME'] }),
    run(positive, { outcome: 'error', errorName: 'ThrottlingException' }),
    run(positive, { outcome: 'withheld' }),
    run(negative, { outcome: 'masked' }),
    run(negative, { outcome: 'unchanged' }),
    run(negative, { outcome: 'withheld' }),
  ];
  const summary = summarizeOutput(runs);
  assert.deepEqual([summary.recall.hits, summary.recall.total], [2, 3], 'the errored run is neither caught nor leaked');
  assert.deepEqual([summary.falsePositives.hits, summary.falsePositives.total], [2, 3]);
  assert.deepEqual(summary.errors, { ThrottlingException: 1 });
  assert.deepEqual([summary.withheld, summary.tags, summary.cases, summary.units], [2, ['NAME'], 6, 6]);

  const names = summarizeOutput(runs.slice(0, 1), (planted) => planted.category === 'name');
  assert.deepEqual([names.recall.hits, names.recall.total], [1, 2]);
});

test('a withheld positive says nothing about its values, so it is out of recall', () => {
  const summary = summarizeOutput([run(positive, { outcome: 'withheld' })]);
  assert.deepEqual([summary.recall.total, summary.withheld], [0, 1]);
});

test('gap categories stay out of the default recall and keep their own', () => {
  const gapValue = plant('mrn', 'mrn', '12345678');
  const gapOnly: Case = { id: 'csv/gap-001', format: 'prose', text: 'mrn 12345678', planted: [gapValue] };
  const runs = [run(positive, {}, {}), run(gapOnly, { leaked: [0] }, { outcome: 'passed' })];

  const output = summarizeOutput(runs);
  assert.deepEqual([output.recall.hits, output.recall.total], [3, 3]);
  const gap = summarizeOutput(runs, (planted) => planted.category === 'mrn');
  assert.deepEqual([gap.recall.hits, gap.recall.total], [0, 1]);

  const prompt = summarizePrompt(runs);
  assert.deepEqual([prompt.recall.hits, prompt.recall.total], [1, 1]);
  const promptGap = summarizePrompt(runs, (planted) => planted.category === 'mrn');
  assert.deepEqual([promptGap.recall.hits, promptGap.recall.total], [0, 1]);
});

test('prompt summary counts a positive as caught only with every expected type', () => {
  const runs = [
    run(positive, {}, {}),
    run(positive, {}, { missing: ['EMAIL'] }),
    run(positive, {}, { outcome: 'passed' }),
    run(negative, {}, { outcome: 'blocked', unknown: ['X'] }),
    run(negative, {}, { outcome: 'error', errorName: 'Y' }),
    run(negative, {}),
  ];
  const summary = summarizePrompt(runs);
  assert.deepEqual([summary.recall.hits, summary.recall.total], [1, 3]);
  assert.deepEqual([summary.falsePositives.hits, summary.falsePositives.total], [1, 1]);
  assert.deepEqual([summary.typeMisses, summary.unknownTypes, summary.errors, summary.cases], [1, ['X'], { Y: 1 }, 5]);
});

test('errors fail the run except in size probes, where only unreadable output does', () => {
  const probe: Case = { ...positive, id: 'large/x-001', format: 'large' };
  const error = { outcome: 'error', errorName: 'ValidationException' } as const;
  assert.deepEqual(gateFailures([run(positive, error), run(probe, error), run(negative, {})]), ['csv/x-001']);
  assert.deepEqual(gateFailures([run(probe, { outcome: 'error', errorName: UNRECOGNIZED_OUTPUT })]), ['large/x-001']);
  assert.deepEqual(gateFailures([run(positive, {}, { outcome: 'error', errorName: 'X' })]), ['csv/x-001']);
  assert.deepEqual(gateFailures([{ ...run(positive, {}), file: { ...run(positive, error).output } }]), ['csv/x-001']);
  assert.equal(runFailed([]), true, 'a run that scanned nothing fails');
  assert.equal(runFailed([run(probe, error)]), false);
});

test('the file surface is scored like the output surface, and differences are counted', () => {
  const same = { ...run(positive, { leaked: [1] }), file: run(positive, { leaked: [1] }).output };
  const leakedMore = { ...run(positive, { leaked: [1] }), file: run(positive, { leaked: [0, 1] }).output };
  const withheld = { ...run(negative, { outcome: 'unchanged' }), file: run(negative, { outcome: 'withheld' }).output };
  const runs = [same, leakedMore, withheld, run(negative, {})];
  assert.deepEqual(
    fileSurface(runs).map(({ output }) => output),
    [same.file, leakedMore.file, withheld.file],
  );
  assert.equal(surfaceDifferences(runs), 2);
  assert.equal(summarizeOutput(fileSurface(runs)).withheld, 1);
});

// --- report rows ---

test('category rows list values, recall, leaks and withheld cases per category and sub-category', () => {
  const runs = [
    run(positive, { leaked: [1] }),
    run(positive, { outcome: 'withheld' }),
    run({ ...positive, id: 'csv/x-002', planted: [email] }, { outcome: 'unchanged', leaked: [0] }),
  ];
  assert.deepEqual(categoryRows(runs), [
    ['name', 'detectable', '2', '50.0% (1/2) [9%-91%]', '1', '1'],
    ['  first', '', '1', '100.0% (1/1) [21%-100%]', '0', '1'],
    ['  last', '', '1', '0.0% (0/1) [0%-79%]', '1', '1'],
    ['email', 'detectable', '2', '50.0% (1/2) [9%-91%]', '1', '1'],
  ]);
});

test('prompt category rows count cases, recall and type misses, including for gap categories', () => {
  const gapOnly: Case = {
    id: 'prose/gap-001',
    format: 'prose',
    text: 'mrn 12345678',
    planted: [plant('mrn', 'mrn', '12345678')],
  };
  const runs = [
    run(positive, {}, {}),
    run(positive, {}, { missing: ['EMAIL'] }),
    run(gapOnly, {}, { outcome: 'passed' }),
  ];
  assert.deepEqual(promptCategoryRows(runs), [
    ['name', 'detectable', '2', '50.0% (1/2) [9%-91%]', '1'],
    ['email', 'detectable', '2', '50.0% (1/2) [9%-91%]', '1'],
    ['mrn', 'gap', '1', '0.0% (0/1) [0%-79%]', '0'],
  ]);
});

test('size probe rows show size, units, outcome and leaked values for large cases only', () => {
  const probe: Case = { ...positive, id: 'large/x-001', format: 'large', text: 'a'.repeat(1500) };
  const runs = [
    run(positive, {}),
    run(probe, { outcome: 'error', errorName: 'ValidationException', ms: 1234 }),
    run({ ...probe, id: 'large/x-002' }, { leaked: [0, 2], ms: 20 }),
  ];
  assert.deepEqual(sizeProbeRows(runs), [
    ['large/x-001', '1500', '2', 'error ValidationException', '0', '1234'],
    ['large/x-002', '1500', '2', 'masked', '2', '20'],
  ]);
});

// --- overlay, targets and hook wiring ---

const overlayRow = {
  id: 'local/member-001',
  format: 'csv',
  text: 'M123,ok',
  planted: [{ category: 'health-plan-beneficiary', sub: 'member-id', value: 'M123' }],
};

test('overlay rows parse into cases', () => {
  assert.deepEqual(parseCases(`${JSON.stringify(overlayRow)}\n\n`, 'members.jsonl'), [overlayRow]);
});

test('a bad overlay row fails with its file and row number, never its content', () => {
  const secret = 'M999-not-a-real-id';
  const rows = [
    JSON.stringify(overlayRow),
    '',
    JSON.stringify({ ...overlayRow, id: 'local/b', planted: [{ ...overlayRow.planted[0], value: secret }] }),
  ];
  assert.throws(
    () => parseCases(rows.join('\n'), 'members.jsonl'),
    (error: Error) => {
      assert.match(error.message, /^members\.jsonl row 3: planted value 0 occurs 0 times/);
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    },
  );
  assert.throws(() => parseCases('{nope', 'a.jsonl'), /^Error: a\.jsonl row 1: not valid JSON$/);
  const unknownCategory = JSON.stringify({ ...overlayRow, planted: [{ ...overlayRow.planted[0], category: 'nope' }] });
  assert.throws(() => parseCases(unknownCategory, 'a.jsonl'), /row 1: unknown category/);
});

test('targets split on the last colon, so a guardrail ARN works', () => {
  assert.deepEqual(parseTarget('keyed=abc123:2'), { name: 'keyed', guardrailId: 'abc123', version: '2' });
  const arn = 'arn:aws:bedrock:us-east-1:123456789012:guardrail/abc123';
  assert.deepEqual(parseTarget(`all=${arn}:DRAFT`), { name: 'all', guardrailId: arn, version: 'DRAFT' });
  for (const bad of ['abc123:2', 'keyed=abc123', 'keyed=:2', 'keyed=abc123:']) {
    assert.throws(() => parseTarget(bad), /--target must look like/);
  }
});

test('the default target and the hook environment come from the PHI_GUARD_ names', () => {
  assert.equal(defaultTarget({ PHI_GUARD_GUARDRAIL_ID: 'g' }), undefined);
  const target = defaultTarget({ PHI_GUARD_GUARDRAIL_ID: 'g', PHI_GUARD_GUARDRAIL_VERSION: '3' });
  assert.deepEqual(target, { name: 'default', guardrailId: 'g', version: '3' });

  const env = hookEnv(target!, { PHI_GUARD_AWS_REGION: 'us-east-1', PATH: '/bin' });
  assert.equal(env.CLAUDE_PLUGIN_OPTION_GUARDRAIL_ID, 'g');
  assert.equal(env.CLAUDE_PLUGIN_OPTION_GUARDRAIL_VERSION, '3');
  assert.equal(env.CLAUDE_PLUGIN_OPTION_AWS_REGION, 'us-east-1');
  assert.equal(env.CLAUDE_PLUGIN_OPTION_AWS_PROFILE, 'phi-guard');
  assert.equal(hookEnv(target!, { PHI_GUARD_AWS_PROFILE: 'work' }).CLAUDE_PLUGIN_OPTION_AWS_PROFILE, 'work');
});

test('hook specs come from hooks/hooks.json and point at the shipped bundles', () => {
  const output = hookSpec('PostToolUse', 'Bash');
  const file = hookSpec('PostToolUse', 'Read|Grep');
  const prompt = hookSpec('UserPromptSubmit');
  assert.equal(output.command, 'node');
  assert.match(output.args[0], /\/dist\/bash-output\.mjs$/);
  assert.match(file.args[0], /\/dist\/file-output\.mjs$/);
  assert.match(prompt.args[0], /\/dist\/prompt\.mjs$/);
  assert.ok([output, file, prompt].every(({ args }) => existsSync(args[0])));
  assert.deepEqual([output.timeoutMs, file.timeoutMs, prompt.timeoutMs], [20_000, 20_000, 20_000]);
  assert.throws(() => hookSpec('PostToolUse', 'Edit'), /no PostToolUse entry with matcher Edit/);
});

test('pnpm eval --list prints ids, formats and categories without scanning or showing text', () => {
  const emptyOverlay = mkdtempSync(join(tmpdir(), 'phi-guard-overlay-'));
  const result = spawnSync(process.execPath, ['evals/run.ts', '--list', '--case', 'csv/*', '--overlay', emptyOverlay], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
  });
  rmSync(emptyOverlay, { recursive: true });
  assert.equal(result.status, 0, result.stderr);
  const rows = result.stdout
    .trim()
    .split('\n')
    .map((line) => line.split('\t'));
  assert.equal(rows.length, corpus.filter(({ format }) => format === 'csv').length);
  for (const [id, format] of rows) assert.ok(id.startsWith('csv/') && format === 'csv');
});
