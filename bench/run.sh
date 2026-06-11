#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

TS="$(date -u +%Y%m%dT%H%M%SZ)"
TARGET="${TARGET:-unknown}"
OUT="results/${TS}-${TARGET}"
mkdir -p "$OUT"

echo ">>> Smoke (100 req)"
k6 run --summary-export="${OUT}/smoke.json" k6-smoke.js

echo ">>> Load 1k"
k6 run --summary-export="${OUT}/load-1k.json" k6-load-1k.js

echo ">>> Load 10k"
k6 run --summary-export="${OUT}/load-10k.json" k6-load-10k.js

echo ">>> Done. Results under ${OUT}/"
