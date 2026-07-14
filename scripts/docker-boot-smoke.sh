#!/usr/bin/env bash
#
# docker-boot-smoke.sh — prove a built scheduling-bridge image actually BOOTS.
#
# The runtime entrypoint (`node dist/server/handler.js`) eagerly imports
# @tummycrypt/scheduling-kit (dist/core/types.js re-exports the kit; the
# capabilities surface imports it too). The kit is supplied ONLY from the Bazel
# module graph — never npm (npmjs is frozen at 0.8.0, below the ^0.9.2 peer
# range; .npmrc keeps auto-install-peers=false). If the Dockerfile fails to copy
# the Bazel-resolved kit into node_modules, the container crashloops at boot with
#   ERR_MODULE_NOT_FOUND '@tummycrypt/scheduling-kit' from /app/dist/core/types.js
# This gate catches exactly that regression before any tag is pushed (blahaj
# edd159d5 rolled back sha-22b1b7f for this crashloop; apply run 29292387304).
#
# The smoke asserts the image boots and serves GET /health 200 with the real
# bridge health contract within a timeout, and dumps `docker logs` loudly on any
# failure (non-200, container exit, or timeout).
#
# Usage:
#   scripts/docker-boot-smoke.sh <image-ref>
#
# Env knobs:
#   SMOKE_PORT          host port to bind (default 3001)
#   SMOKE_TIMEOUT_SECS  seconds to wait for /health 200 (default 60)
#
set -euo pipefail

IMAGE="${1:?usage: docker-boot-smoke.sh <image-ref>}"
PORT="${SMOKE_PORT:-3001}"
TIMEOUT_SECS="${SMOKE_TIMEOUT_SECS:-60}"
CONTAINER="bridge-boot-smoke-$$"

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

dump_logs_and_fail() {
  echo "::error::boot smoke FAILED: $1"
  echo "==================== docker logs ($CONTAINER) ===================="
  docker logs "$CONTAINER" 2>&1 || true
  echo "==================== docker inspect .State ======================="
  docker inspect --format '{{json .State}}' "$CONTAINER" 2>&1 || true
  echo "=================================================================="
  exit 1
}

echo "==> Booting image: $IMAGE"
echo "==> Container:     $CONTAINER  (host 127.0.0.1:${PORT} -> 3001)"
# Minimal env: AUTH_TOKEN is a dummy (auth is exercised, not bypassed); the
# server needs NO database/redis env to boot (redisClient is null unless
# REDIS_URL is set; the pg pool is gated on BRIDGE_DATABASE_URL). /health is an
# unauthenticated route, so a 200 proves the module graph loaded and the HTTP
# server is live.
docker run -d --name "$CONTAINER" \
  -p "127.0.0.1:${PORT}:3001" \
  -e AUTH_TOKEN=smoke-dummy-token \
  -e PORT=3001 \
  -e NODE_ENV=production \
  "$IMAGE" >/dev/null

deadline=$(( SECONDS + TIMEOUT_SECS ))
last_code="none"
while [ "$SECONDS" -lt "$deadline" ]; do
  # If the container exited (crashloop), fail immediately with logs.
  running="$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || echo false)"
  if [ "$running" != "true" ]; then
    dump_logs_and_fail "container is not running (exited before serving /health)"
  fi

  last_code="$(curl -s -o /tmp/bridge-health.body -w '%{http_code}' \
    "http://127.0.0.1:${PORT}/health" || echo 000)"
  if [ "$last_code" = "200" ]; then
    echo "==> /health -> 200"
    echo "==================== /health body ==============================="
    cat /tmp/bridge-health.body; echo
    echo "=================================================================="
    # Guard against a bare 200 that is not the bridge contract.
    if ! grep -Eq '"success"[[:space:]]*:[[:space:]]*true' /tmp/bridge-health.body; then
      dump_logs_and_fail "/health 200 but body is not the bridge success envelope"
    fi
    if ! grep -Eq '"status"[[:space:]]*:[[:space:]]*"ok"' /tmp/bridge-health.body; then
      dump_logs_and_fail "/health 200 but body missing status:ok"
    fi
    echo "==> boot smoke PASSED"
    exit 0
  fi

  sleep 1
done

dump_logs_and_fail "timed out after ${TIMEOUT_SECS}s waiting for /health 200 (last HTTP code: ${last_code})"
