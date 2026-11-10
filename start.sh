#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
[ -d node_modules ] || npm install --omit=dev
# Node fetch() ignores HTTP(S)_PROXY unless this is set; harmless when no proxy is configured.
export NODE_USE_ENV_PROXY=1
exec node server.js
