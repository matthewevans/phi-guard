#!/usr/bin/env bash
# Everything CI-like that runs offline: types, tests, dist/ freshness, plugin
# manifests and the CloudFormation template.
set -euo pipefail
cd "$(dirname "$0")/.."

pnpm typecheck
pnpm test

fresh=$(mktemp -d)
trap 'rm -rf "$fresh"' EXIT
scripts/build.sh "$fresh"
if ! diff -rq "$fresh" dist; then
  echo "dist/ is stale, run pnpm build" >&2
  exit 1
fi

claude plugin validate . --strict

if command -v uvx >/dev/null; then
  uvx cfn-lint infra/guardrail.yaml
else
  echo "warning: uvx not found, skipping cfn-lint" >&2
fi
