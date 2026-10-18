// pnpm eval: scans the corpus through the shipped Claude hook bundles against one or more
// real guardrails, writes evals/results/<timestamp>/results.json and prints a summary.
//
//   pnpm eval [--target <name>=<guardrailId>:<version>]... [--case <glob>] [--concurrency <n>] [--list]
//             [--overlay <directory>]
//
// Without --target, the guardrail comes from PHI_GUARD_GUARDRAIL_ID and _VERSION. The
// overlay directory defaults to evals/local. Region
// and profile come from PHI_GUARD_AWS_REGION and PHI_GUARD_AWS_PROFILE. Assumes Claude
// Code passes a command's full stdout to the PostToolUse hook (not verified).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, matchesGlob } from 'node:path';
import { parseArgs } from 'node:util';
import { PROMPT_FORMATS, type Case } from './case.ts';
import { classifyBash, classifyPrompt } from './classify.ts';
import { buildCorpus } from './corpus.ts';
import { hookSpec, runHook, type HookRun } from './hooks.ts';
import { runFailed, type Run } from './metrics.ts';
import { readOverlay } from './overlay.ts';
import { formatReport } from './report.ts';
import { scoreOutput, scorePrompt } from './score.ts';
import { defaultTarget, hookEnv, parseTarget, type Target } from './targets.ts';
import { readTemplate } from './template.ts';

const { values } = parseArgs({
  options: {
    target: { type: 'string', multiple: true, default: [] },
    case: { type: 'string' },
    concurrency: { type: 'string', default: '4' },
    list: { type: 'boolean', default: false },
    overlay: { type: 'string', default: join(import.meta.dirname, 'local') },
  },
});

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

/** Runs `work` over `items` with at most `size` in flight, keeping the order of the results. */
async function mapPool<T, R>(items: readonly T[], size: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await work(items[index]);
      }
    }),
  );
  return results;
}

const all = [...buildCorpus(), ...readOverlay(values.overlay)];
if (new Set(all.map(({ id }) => id)).size !== all.length) {
  fail('case ids must be unique across the corpus and evals/local');
}
const pattern = values.case;
const cases = pattern === undefined ? all : all.filter(({ id }) => matchesGlob(id, pattern));

if (values.list) {
  for (const { id, format, text, planted } of cases) {
    const categories = [...new Set(planted.map((p) => p.category))].join(',') || 'negative';
    console.log([id, format, categories, text.length].join('\t'));
  }
  process.exit(0);
}

const concurrency = Number(values.concurrency);
if (!Number.isInteger(concurrency) || concurrency < 1) fail('--concurrency must be a positive integer');
const targets: Target[] =
  values.target.length > 0
    ? values.target.map(parseTarget)
    : [
        defaultTarget(process.env) ??
          fail('pass --target, or export PHI_GUARD_GUARDRAIL_ID and PHI_GUARD_GUARDRAIL_VERSION'),
      ];

const template = readTemplate();
const knownTypes = new Set([...template.entityTypes, ...template.regexes.map(({ name }) => name)]);
const outputHook = hookSpec('PostToolUse');
const promptHook = hookSpec('UserPromptSubmit');

// A killed or crashed hook is an error outcome, the same as a hook that reports a scan failure.
const settle = <T>(run: HookRun, classify: (stdout: string) => T) =>
  run.failure ? ({ kind: 'error', name: run.failure } as const) : classify(run.stdout);

async function runCase(testCase: Case, env: NodeJS.ProcessEnv): Promise<Run> {
  const toolResponse = { stdout: testCase.text, stderr: '', interrupted: false, isImage: false };
  const scan = await runHook(outputHook, JSON.stringify({ tool_response: toolResponse }), env);
  const outcome = settle(scan, (stdout) => classifyBash(stdout, template.blockedOutputsMessaging));
  const run: Run = { testCase, output: scoreOutput(testCase, outcome, scan.ms) };
  if (PROMPT_FORMATS.has(testCase.format)) {
    const check = await runHook(promptHook, JSON.stringify({ prompt: testCase.text }), env);
    run.prompt = scorePrompt(testCase, settle(check, classifyPrompt), check.ms, knownTypes);
  }
  return run;
}

const results: { name: string; runs: Run[] }[] = [];
for (const target of targets) {
  console.error(`Scanning ${cases.length} cases against ${target.name}`);
  const env = hookEnv(target, process.env);
  results.push({ name: target.name, runs: await mapPool(cases, concurrency, (testCase) => runCase(testCase, env)) });
}

const resultsDir = join(import.meta.dirname, 'results', new Date().toISOString());
mkdirSync(resultsDir, { recursive: true });
// Ids, outcomes, indexes, types and timings only: never case text or planted values.
const persisted = results.map(({ name, runs }) => ({
  name,
  runs: runs.map(({ testCase, output, prompt }) => ({ id: testCase.id, output, prompt })),
}));
writeFileSync(join(resultsDir, 'results.json'), `${JSON.stringify({ targets: persisted }, null, 2)}\n`);

for (const { name, runs } of results) console.log(`${formatReport(name, runs)}\n`);
console.log(`Results: ${join(resultsDir, 'results.json')}`);

if (results.some(({ runs }) => runFailed(runs))) process.exitCode = 1;
