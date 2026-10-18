#!/usr/bin/env bash
# Bundles entrypoints into <outdir> (default: dist). With no entries it bundles the hook
# entrypoints, src/bin/*.ts. The AWS SDK is inlined, so the plugin needs no node_modules at
# runtime; the Codex runner never imports it. scripts/check.sh reuses this script to verify
# the committed dist/ is fresh, and scripts/e2e.sh to bundle its test-only canary hooks
# (give absolute paths for those). Usage: build.sh [outdir [entry...]]
set -euo pipefail
cd "$(dirname "$0")/.."

entries=("${@:2}")
[ ${#entries[@]} -gt 0 ] || entries=(src/bin/*.ts)

# The SDK's ESM build (module) keeps its dependencies out of CommonJS require() calls.
pnpm exec esbuild "${entries[@]}" \
  --bundle --platform=node --format=esm --target=node20 --main-fields=module,main \
  --out-extension:.js=.mjs \
  --outdir="${1:-dist}" --log-level=warning
