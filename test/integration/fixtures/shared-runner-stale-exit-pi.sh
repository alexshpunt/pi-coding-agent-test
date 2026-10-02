#!/usr/bin/env bash
set -euo pipefail

state="${ALE44_STALE_EXIT_STATE:?missing ALE44_STALE_EXIT_STATE}"
count_path="$state/launch-count"
count=1
if [[ -f "$count_path" ]]; then
    count=$(( $(cat "$count_path") + 1 ))
fi
printf '%s\n' "$count" > "$count_path"
printf '%s\n' "$$" > "$state/launch-$count.pid"

if [[ "$count" -eq 1 ]]; then
    printf '{"ready":true}\n' > "${PI_INTEGRATION_TEST_READY:?missing PI_INTEGRATION_TEST_READY}"
    while true; do
        sleep 1
    done
fi

exec "${ALE44_STALE_REAL_PI_COMMAND:?missing ALE44_STALE_REAL_PI_COMMAND}" "$@"
