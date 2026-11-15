#!/usr/bin/env bash
# Compatibility entry point for the existing Workers Builds project.
set -euo pipefail
exec bash "$(dirname "$0")/cloudflare-production-build.sh" "$@"
