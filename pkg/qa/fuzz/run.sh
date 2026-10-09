#!/bin/sh
# Fuzzes one target for SECONDS (default 60), growing its corpus in corpus/<target>. Where the
# host's glibc is older than the prebuilt fuzzer needs, run in a node container instead:
#   docker run --rm -v "$PWD/../..:/pkg" -w /pkg/qa/fuzz node:22-trixie sh run.sh decode 600
set -eu
export NODE_ENV=production
target=$1
seconds=${2:-60}
cd "$(dirname "$0")"
[ -d node_modules ] || npm ci --ignore-scripts --no-audit --no-fund
mkdir -p "corpus/$target" crashes
exec npx jazzer targets.mjs "corpus/$target" -f "$target" -i pkg/dist -e node_modules --sync -- \
  -max_total_time="$seconds" -max_len=65536 -rss_limit_mb=2048 -artifact_prefix=crashes/
