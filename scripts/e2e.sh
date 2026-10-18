#!/usr/bin/env bash
# Manual, headless end-to-end check of phi-guard's hook contracts against the INSTALLED
# `claude` and `codex` CLIs. Not part of `pnpm test` or `pnpm check`; run it with
# `pnpm e2e` or `scripts/e2e.sh [SCENARIO...]` (no arguments runs every scenario).
#
# Cost: one cheap-model call per output scenario (claude --model haiku, codex -m
# gpt-6-luna at low reasoning effort), nothing for the blocked-prompt scenarios, which
# never reach the model. That is five calls (C2, C3, X2, X3, X4) and about a minute in
# total (observed), plus two when the live scenarios run (LC2, LX2). A missing CLI makes
# that agent's scenarios SKIP; the exit status is non-zero if any scenario FAILs or if
# nothing ran.
#
# Prerequisites: `claude` >= 2.1.295 and/or `codex` 0.162.1 installed and logged in,
# node >= 22.18, `pnpm install` done (esbuild builds the test-only canary hooks) and
# dist/ built. C1-C3 and X1-X4 use a bogus guardrail id, so every scan errors and the
# hooks must fail closed. That is the expected outcome below, with or without AWS access.
# The scan errors come from the SDK (a credentials error, or a ValidationException when
# the machine has credentials but the guardrail id is bogus); either one proves the hook
# failed closed.
#
# Scenarios and expected outcomes (the canary zebra-canary-42 is fake data):
#   C1  Claude, prompt blocked. The shipped plugin is loaded with --plugin-dir and
#       configured through pluginConfigs. The prompt hook cannot scan, so it blocks:
#       the output carries "phi-guard could not scan this prompt (<errorName>)" with an
#       errorName other than MissingGuardrailConfig (which proves the pluginConfigs
#       options reached the hook), the model never runs (zero tokens, no assistant
#       message). The CLI echoes the blocked prompt back locally as "Original prompt",
#       so the canary is checked in the model's own output only.
#   C2  Claude, output withheld. The PostToolUse entry from hooks/hooks.json
#       (registered through --settings, not the plugin) cannot scan the output of
#       `cat <canary file>`, so the model's answer contains "withheld" and the canary
#       appears nowhere in the run's output.
#   C3  Claude, output masked. Same registration, but the bundle is a test-only canary
#       hook built from the production maskBashOutput with a fake scanner. The model's
#       answer contains "{NAME}", never the canary: the installed CLI accepts the
#       updatedToolOutput shape.
#   X1  Codex, prompt blocked. UserPromptSubmit from hooks/codex-hooks.json. The turn
#       completes with zero token usage and no agent message, so the model never ran.
#   X2  Codex, short command withheld. The shipped PreToolUse and PostToolUse hooks. The
#       answer contains "withheld"; the canary appears nowhere in the whole --json
#       stream (the exec events carry only the runner's marker).
#   X3  Codex, long-running command withheld. As X2, but the command is
#       `cat <canary file>; sleep 20; echo finished`, started with yield_time_ms 1000 so
#       Codex returns interim chunks and polls with write_stdin. The canary appears in no
#       interim or final chunk anywhere in the stream; the answer contains "withheld".
#   X4  Codex, output masked. Shipped PreToolUse and runner; the PostToolUse bundle is a
#       test-only canary hook built from the production maskCodexOutput, given the shipped
#       dist/ paths, with a fake scanner. The answer contains "{NAME}", never the canary.
#
# Live scenarios. LC1, LC2, LX1 and LX2 run the shipped hooks against a real guardrail.
# They run only when PHI_GUARD_GUARDRAIL_ID, PHI_GUARD_GUARDRAIL_VERSION and
# PHI_GUARD_AWS_REGION are set in the caller's environment (PHI_GUARD_AWS_PROFILE
# defaults to phi-guard, the sandbox default, when unset; set but empty it selects the
# default AWS credential chain), otherwise they SKIP. The bogus-id
# scenarios above keep the bogus id when those variables are exported. The fake PII is
# the name "Jane Example" and the email "jane.example@example.com".
#   LC1  Claude, prompt blocked. As C1 with the real values. The answer contains
#        "phi-guard blocked this prompt: possible <types>" with at least one finding
#        type, the model never runs (zero tokens, no assistant message).
#   LC2  Claude, output masked. The shipped plugin alone (--plugin-dir registers the
#        prompt and the PostToolUse hook) runs `cat` on a file holding the fake PII,
#        under a benign prompt. Neither fake value appears anywhere in the run output
#        and the answer carries a Bedrock mask tag (match \{[A-Z_]+\}); the tags seen are
#        the evidence, as the tag format is unverified (ARCHITECTURE, Part 2 item 4). If
#        the legacy `Action: BLOCK` wins on output (item 2), the answer shows the
#        guardrail's or the hook's withheld notice instead and the tag check FAILs.
#   LX1  Codex, prompt blocked. The shipped UserPromptSubmit hook with the real values:
#        zero tokens, no agent message, the fake values absent from the stream. LX1 cannot
#        tell a detection from a fail-closed scan error unless Codex surfaces the hook's
#        reason in the run output (the evidence shows it when it does, and the scenario
#        FAILs on "could not scan this prompt"). LX2 is the Codex scenario that proves the
#        real guardrail answered.
#   LX2  Codex, output masked. The shipped PreToolUse and PostToolUse hooks with the
#        real values: the fake values absent from the whole stream, and the answer
#        carries a mask tag.
# The isolation flags below drop user-level settings (--setting-sources project and
# --ignore-user-config). If the company login lives there (an apiKeyHelper, an env block
# with CLAUDE_CODE_USE_BEDROCK, a custom Codex model_provider), the scenarios that call
# the model fail (the evidence is a login or provider error in the run's stderr or
# answer) while LC1 and LX1, which make no model call, still work. On a machine whose
# enterprise managed settings set allowManagedHooksOnly, --plugin-dir and --settings
# hooks do not load, so the Claude scenarios FAIL: the model runs (tokens used, or the
# fake values in the output) although the hook should have blocked or masked.
#
# How each registration is built: the Claude plugin options for C1 go through a temp
# --settings file with pluginConfigs under the key "phi-guard@inline" (the key a
# --plugin-dir plugin gets; this path worked, no settings-env fallback was needed). C2
# and C3 register the hook generated from hooks/hooks.json and set bogus
# CLAUDE_PLUGIN_OPTION_* in the settings env. Codex gets `-c hooks.<Event>=...`
# overrides generated from hooks/codex-hooks.json (scripts/e2e/hook-config.ts) and bogus
# PHI_GUARD_* in the codex process env. The canary hooks are built with esbuild into the
# temp dir from the pure cores; nothing in src/ or dist/ has a test backdoor.
#
# Isolation: all scratch files live in one mktemp dir that a trap removes. Claude runs use
# --no-session-persistence and --setting-sources project; Codex runs use --ephemeral and
# --ignore-user-config. The script never edits anything under ~/.claude or ~/.codex, and
# never writes the repo, but the CLIs write their own state files in their home
# directories. The only other writes outside the temp dir are phi-guard's own
# /tmp/phi-guard-<uid> capture files, which the Codex PostToolUse hook deletes. Unrelated
# user-level hooks and plugins can still be loaded by the CLIs (Codex hooks.json,
# enterprise-managed settings).
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
CANARY=zebra-canary-42
FAKE_NAME='Jane Example'
FAKE_EMAIL=jane.example@example.com
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
WORK=$TMP/work
mkdir "$WORK"
printf 'patient %s ok\n' "$CANARY" >"$WORK/canary.txt"
printf 'patient %s, email %s\n' "$FAKE_NAME" "$FAKE_EMAIL" >"$WORK/pii.txt"

