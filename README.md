# phi-guard

phi-guard keeps PHI away from a model provider that has no BAA, so a developer can
use a personal Claude Code or Codex CLI subscription for code-only work. It is a
plugin for both agents plus a reference dev container.

The sandbox is the boundary: the container runs the agent on the repo you open in
it (a shallow clone is the intended setup, which the container does not enforce)
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

Deploy `infra/guardrail.yaml` first. Its outputs give the guardrail ID and version.

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
container is its boundary. The `REPLACE_IN_PART_2_*` placeholders in
`.devcontainer/Dockerfile` and `.devcontainer/claude-code/phi-guard.json` need real
guardrail values before the hooks can scan. The `strict` firewall mode will not start
until a real region is set there.

The container mounts your host `~/.aws` and `~/.npmrc` read-only. The hooks call
Bedrock with the `phi-guard` profile, so add a `[profile phi-guard]` to your
`~/.aws/config`: an SSO profile whose role allows `bedrock:ApplyGuardrail` on the
guardrail. Refresh credentials on the host (`aws sso login`, CodeArtifact login). An
expired session blocks prompts until you do.

Set `PHI_GUARD_FIREWALL` in the host environment before opening the container. The
value is fixed when the container is created, and the hooks never read it.

| Value | Egress |
|---|---|
| `web` (default) | Any public IPv4 address. Private and internal ranges are rejected, including the cloud metadata address. Web searches, WebFetch and `curl` to public sites work. |
| `strict` | An allowlist: GitHub, npm, the model providers, Bedrock and STS for your region, the VS Code hosts, the SSO hosts named in `~/.aws/config` and the CodeArtifact hosts in the `registry=` lines of `~/.npmrc`. Add other hosts, such as a CodeArtifact endpoint for pip, with a comma-separated `PHI_GUARD_EXTRA_HOSTS`. A listed host is reachable with all of your mounted credentials. Restart the container after changing `~/.aws/config` or `~/.npmrc`. |
| `off` | No firewall. What the agent can reach is your responsibility. |

Any other value stops the firewall script before it changes a rule.

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

## Development

```
pnpm install
pnpm check
pnpm e2e
```

`pnpm check` runs the typecheck, the tests, a build, a check that the committed
`dist/` matches a fresh build, `claude plugin validate . --strict`, and
`cfn-lint` on `infra/guardrail.yaml` (skipped with a warning if `uvx` is missing).
Node 22.18 or newer is required.

`pnpm e2e` is manual and not part of `pnpm check`. It runs the hooks against the
installed `claude` and `codex` CLIs, with about five cheap-model calls in total.
There is no AWS access in Part 1, so the expected outcomes are the fail-closed
ones: prompts blocked, outputs withheld, and the masking paths proven with a
test-only fake scanner. `scripts/e2e.sh` lists each scenario and its expected result.

## Cost

The Guardrails PII filter costs $0.10 per 1,000 text units and regexes are free.
That is about $0.20 per developer per month for prompts only, about $5 with Bash
output, and about $40 for heavy agentic use. Codex scans one capture per command,
at most about 20,000 bytes of it. See the cost section of
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#cost-guardrails-pii-filter-at-010-per-1000-text-units-regexes-free).
