#!/usr/bin/env bash
# The launcher's health check, run in the sandbox by bin/nophi before the agent starts.
# Prints nothing when phi-guard is enforcing, else the reason; a crash fails the pipeline.
set -o pipefail

case ${1:-} in
  claude)
    # The real CLI, through the wrapper and whatever account is signed in, must block a
    # fake-PII prompt before any model call. The prompt hook runs before authentication,
    # so this also works before the first login. If the hook did not run, the canary
    # reaches the model, which is why it is fake.
    claude -p 'nophi health check: patient Jane Example, jane.example@example.com' \
      --model haiku --output-format json --no-session-persistence </dev/null |
      jq -rs 'last as $run | ($run.result // "") as $result
        | if $run.total_cost_usd == 0 and ($result | contains("phi-guard blocked this prompt: possible ")) then empty
          else ($result | split("\n") | map(select(startswith("phi-guard could not scan"))) | first)
            // "phi-guard did not block the canary prompt, so its hooks are not running"
          end'
    ;;
  codex)
    reason=$(printf %s '{"prompt":"nophi health check"}' | node /opt/phi-guard/dist/codex-prompt.mjs | jq -r '.reason // empty') ||
      exit
    if [ -n "$reason" ]; then
      echo "$reason"
      exit 0
    fi
    # A ChatGPT workspace login merges cloud requirements over /etc/codex, and they can turn
    # hooks off, so a signed-in Codex must also block the canary before any model call: the
    # turn completes with zero usage and no agent message. Signed out, only the files apply.
    codex login status >/dev/null 2>&1 || exit 0
    codex exec --ephemeral --json --skip-git-repo-check -s read-only -c model_reasoning_effort='"low"' \
      'nophi health check: patient Jane Example, jane.example@example.com' </dev/null |
      jq -Rrs 'split("\n") | map(fromjson? // empty)
        | [.[] | select(.type == "turn.completed") | (.usage.input_tokens // 0) + (.usage.output_tokens // 0)] as $usage
        | if ($usage | length) > 0 and ($usage | add) == 0 and all(.[]; .item.type != "agent_message") then empty
          else "phi-guard did not block the canary prompt in Codex, so its hooks are not running"
          end'
    ;;
  *)
    echo "usage: health-check.sh <claude|codex>" >&2
    exit 2
    ;;
esac
