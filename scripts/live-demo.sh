#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

npm --prefix "$ROOT" run build >/dev/null

exec node "$ROOT/dist/cli.mjs" live \
    --cwd "$ROOT" \
    --stream-profile gpt-5.6-sol-xhigh \
    --pause-ms 1500 \
    -- \
    "$ROOT/node_modules/.bin/vitest" run "$ROOT/test/examples/replay.integration.test.ts" \
    --config "$ROOT/vitest.integration.config.ts"
