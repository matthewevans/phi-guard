# phi-guard

phi-guard keeps PHI away from a model provider that has no BAA, so a developer can
use a personal Claude Code or Codex CLI subscription for code-only work. It is a
plugin for both agents plus a reference dev container.

The sandbox is the boundary: the container runs the agent on the repo you open in
it (`nophi` mounts your working tree, so a fresh or shallow clone is the safest choice)
with an egress firewall and your host `~/.aws` and `~/.npmrc` mounted read-only. The
hooks are a safety net for human error. A prompt hook blocks prompts that contain
PHI, and an output hook masks PHI in shell command output before the model sees it.
Both call Amazon Bedrock Guardrails `ApplyGuardrail` in your BAA-covered AWS account. When a scan fails for
any reason the prompt is blocked or the output is withheld. That holds in
phi-guard's own code. The hooks run as the same user as the agent, and
ARCHITECTURE.md lists where the host itself fails open.

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design, the coverage
table and every known gap, in particular the Codex ones.

## Install

Deploy `infra/guardrail.yaml` first. Its outputs give the guardrail ID and version. The guardrail
takes the stack's name, so the default stack name `phi-guard` keeps today's name, and a policy
variant is a second stack (see [Evals](#evals)). AWS documents guardrail names as 1 to 50
characters of letters, digits, hyphens and underscores, so the stack name must fit that.

**Claude Code**

```
/plugin marketplace add <path-or-git-url>
/plugin install phi-guard@phi-guard
```

Claude Code asks for the options when you enable the plugin.
`claude plugin configure phi-guard@phi-guard` shows which are unset.

**Codex CLI**

```
codex plugin marketplace add <path-or-git-url>
codex plugin add phi-guard@phi-guard
```

Set the `PHI_GUARD_*` variables below in the environment Codex runs in. Codex
asks you to review and trust plugin hooks before they run (`/hooks`). The Codex
sandbox must allow writes to `/tmp` (workspace-write or danger-full-access). With
`read-only` or `exclude_slash_tmp`, every command output is withheld.

**Dev container**

Open the repo in the dev container (`.devcontainer/`). It installs both CLIs and
the plugin, and enforces the hooks through managed settings for Claude Code and
`requirements.toml` for Codex. Codex runs with `danger-full-access` because the
container is its boundary. The guardrail values are not in the repo. Export
`PHI_GUARD_GUARDRAIL_ID`, `PHI_GUARD_GUARDRAIL_VERSION` and `PHI_GUARD_AWS_REGION` in
the host environment before the image is built, which fails with the names of any that
are empty. `PHI_GUARD_AWS_PROFILE` is optional: unset means `phi-guard`, and set but empty means the
default AWS credential chain. A container
keeps the image it was created from, so after changing a guardrail variable or
`PHI_GUARD_FIREWALL` rebuild it (`nophi --rebuild`).

The container mounts your host `~/.aws` and `~/.npmrc` read-only. The hooks call
Bedrock with the AWS profile above (`phi-guard` unless you export another), so add a
`[profile phi-guard]` to your `~/.aws/config`: an SSO profile whose role allows
`bedrock:ApplyGuardrail` on the guardrail. Refresh credentials on the host
(`aws sso login`, CodeArtifact login). An expired session blocks prompts until you do.

Sign in to Claude Code and Codex inside the container. Both logins live in the Docker
volumes `phi-guard-claude-config` and `phi-guard-codex-config`, which every repo's
container shares and which are separate from the host's `~/.claude` and `~/.codex`. To
sign out, remove the containers using them and run
`docker volume rm phi-guard-claude-config phi-guard-codex-config`.
The sandbox allows no PHI, and its markers say so: a NO PHI IN THIS SANDBOX banner and a
`[NO PHI]` prompt prefix in interactive shells, a NO PHI Claude Code status line that
also shows the firewall mode, and the container hostname `phi-guard-sandbox` (shown in
the Codex status line).

Set `PHI_GUARD_FIREWALL` in the host environment before opening the container:
`web` (the default), `strict` or `off`. The value is fixed when the container is
created, and the hooks never read it. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#firewall-modes)
says what each mode allows. In `strict` mode, add other hosts, such as a CodeArtifact
endpoint for pip, with a comma-separated `PHI_GUARD_EXTRA_HOSTS`, and restart the
container after changing `~/.aws/config` or `~/.npmrc`.

## Launcher

`nophi` starts the dev container for whichever git repo you are in and runs an agent
in it, so nothing is committed to your repos. It builds the image locally from the
payload it ships with (this repo's `.devcontainer/`), and Docker caches the build.

```
brew tap matthewevans/phi-guard https://github.com/matthewevans/phi-guard.git
brew install nophi
```

The formula installs the `devcontainer` CLI. Docker must be running, and `realpath`
needs macOS 13 or later. Add the `[profile phi-guard]` entry to `~/.aws/config`
described above, then:

```
nophi claude [args...]      # Claude Code in the sandbox
nophi codex [args...]       # Codex in the sandbox
nophi shell                 # zsh in the sandbox
nophi down                  # remove this repo's sandbox container
nophi codex login --device-auth
```

Flags go before the subcommand and everything after it passes to the agent.
`--rebuild` recreates the container. The sandbox mounts your working tree, so edits land in your
checkout. Git worktrees do not work inside it, because a worktree's `.git` file
points at a host path.

Before it starts, `nophi` stops if the repo holds untracked or gitignored files with
a data-like extension (`csv`, `tsv`, `xls`, `xlsx`, `parquet`, `avro`, `orc`,
`jsonl`, `ndjson`, `sql`, `dump`, `bak`, `sqlite`, `sqlite3`, `db`), lists up to ten
of them, and proceeds only when they are moved out or you pass
`--i-checked-no-phi`. The [launcher section of
ARCHITECTURE.md](docs/ARCHITECTURE.md#launcher) lists what the stop misses. After the
container starts it sends one benign prompt through the Codex prompt hook to prove
that the guardrail answers. If that fails, the usual
cause is an expired AWS session: run `good-morning` on this machine. `nophi shell`
and `nophi codex login` skip that check. Claude's first-run login comes after that check, so
sign in once AWS works, or run `claude` from `nophi shell`.

In a terminal, `nophi` marks the window while the agent runs and restores it on
exit: the title reads `NO PHI · <repo>`, the background takes a dark red tint (light
pink when `COLORFGBG` reports a light background), and iTerm2 also gets a red tab
and a NO PHI badge. Claude Code keeps that title (`CLAUDE_CODE_DISABLE_TERMINAL_TITLE`).
Codex sets its own title; the tint, tab colour and its `phi-guard-sandbox` status line
remain.

After `brew upgrade nophi`, remove the previous version's containers. List them with
`docker ps --filter label=devcontainer.config_file`, remove them with `docker rm -f`,
or use Docker Desktop.

## Configuration

| Setting | Claude Code (`userConfig` key) | Codex (environment variable) | Required |
|---|---|---|---|
| Guardrail ID | `guardrail_id` | `PHI_GUARD_GUARDRAIL_ID` | yes |
| Guardrail version | `guardrail_version` | `PHI_GUARD_GUARDRAIL_VERSION` | yes |
| AWS region | `aws_region` | `PHI_GUARD_AWS_REGION` | yes |
| AWS profile | `aws_profile` | `PHI_GUARD_AWS_PROFILE` | no |

Without a profile the default AWS credential chain applies. The credentials need
only `bedrock:ApplyGuardrail` on the guardrail (`infra/guardrail.yaml` creates a
managed policy for it).

## Testing on a work machine

Your host `claude` and `codex` logins stay as they are. `pnpm e2e` runs with isolation
flags (`--setting-sources project`, `--no-session-persistence`, `--ephemeral`,
`--ignore-user-config`) and edits nothing under `~/.claude` or `~/.codex`. The
sandbox signs in on its own login volumes, with any account.

1. Clone this repo, run `pnpm install`, and `brew install devcontainer`.
2. Deploy `infra/guardrail.yaml` or reuse an existing guardrail, and refresh AWS on the
   host (`good-morning`).
3. Export the four `PHI_GUARD_*` variables from the [Configuration](#configuration)
   table. The profile defaults to `phi-guard`. As an alternative to adding a
   `[profile phi-guard]` entry, set `PHI_GUARD_AWS_PROFILE` to the work profile that can
   call `bedrock:ApplyGuardrail` (set but empty selects the default credential chain).
4. Run `pnpm e2e`. With the variables exported it adds four scenarios against the real
   guardrail: LC1 and LX1 (a fake-PII prompt is blocked) and LC2 and LX2 (`cat` of a
   fake-PII file is masked), two of them cheap-model calls. The isolation flags drop
   user-level settings. If your company login lives there (an `apiKeyHelper`, an `env`
   block with `CLAUDE_CODE_USE_BEDROCK`, a custom Codex `model_provider`), the scenarios
   that call the model fail while LC1 and LX1 still work. If enterprise managed settings
   set `allowManagedHooksOnly`, the Claude scenarios fail because hooks passed with
   `--plugin-dir` and `--settings` do not load. LX1 cannot tell a detection from a
   fail-closed scan error unless Codex surfaces the hook's reason in its output; LX2 is
   the Codex scenario that proves the real guardrail answered.
5. In some other repo, run the phi-guard checkout's launcher, for example
   `~/dev/phi-guard/bin/nophi --rebuild claude`, then `~/dev/phi-guard/bin/nophi codex`. Look for
   the NO PHI markers, a prompt containing a fake name and email being blocked, and
   `cat` of a file holding them coming back masked.

## Development

```
pnpm install
pnpm check
pnpm e2e
```

`pnpm check` runs the typecheck, a Prettier check, the tests, a build, a check that the
committed `dist/` matches a fresh build, `shellcheck` on every shell script (skipped with a
warning if it is missing), `claude plugin validate . --strict`, and `cfn-lint` on
`infra/guardrail.yaml` (skipped with a warning if `uvx` is missing).
Node 22.18 or newer is required.

`pnpm e2e` is manual and not part of `pnpm check`. It runs the hooks against the
installed `claude` and `codex` CLIs, with about five cheap-model calls in total.
Its main scenarios use a bogus guardrail, so the expected outcomes are the fail-closed
ones: prompts blocked, outputs withheld, and the masking paths proven with a
test-only fake scanner. With the guardrail variables exported (see
[Testing on a work machine](#testing-on-a-work-machine)) four more scenarios run
against the real guardrail. `scripts/e2e.sh` lists each scenario and its expected result.

## Evals

`pnpm eval` runs a labelled synthetic corpus through the shipped Claude hooks and a real
guardrail, and reports recall, false positives, scan errors, hook latency, text units and
estimated cost. It spawns `dist/bash-output.mjs` and `dist/prompt.mjs` as `hooks/hooks.json`
registers them, makes no model calls, and costs only the Guardrails text units; the
report prints the units and the estimate.

```
pnpm eval --list                      # case ids, formats and categories, no network
pnpm eval --case 'csv/*'              # a subset, matched against case ids
pnpm eval --overlay /path/to/dir      # read local cases from another directory than evals/local
PHI_GUARD_GUARDRAIL_ID=... PHI_GUARD_GUARDRAIL_VERSION=... PHI_GUARD_AWS_REGION=us-east-1 pnpm eval
pnpm eval --target keyed=abc123:2 --target all=def456:1   # compare guardrails side by side
```

A target is `<name>=<guardrailId>:<version>` (split on the last colon, so an ARN works).
Without `--target`, the guardrail comes from `PHI_GUARD_GUARDRAIL_ID` and
`PHI_GUARD_GUARDRAIL_VERSION`; region and profile come from `PHI_GUARD_AWS_REGION` and
`PHI_GUARD_AWS_PROFILE` (default `phi-guard`), as in the sandbox. `--concurrency <n>`
defaults to 4. Results go to `evals/results/<timestamp>/results.json` (gitignored) and hold
case ids, outcomes, finding types and timings, never case text or planted values. The run
exits non-zero when nothing ran, when any case errors outside the size probes, or when a hook
printed output the evals cannot read. Recall, leaks, gaps and false positives only appear in the
report, because name detection is ML-based.

Company formats such as member IDs and claim numbers belong in `evals/local/*.jsonl`
(gitignored, one case per line in the same schema); their categories report only when such a
file exists. To compare date policies, deploy
`infra/guardrail.yaml` a second time as another stack with `DatePolicy=All`, give the work
profile `bedrock:ApplyGuardrail` on both guardrails, and pass both as targets.
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#evals) describes the corpus, what is
measured and which categories are known gaps.

## Cost

The Guardrails PII filter costs $0.10 per 1,000 text units and regexes are free.
The [cost section of docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#cost-guardrails-pii-filter-at-010-per-1000-text-units-regexes-free)
has the per-developer estimates and how each agent's scans are counted.
