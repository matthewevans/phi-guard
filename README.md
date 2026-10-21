# phi-guard

phi-guard keeps PHI away from a model provider that has no BAA, so a developer can
use a personal Claude Code or Codex CLI subscription for code-only work. It is a
plugin for both agents plus a reference dev container.

The sandbox is the boundary: the container runs the agent on a clone of your repo's
committed content, which `nophi` hands over as a git bundle (your working tree is never
mounted), with an egress firewall (the `strict` allowlist by default) and two read-only
credential files that `nophi` writes for it: one short-lived AWS session for a role that can
only call `ApplyGuardrail`, and an npmrc filtered to CodeArtifact. Your host `~/.aws` and
`~/.npmrc` are never mounted. The ["Clean room" section of
ARCHITECTURE.md](docs/ARCHITECTURE.md#clean-room) lists what the sandbox holds, what it can
reach and every residual. The hooks are a safety net for human error. A prompt hook blocks prompts that contain
PHI, and output hooks mask PHI in shell command output (and, in Claude Code, in files
read with Read, Grep or an `@file` mention) before the model sees it.
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
`requirements.toml` for Codex. `claude` in the container is a wrapper that also loads
phi-guard from the command line, so a Team or Enterprise login cannot drop it. Codex runs with `danger-full-access` because the
container is its boundary. The guardrail values are not in the repo. Export
`PHI_GUARD_GUARDRAIL_ID`, `PHI_GUARD_GUARDRAIL_VERSION` and `PHI_GUARD_AWS_REGION` in
the host environment before the image is built, which fails with the names of any that
are empty. A container
keeps the image it was created from, so after changing a guardrail variable,
`PHI_GUARD_FIREWALL` or `PHI_GUARD_EXTRA_HOSTS` rebuild it (`nophi --rebuild`).

The container holds one AWS credential: a single short-lived session for a role whose only
permission is `bedrock:ApplyGuardrail` on the guardrail. Attach `ApplyGuardrailPolicy`
(`infra/guardrail.yaml`) to a dedicated role or permission set, name an SSO or assume-role
profile for it `phi-guard` in your host `~/.aws/config`, and sign in on the host
(`aws sso login`). At every launch `nophi` exports a session from that profile and
writes it to the sandbox's `~/.aws/credentials`, and it refuses long-lived static keys.
`PHI_GUARD_AWS_PROFILE` is a host variable that names another profile (unset or empty means
`phi-guard`). It reaches no image and no container, which configure no profile. The sandbox
gets no SSO token, no `~/.aws/config` and no other role. Its npmrc holds only the CodeArtifact
`registry=` lines of your host `~/.npmrc` and those hosts' auth tokens. An expired session
blocks prompts until you rerun `nophi`.

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
`strict` (the default), `web` or `off`. The value is fixed when the container is
created, and the hooks never read it. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#firewall-modes)
says what each mode allows. `strict` allows only the agent providers, GitHub, npm and
CodeArtifact, and the Bedrock endpoint, so WebFetch and `curl` to other hosts fail, and so do
PyPI, the Go proxy, Maven, Docker Hub and apt. Add hosts, such as a CodeArtifact endpoint
for pip, with a comma-separated `PHI_GUARD_EXTRA_HOSTS`, or opt in to `web` (any public
host, private ranges rejected) with `PHI_GUARD_FIREWALL=web nophi --rebuild claude`. The
firewall script pins its mode and extra hosts at the first start, so changing either needs
`nophi --rebuild`. Restart the container after changing `~/.npmrc`. Only terminal `nophi`
sessions are supported: attaching VS Code is outside the sandbox, and its hosts are not on
the `strict` list.

## Launcher

`nophi` starts the dev container for whichever git repo you are in and runs an agent
in it, so nothing is committed to your repos. It builds the image locally from the
payload it ships with (this repo's `.devcontainer/`), and Docker caches the build.

```
brew tap matthewevans/phi-guard https://github.com/matthewevans/phi-guard.git
brew install nophi
```

The formula installs the `devcontainer` CLI, the AWS CLI and `jq`. Docker must be
running, and `realpath` needs macOS 13 or later. Set up the `phi-guard` profile described
above, then:

```
nophi claude [args...]      # Claude Code in the sandbox
nophi codex [args...]       # Codex in the sandbox
nophi shell                 # zsh in the sandbox
nophi down                  # remove this repo's sandbox container and its credentials
nophi codex login --device-auth
```

Flags go before the subcommand and everything after it passes to the agent.
`--rebuild` recreates the container.

**What enters the sandbox.** At every launch `nophi` bundles your repo's branches, tags and
`HEAD` (`git bundle`, run only in your repo) and the sandbox builds its clone from that
bundle. Only committed, reachable content enters: untracked and ignored files (a stray
`export.csv`), the stash and unreferenced objects stay on your machine, and `nophi` says
once when the working tree has uncommitted changes. A repo with no commits is refused.
Tracked data files are the repo's own problem, as is its history; LFS content, nested
repos and submodules are not bundled. Git worktrees work, because the host repo is only
bundled. The first launch checks out your current branch (or the detached commit) in
`/workspace`, tracking `host/<branch>`. Later launches refresh `host/*` from a new bundle
and leave the clone's branches and checkout alone, which is where your sandbox work lives
between sessions.

**How work returns.** When a `claude`, `codex` or `shell` session ends, the sandbox writes
its branches and tags to a bundle, and `nophi` keeps a validated copy and points the remote
`nophi` of your repo at it. Then:

```
git fetch nophi
git merge nophi/<branch>   # or: git log nophi/<branch>, git cherry-pick ...
```

Work done on a detached checkout in the sandbox comes back as `nophi/HEAD`. Sandbox tags do
not land in your `refs/tags`. A Ctrl-C skips the copy, and the next session's exit sends the
commits. Merged sandbox commits are untrusted code, like any branch from a stranger: review
them before you run anything they add, including hook directories (`core.hooksPath`
settings such as `.husky`), `.envrc` and `.vscode/tasks.json`.

**The clone lives on your disk**, in `${XDG_CACHE_HOME:-~/.cache}/nophi/<repo>-<hash>/workspace`,
and the sandbox owns it. Never run git, a hook-running tool or an editor there on the host:
a sandbox can plant git config that runs when git does. `nophi` refuses to start from inside
that directory. `nophi down` removes the container and the credentials, keeps the clone and
prints its path; delete the directory when you are done with the repo.

VS Code is outside the clean room: the Dev Containers extension forwards your SSH agent and
credential helper when it attaches. The [launcher section of
ARCHITECTURE.md](docs/ARCHITECTURE.md#launcher) has the residuals.

After the container starts, a health check sends a fake-PII canary prompt through the agent and
starts it only if phi-guard blocks the canary before any model call. That proves the
hooks are loaded under whatever account is signed in (an org login's managed settings
can displace them, see [Org logins](docs/ARCHITECTURE.md#org-logins)) and that the
guardrail answers. Codex runs the canary only when signed in, and otherwise checks the
guardrail alone. If the check reports a scan error, the usual cause is a role that lacks
`bedrock:ApplyGuardrail` on the guardrail. `nophi shell` and `nophi codex login` skip
the check. It works before Claude's first-run login.

Before the container starts, `nophi claude` and `nophi codex` mint the sandbox's AWS
session. If the profile cannot produce a short-lived one (the SSO login expired, the
profile is missing, `aws` is absent, or the profile holds static keys), they stop and tell
you to run `good-morning` (`aws sso login`) on this machine. `nophi shell` and
`nophi codex login` need no AWS and only warn. The session lasts as long as your SSO
session grants, an hour by default, so rerun `nophi` in any terminal to refresh it: the
running sandbox sees the new credentials at once. `nophi` keeps them, with the filtered
npmrc and the bundles, in `${XDG_CACHE_HOME:-~/.cache}/nophi/<repo>-<hash>/` (mode 0700). Closing a session
leaves them in place, because another terminal may still be using them; `nophi down` deletes
the credentials file. A sandbox that `docker start` restarts has no firewall until `nophi`
runs again, so start it through `nophi`.

In a terminal, `nophi` marks the window while the agent runs and restores it on
exit: the title reads `NO PHI · <repo>`, the background takes a dark red tint (light
pink when `COLORFGBG` reports a light background), and iTerm2 also gets a red tab
and a NO PHI badge. Claude Code keeps that title (`CLAUDE_CODE_DISABLE_TERMINAL_TITLE`).
Codex sets its own title; the tint, tab colour and its `phi-guard-sandbox` status line
remain.

After `brew upgrade nophi`, `nophi` removes this repo's containers from earlier versions
at the next launch and says so, because they mounted your whole `~/.aws`.

## Configuration

| Setting | Claude Code (`userConfig` key) | Codex (environment variable) | Required |
|---|---|---|---|
| Guardrail ID | `guardrail_id` | `PHI_GUARD_GUARDRAIL_ID` | yes |
| Guardrail version | `guardrail_version` | `PHI_GUARD_GUARDRAIL_VERSION` | yes |
| AWS region | `aws_region` | `PHI_GUARD_AWS_REGION` | yes |
| AWS profile | `aws_profile` | `PHI_GUARD_AWS_PROFILE` | no |

The profile settings serve host installs (a plain plugin install, `pnpm e2e`, `pnpm eval`).
In the sandbox the profile is a host variable that `nophi` mints a session from, and the
container sets none. Without a profile the default AWS credential chain applies. The
credentials need only `bedrock:ApplyGuardrail` on the guardrail (`infra/guardrail.yaml`
creates a managed policy for it).

## Testing on a work machine

Your host `claude` and `codex` logins stay as they are. `pnpm e2e` runs with isolation
flags (`--setting-sources project`, `--no-session-persistence`, `--ephemeral`,
`--ignore-user-config`) and edits nothing under `~/.claude` or `~/.codex`. The
sandbox signs in on its own login volumes, with any account.

1. Clone this repo, run `pnpm install`, and `brew install devcontainer`.
2. Deploy `infra/guardrail.yaml` or reuse an existing guardrail, and refresh AWS on the
   host (`good-morning`).
3. Export the `PHI_GUARD_*` variables from the [Configuration](#configuration)
   table. `nophi` mints the sandbox's session from the profile `phi-guard` unless
   `PHI_GUARD_AWS_PROFILE` names another, which must be an SSO or assume-role profile
   whose role can call `bedrock:ApplyGuardrail` (static keys are refused, and for `nophi` a
   set but empty value counts as unset). `pnpm e2e` reads the same variable, and
   for it a set but empty value selects the default credential chain.
4. Run `pnpm e2e`. With the variables exported it adds six scenarios against the real
   guardrail: LC1 and LX1 (a fake-PII prompt is blocked), LC2 and LX2 (`cat` of a
   fake-PII file is masked), LC3 (Claude's Read of that file is masked) and LC4 (a prompt
   that `@`-mentions it is blocked), three of them cheap-model calls. The isolation flags drop
   user-level settings. If your company login lives there (an `apiKeyHelper`, an `env`
   block with `CLAUDE_CODE_USE_BEDROCK`, a custom Codex `model_provider`), the scenarios
   that call the model fail while LC1 and LX1 still work. If enterprise managed settings
   set `allowManagedHooksOnly`, the Claude scenarios fail because hooks passed with
   `--plugin-dir` and `--settings` do not load. LX1 cannot tell a detection from a
   fail-closed scan error unless Codex surfaces the hook's reason in its output; LX2 is
   the Codex scenario that proves the real guardrail answered.
5. In some other repo, run the phi-guard checkout's launcher, for example
   `~/dev/phi-guard/bin/nophi --rebuild claude`, then `~/dev/phi-guard/bin/nophi codex`. Look for
   the NO PHI markers, a prompt containing a fake name and email being blocked, the same
   for a prompt that `@`-mentions a file holding them, and that file coming back masked
   when Claude reads it, greps it or runs `cat` on it.

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
[Testing on a work machine](#testing-on-a-work-machine)) six more scenarios run
against the real guardrail. `scripts/e2e.sh` lists each scenario and its expected result.

## Evals

`pnpm eval` runs a labelled synthetic corpus through the shipped Claude hooks and a real
guardrail, and reports recall, false positives, scan errors, hook latency, text units and
estimated cost. It spawns `dist/bash-output.mjs`, `dist/file-output.mjs` (each case as a Read
result) and `dist/prompt.mjs` as `hooks/hooks.json` registers them, makes no model calls, and costs only the Guardrails text units; the
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
`PHI_GUARD_AWS_PROFILE` (default `phi-guard`), which is nophi's host-side default. `--concurrency <n>`
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
