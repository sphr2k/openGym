#!/usr/bin/env bash
# Cloudflare Workers Builds: repository root, Node.js 24 on the build image.
# Keep application assets and MCP modules in the same staging Worker bundle.
set -euo pipefail
cd "$(dirname "$0")/.."

npm ci --prefix frontend --ignore-scripts --no-audit --no-fund
npm ci --prefix mcp --ignore-scripts --no-audit --no-fund
npm ci --prefix cloudflare --ignore-scripts --no-audit --no-fund
npm run build --prefix frontend
node scripts/catalogue/stage-media.mjs frontend/dist
npm test --prefix cloudflare
npm run build:staging --prefix cloudflare