HELPERS=$ROOT/scripts/e2e
BOGUS_ID=phi-guard-e2e-bogus-guardrail
BOGUS_ENV=("PHI_GUARD_GUARDRAIL_ID=$BOGUS_ID" PHI_GUARD_GUARDRAIL_VERSION=1 PHI_GUARD_AWS_REGION=us-east-1 PHI_GUARD_AWS_PROFILE=)
LIVE_PROFILE=${PHI_GUARD_AWS_PROFILE-phi-guard} # unset: the sandbox default; set but empty: the default credential chain
LIVE_ENV=("PHI_GUARD_GUARDRAIL_ID=${PHI_GUARD_GUARDRAIL_ID:-}" "PHI_GUARD_GUARDRAIL_VERSION=${PHI_GUARD_GUARDRAIL_VERSION:-}"
  "PHI_GUARD_AWS_REGION=${PHI_GUARD_AWS_REGION:-}" "PHI_GUARD_AWS_PROFILE=$LIVE_PROFILE")
CLAUDE_TIMEOUT=180
CODEX_TIMEOUT=240

passed=0 failed=0 skipped=0
SCENARIO='' EVIDENCE='' REASONS=()

selected() {
  [ $# -eq 0 ] && return 0
  local want
  for want in "$@"; do [ "$want" = "$SCENARIO" ] && return 0; done
  return 1
}
SELECTION=("$@")

begin() {
  SCENARIO=$1 EVIDENCE='' REASONS=()
  if [ ${#SELECTION[@]} -gt 0 ] && ! selected "${SELECTION[@]}"; then return 1; fi
}

skip() {
  skipped=$((skipped + 1))
  echo "SKIP $SCENARIO: $1"
}

# check <reason> <command...>: records <reason> as a failure unless the command succeeds.
check() {
  local reason=$1
  shift
  "$@" || REASONS+=("$reason")
}

# begin_live <id>: like begin, and SKIPs unless the caller's environment names a guardrail.
begin_live() {
  begin "$1" || return 1
  [ -n "${PHI_GUARD_GUARDRAIL_ID:-}" ] && [ -n "${PHI_GUARD_GUARDRAIL_VERSION:-}" ] && [ -n "${PHI_GUARD_AWS_REGION:-}" ] && return 0
  skip 'set PHI_GUARD_GUARDRAIL_ID, PHI_GUARD_GUARDRAIL_VERSION and PHI_GUARD_AWS_REGION to run it against a real guardrail'
  return 1
}

finish() {
  if [ ${#REASONS[@]} -eq 0 ]; then
    passed=$((passed + 1))
    echo "PASS $SCENARIO: $EVIDENCE"
  else
    failed=$((failed + 1))
    local IFS=';'
    echo "FAIL $SCENARIO: ${REASONS[*]}"
    echo "     evidence: $EVIDENCE"
  fi
}

# Runs a command with a wall-clock limit; macOS has no timeout(1).
with_timeout() {
  local seconds=$1 pid watcher status=0
  shift
  "$@" &
  pid=$!
  (
    sleep "$seconds"
    kill "$pid"
  ) >/dev/null 2>&1 &
  watcher=$!
  wait "$pid" || status=$?
  pkill -P "$watcher" 2>/dev/null || true
  kill "$watcher" 2>/dev/null || true
  return "$status"
}

empty() { [[ -z $(<"$1") ]]; }
absent() { ! grep -rqF -- "$CANARY" "$@"; }
unleaked() { ! grep -rqF -e "$FAKE_NAME" -e "$FAKE_EMAIL" "$@"; }
absent_text() { ! grep -qF -- "$1" "${@:2}"; }
contains() { grep -qiF -- "$1" "$2"; }
matches() { grep -qE -- "$1" "$2"; }
mask_tags() { grep -oE '\{[A-Z_]+\}' "$1" | sort -u | paste -sd' ' - || true; }
oneline() { tr '\n' ' ' <"$1" | cut -c 1-160; }

events() { node "$HELPERS/events.ts" "$@"; }

# --- Claude -------------------------------------------------------------------------

# claude_run <name> <prompt> <settings file> [extra claude args]: leaves <name>.out (stream-json) and
# <name>.err in the temp dir.
claude_run() {
  local name=$1 prompt=$2 settings=$3
  shift 3
  (
    cd "$WORK"
    with_timeout "$CLAUDE_TIMEOUT" claude -p "$prompt" --model haiku --settings "$settings" \
      --setting-sources project --no-session-persistence --allowedTools=Bash \
      --output-format stream-json --verbose "$@" </dev/null >"$TMP/$name.out" 2>"$TMP/$name.err"
  ) || true # a failed or timed-out run shows up as missing evidence in the assertions
  events answer claude "$TMP/$name.out" >"$TMP/$name.answer"
}

# claude_plugin_settings <id> <version> <region> [profile]: a --settings body that configures the
# --plugin-dir plugin, which gets the key phi-guard@inline.
claude_plugin_settings() {
  local profile=${4:+,\"aws_profile\":\"$4\"}
  printf '{"pluginConfigs":{"phi-guard@inline":{"options":{"guardrail_id":"%s","guardrail_version":"%s","aws_region":"%s"%s}}}}\n' \
    "$1" "$2" "$3" "$profile"
}

# live_claude_settings: builds the live --settings file once and prints its path.
live_claude_settings() {
  [ -f "$TMP/live.json" ] || claude_plugin_settings "$PHI_GUARD_GUARDRAIL_ID" "$PHI_GUARD_GUARDRAIL_VERSION" \
    "$PHI_GUARD_AWS_REGION" "$LIVE_PROFILE" >"$TMP/live.json"
  echo "$TMP/live.json"
}

claude_output_prompt() { # <file>
  echo "Run this exact shell command: cat $1 . Then reply with ONLY the raw output text you received from the tool, verbatim."
}

claude_hook_settings() { # <swap args...>
  node "$HELPERS/hook-config.ts" claude "$ROOT" PostToolUse \
    --env CLAUDE_PLUGIN_OPTION_GUARDRAIL_ID="$BOGUS_ID" \
    --env CLAUDE_PLUGIN_OPTION_GUARDRAIL_VERSION=1 \
    --env CLAUDE_PLUGIN_OPTION_AWS_REGION=us-east-1 \
    --env E2E_CANARY="$CANARY" "$@"
}

scenario_c1() {
  begin C1 || return 0
  claude_plugin_settings "$BOGUS_ID" 1 us-east-1 >"$TMP/c1.json"
  claude_run c1 "Please say hello. Patient $CANARY needs a callback." "$TMP/c1.json" --plugin-dir "$ROOT"
  events model-text claude "$TMP/c1.out" >"$TMP/c1.model"
  local tokens name=''
  tokens=$(events tokens claude "$TMP/c1.out")
  if [[ $(<"$TMP/c1.answer") =~ could\ not\ scan\ this\ prompt\ \(([A-Za-z0-9_]+)\) ]]; then name=${BASH_REMATCH[1]}; fi
  EVIDENCE="errorName=${name:-none}, tokens=$tokens"
  check 'no phi-guard block reason in the output' test -n "$name"
  check 'errorName is MissingGuardrailConfig, so pluginConfigs did not reach the hook' test "$name" != MissingGuardrailConfig
  check 'the model ran (tokens used)' test "$tokens" = 0
  check 'the model produced text' empty "$TMP/c1.model"
  check 'canary in the model output' absent "$TMP/c1.model"
  finish
}

scenario_lc1() {
  begin_live LC1 || return 0
  claude_run lc1 "Please say hello. Patient $FAKE_NAME (email $FAKE_EMAIL) needs a callback." "$(live_claude_settings)" --plugin-dir "$ROOT"
  events model-text claude "$TMP/lc1.out" >"$TMP/lc1.model"
  local tokens types=''
  tokens=$(events tokens claude "$TMP/lc1.out")
  if [[ $(<"$TMP/lc1.answer") =~ blocked\ this\ prompt:\ possible\ ([A-Za-z_]+(,\ [A-Za-z_]+)*)\. ]]; then types=${BASH_REMATCH[1]}; fi
  EVIDENCE="types=${types:-none}, tokens=$tokens"
  check 'no blocked-prompt reason with a finding type in the output' test -n "$types"
  check 'the model ran (tokens used)' test "$tokens" = 0
  check 'the model produced text' empty "$TMP/lc1.model"
  check 'fake values in the model output' unleaked "$TMP/lc1.model"
  finish
}

scenario_c2() {
  begin C2 || return 0
  claude_hook_settings >"$TMP/c2.json"
  claude_run c2 "$(claude_output_prompt "$WORK/canary.txt")" "$TMP/c2.json"
  EVIDENCE=$(oneline "$TMP/c2.answer")
  check 'answer lacks the withheld notice' contains withheld "$TMP/c2.answer"
  check 'canary in the run output' absent "$TMP/c2.out" "$TMP/c2.err"
  finish
}

scenario_lc2() {
  begin_live LC2 || return 0
  claude_run lc2 "$(claude_output_prompt "$WORK/pii.txt")" "$(live_claude_settings)" --plugin-dir "$ROOT"
  EVIDENCE="mask tags=[$(mask_tags "$TMP/lc2.answer")]; $(oneline "$TMP/lc2.answer")"
  check 'answer lacks a mask tag' matches '\{[A-Z_]+\}' "$TMP/lc2.answer"
  check 'fake values in the run output' unleaked "$TMP/lc2.out" "$TMP/lc2.err"
  finish
}

scenario_c3() {
  begin C3 || return 0
  claude_hook_settings --swap bash-output.mjs="$TMP/canary-claude.mjs" >"$TMP/c3.json"
  claude_run c3 "$(claude_output_prompt "$WORK/canary.txt")" "$TMP/c3.json"
  EVIDENCE=$(oneline "$TMP/c3.answer")
  check 'answer lacks the {NAME} mask' contains '{NAME}' "$TMP/c3.answer"
  check 'canary in the run output' absent "$TMP/c3.out" "$TMP/c3.err"
  finish
}

# --- Codex --------------------------------------------------------------------------

OVERRIDES=()

# codex_overrides <events> [hook-config args]: fills OVERRIDES with `-c hooks.<Event>=...` pairs.
codex_overrides() {
  local line
  OVERRIDES=()
  while IFS= read -r line; do OVERRIDES+=(-c "$line"); done < <(node "$HELPERS/hook-config.ts" codex "$ROOT" "$@")
}

# codex_run <name> <prompt> [live]: leaves <name>.out (--json stream), <name>.err and
# <name>.answer. The guardrail is the bogus one unless the third argument is "live".
codex_run() {
  local name=$1 prompt=$2 guardrail=("${BOGUS_ENV[@]}")
  [ "${3:-}" != live ] || guardrail=("${LIVE_ENV[@]}")
  (
    cd "$WORK"
    export "${guardrail[@]}" E2E_CANARY=$CANARY E2E_REPO=$ROOT
    with_timeout "$CODEX_TIMEOUT" codex exec --ephemeral --ignore-user-config --json \
      --skip-git-repo-check -C "$WORK" -s workspace-write -m gpt-6-luna \
      -c model_reasoning_effort='"low"' "${OVERRIDES[@]}" \
      --dangerously-bypass-hook-trust "$prompt" </dev/null >"$TMP/$name.out" 2>"$TMP/$name.err"
  ) || true # a failed or timed-out run shows up as missing evidence in the assertions
  events answer codex "$TMP/$name.out" >"$TMP/$name.answer"
}

codex_output_prompt() { # <command>
  echo "Call the exec_command tool with cmd: $1 . Then reply with ONLY the text the tool call returned to you (its output, or its error message if it failed), verbatim."
}

# Mirrors the research prompt that forces the long-running (yielded) path.
codex_long_prompt() { # <command>
  echo "Call the exec_command tool directly (not via a script) with login false and yield_time_ms 1000, cmd: $1 . After it returns, poll the session with write_stdin (empty chars, yield_time_ms 15000) until the process exits. Then reply with ONLY every text each tool call returned to you (output or error message), verbatim, in order, labeled CALL1/CALL2."
}

scenario_x1() {
  begin X1 || return 0
  codex_overrides UserPromptSubmit
  codex_run x1 "Please say hello. Patient $CANARY needs a callback."
  local tokens messages
  tokens=$(events tokens codex "$TMP/x1.out")
  messages=$(grep -c '"agent_message"' "$TMP/x1.out" || true)
  EVIDENCE="tokens=$tokens, agent_message events=$messages"
  check 'turn did not complete with zero usage, so the model may have run' test "$tokens" = 0
  check 'agent_message event in the stream' test "$messages" = 0
  check 'canary in the run output' absent "$TMP/x1.out" "$TMP/x1.err"
  finish
}

scenario_lx1() {
  begin_live LX1 || return 0
  codex_overrides UserPromptSubmit
  codex_run lx1 "Please say hello. Patient $FAKE_NAME (email $FAKE_EMAIL) needs a callback." live
  local tokens messages reason=none
  tokens=$(events tokens codex "$TMP/lx1.out")
  messages=$(grep -c '"agent_message"' "$TMP/lx1.out" || true)
  if [[ $(cat "$TMP/lx1.out" "$TMP/lx1.err") =~ (blocked\ this\ prompt:\ possible\ [A-Za-z_]+(,\ [A-Za-z_]+)*|could\ not\ scan\ this\ prompt\ \([A-Za-z0-9_]+\)) ]]; then
    reason=${BASH_REMATCH[1]/#could not scan this prompt /could not scan }
  fi
  EVIDENCE="tokens=$tokens, agent_message events=$messages, reason=$reason"
  check 'turn did not complete with zero usage, so the model may have run' test "$tokens" = 0
  check 'agent_message event in the stream' test "$messages" = 0
  check 'fake values in the run output' unleaked "$TMP/lx1.out" "$TMP/lx1.err"
  check 'the hook failed closed on a scan error, so the guardrail did not answer' \
    absent_text 'could not scan this prompt' "$TMP/lx1.out" "$TMP/lx1.err"
  finish
}

scenario_x2() {
  begin X2 || return 0
  codex_overrides PreToolUse,PostToolUse
  codex_run x2 "$(codex_output_prompt "cat $WORK/canary.txt")"
  EVIDENCE=$(oneline "$TMP/x2.answer")
  check 'answer lacks the withheld notice' contains withheld "$TMP/x2.answer"
  check 'canary in the run output' absent "$TMP/x2.out" "$TMP/x2.err"
  finish
}

scenario_x3() {
  begin X3 || return 0
  codex_overrides PreToolUse,PostToolUse
  codex_run x3 "$(codex_long_prompt "cat $WORK/canary.txt; sleep 20; echo finished")"
  local interim
  interim=$(grep -o chunk_id "$TMP/x3.answer" | wc -l | tr -d ' ')
  EVIDENCE="interim chunks reported=$interim; $(oneline "$TMP/x3.answer")"
  check 'no yielded interim chunk reported, so the long-running path was not exercised' contains chunk_id "$TMP/x3.answer"
  check 'answer lacks the withheld notice' contains withheld "$TMP/x3.answer"
  check 'canary in the run output (interim or final chunk)' absent "$TMP/x3.out" "$TMP/x3.err"
  finish
}

scenario_lx2() {
  begin_live LX2 || return 0
  codex_overrides PreToolUse,PostToolUse
  codex_run lx2 "$(codex_output_prompt "cat $WORK/pii.txt")" live
  EVIDENCE="mask tags=[$(mask_tags "$TMP/lx2.answer")]; $(oneline "$TMP/lx2.answer")"
  check 'answer lacks a mask tag' matches '\{[A-Z_]+\}' "$TMP/lx2.answer"
  check 'fake values in the run output' unleaked "$TMP/lx2.out" "$TMP/lx2.err"
  finish
}

scenario_x4() {
  begin X4 || return 0
  codex_overrides PreToolUse,PostToolUse --swap codex-post-tool-use.mjs="$TMP/canary-codex.mjs"
  codex_run x4 "$(codex_output_prompt "cat $WORK/canary.txt")"
  EVIDENCE=$(oneline "$TMP/x4.answer")
  check 'answer lacks the {NAME} mask' contains '{NAME}' "$TMP/x4.answer"
  check 'canary in the run output' absent "$TMP/x4.out" "$TMP/x4.err"
  finish
}

# --- Main ---------------------------------------------------------------------------

started=$SECONDS
[ -f "$ROOT/dist/codex-runner.mjs" ] || { echo "dist/ is missing, run pnpm build" >&2; exit 1; }

# The canary hooks are test-only: built from the pure cores into the temp dir, never into dist/.
"$ROOT/scripts/build.sh" "$TMP" "$HELPERS"/canary-*.ts

if command -v claude >/dev/null; then
  echo "claude $(claude --version)"
  scenario_c1
  scenario_c2
  scenario_c3
  scenario_lc1
  scenario_lc2
else
  for SCENARIO in C1 C2 C3 LC1 LC2; do begin "$SCENARIO" && skip 'claude is not installed'; done
fi

if command -v codex >/dev/null; then
  codex --version
  scenario_x1
  scenario_x2
  scenario_x3
  scenario_x4
  scenario_lx1
  scenario_lx2
else
  for SCENARIO in X1 X2 X3 X4 LX1 LX2; do begin "$SCENARIO" && skip 'codex is not installed'; done
fi

echo "passed=$passed failed=$failed skipped=$skipped in $((SECONDS - started))s"
[ "$failed" -eq 0 ] && [ "$passed" -gt 0 ]
