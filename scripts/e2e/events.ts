// Reads the machine-readable output of one headless run for scripts/e2e.sh:
//
//   events.ts answer     claude|codex <file>  the run's final answer text
//   events.ts model-text claude <file>        text the model itself produced
//   events.ts tokens     claude|codex <file>  total input + output tokens, "none" if the run never finished
//
// claude files hold `--output-format stream-json --verbose` lines, codex files `--json` lines.
import { readFileSync } from 'node:fs';

interface Usage {
  input_tokens?: number;
  output_tokens?: number;
}
interface Event {
  type?: string;
  result?: string;
  usage?: Usage;
  message?: { content?: { type: string; text?: string }[] };
  item?: { type?: string; text?: string };
}

const [command, agent, file] = process.argv.slice(2);
const events = readFileSync(file, 'utf8')
  .split('\n')
  .flatMap((line): Event[] => {
    try {
      return [JSON.parse(line)];
    } catch {
      return []; // Non-JSON lines such as Codex's stdin notice.
    }
  });

const total = (usage: Usage) => (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);

if (command === 'answer') {
  const texts =
    agent === 'claude'
      ? events.filter((e) => e.type === 'result').map((e) => e.result)
      : events.filter((e) => e.item?.type === 'agent_message').map((e) => e.item?.text);
  console.log(texts.join('\n'));
} else if (command === 'model-text') {
  const blocks = events.filter((e) => e.type === 'assistant').flatMap((e) => e.message?.content ?? []);
  console.log(blocks.map((block) => block.text ?? '').join('\n'));
} else if (command === 'tokens') {
  const finals = events.filter((e) => e.type === (agent === 'claude' ? 'result' : 'turn.completed') && e.usage);
  console.log(finals.length === 0 ? 'none' : finals.reduce((sum, e) => sum + total(e.usage!), 0));
} else {
  throw new Error(`unknown command: ${command}`);
}
