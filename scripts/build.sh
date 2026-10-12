#!/usr/bin/env bash
# Bundles the hook entrypoints into <outdir> (default: dist). The AWS SDK is inlined,
# so the plugin needs no node_modules at runtime. scripts/check.sh reuses this script
# to verify the committed dist/ is fresh. The banner gives bundled CommonJS code a
# working require() under ESM.
set -euo pipefail
cd "$(dirname "$0")/.."

pnpm exec esbuild src/bin/prompt.ts src/bin/bash-output.ts \
  --bundle --platform=node --format=esm --target=node20 \
  --out-extension:.js=.mjs \
  --banner:js="import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" \
  --outdir="${1:-dist}" --log-level=warning
