#!/usr/bin/env bash
# Classify the current Bazel cache/executor attachment without running Bazel.
#
# Generalized from MassageIthaca/scripts/cache-attachment-contract.sh (the merged,
# GF#889-proven shape) into a shared ci-templates entrypoint so any spoke can
# fail closed before a cache-backed Bazel invocation.
#
# Naming aligns with the TIN-2108 in-flight scripts (GF_BAZEL_SUBSTRATE_MODE;
# modes compatibility-local-only / shared-cache-backed / executor-backed) for
# easy convergence, while the fail-closed endpoint validation mirrors the proven
# MI logic verbatim.
#
# Classification:
#   BAZEL_REMOTE_EXECUTOR set  => executor-backed   (out of scope this lane; classified, never selected)
#   else BAZEL_REMOTE_CACHE set => shared-cache-backed
#   else                        => compatibility-local-only
#
# Fail-closed (exit 1) when:
#   - either endpoint contains a literal ${...} placeholder (unexpanded secret/var)
#   - either endpoint does not start with grpc://, grpcs://, http://, or https://
#   - localhost/127.0.0.1/::1 endpoint without GF_BAZEL_ALLOW_LOCALHOST_PROOF=true
#   - executor set without a cache endpoint
#   - executor != cache unless GF_BAZEL_ALLOW_SEPARATE_EXECUTOR_CACHE=true
#   - declared GF_BAZEL_SUBSTRATE_MODE disagreeing with endpoint presence
#   - --strict with an empty BAZEL_REMOTE_CACHE

set -euo pipefail

STRICT=false

usage() {
  cat >&2 <<'EOF'
Usage: scripts/cache-attachment-contract.sh [--strict]

Without --strict this reports whether the current shell is
compatibility-local-only, shared-cache-backed, or executor-backed. With --strict
it requires a real BAZEL_REMOTE_CACHE endpoint before cache-backed Bazel work
may run (the fail-closed gate for the cache-backed lane).

Environment:
  BAZEL_REMOTE_CACHE        Shared Bazel remote cache endpoint (grpc/grpcs/http/https).
  BAZEL_REMOTE_EXECUTOR     Optional remote executor endpoint. Classified as
                            executor-backed but NOT selected by the cache-first lane.
  GF_BAZEL_SUBSTRATE_MODE   Optional declared mode; must agree with endpoint presence.
  GF_BAZEL_ALLOW_LOCALHOST_PROOF
                            Set true to permit a localhost endpoint (explicit proof only).
  GF_BAZEL_ALLOW_SEPARATE_EXECUTOR_CACHE
                            Set true to permit executor != cache (default: GF REAPI cell
                            uses one endpoint for both).
EOF
}

for arg in "$@"; do
  case "${arg}" in
  --strict)
    STRICT=true
    ;;
  -h | --help)
    usage
    exit 0
    ;;
  *)
    usage
    exit 2
    ;;
  esac
done

remote_cache="${BAZEL_REMOTE_CACHE:-}"
remote_executor="${BAZEL_REMOTE_EXECUTOR:-}"
mode="${GF_BAZEL_SUBSTRATE_MODE:-}"

if [[ -n ${remote_executor} ]]; then
  expected_mode="executor-backed"
elif [[ -n ${remote_cache} ]]; then
  expected_mode="shared-cache-backed"
else
  expected_mode="compatibility-local-only"
fi

if [[ -z ${mode} ]]; then
  effective_mode="${expected_mode}"
else
  effective_mode="${mode}"
fi

context="developer-machine"
if [[ ${GITHUB_ACTIONS:-} == "true" ]]; then
  context="github-actions"
elif [[ -n ${CI:-} ]]; then
  context="ci"
fi

literal_cache=false
if [[ ${remote_cache} == *'${'* ]] || [[ ${remote_cache} == *'}'* ]]; then
  literal_cache=true
fi

literal_executor=false
if [[ ${remote_executor} == *'${'* ]] || [[ ${remote_executor} == *'}'* ]]; then
  literal_executor=true
fi

unsupported_cache=false
if [[ -n ${remote_cache} ]] && [[ ! ${remote_cache} =~ ^(grpc|grpcs|http|https):// ]]; then
  unsupported_cache=true
fi

unsupported_executor=false
if [[ -n ${remote_executor} ]] && [[ ! ${remote_executor} =~ ^(grpc|grpcs|http|https):// ]]; then
  unsupported_executor=true
fi

endpoint_is_localhost() {
  local endpoint="$1"
  local host
  host="${endpoint#*://}"
  host="${host%%/*}"
  host="${host%%:*}"
  host="${host#[}"
  host="${host%]}"
  case "${host}" in
  localhost | 127.0.0.1 | ::1 | 0.0.0.0) return 0 ;;
  *) return 1 ;;
  esac
}

allow_localhost="${GF_BAZEL_ALLOW_LOCALHOST_PROOF:-false}"
localhost_cache=false
if [[ -n ${remote_cache} ]] && endpoint_is_localhost "${remote_cache}"; then
  localhost_cache=true
fi
localhost_executor=false
if [[ -n ${remote_executor} ]] && endpoint_is_localhost "${remote_executor}"; then
  localhost_executor=true
fi

cat <<EOF
Bazel Cache Attachment
======================
Context:            ${context}
Bazel mode:         ${effective_mode}
Bazel remote cache: ${remote_cache:-unset}
Bazel executor:     ${remote_executor:-unset}
Expected mode:      ${expected_mode}
Strict:             ${STRICT}

Contract:
- cache-backed work gets its endpoint from BAZEL_REMOTE_CACHE
- executor-backed work gets BAZEL_REMOTE_EXECUTOR and uses BAZEL_REMOTE_CACHE
  as the CAS/action-cache authority; current GF lanes use the REAPI cell for both
  (executor-backed is classified here but NOT selected by the cache-first lane)
- the consumer .bazelrc keeps cache/executor endpoints out of checked-in defaults
- empty BAZEL_REMOTE_CACHE means compatibility-local-only; cache-backed
  entrypoints refuse it
EOF

if [[ ${effective_mode} != "${expected_mode}" ]]; then
  echo
  echo "ERROR: GF_BAZEL_SUBSTRATE_MODE=${effective_mode} disagrees with endpoint presence (expected ${expected_mode})."
  exit 1
fi

if [[ ${literal_cache} == "true" ]]; then
  echo
  echo "ERROR: BAZEL_REMOTE_CACHE is a literal shell placeholder, not a real endpoint."
  exit 1
fi

if [[ ${literal_executor} == "true" ]]; then
  echo
  echo "ERROR: BAZEL_REMOTE_EXECUTOR is a literal shell placeholder, not a real endpoint."
  exit 1
fi

if [[ ${unsupported_cache} == "true" ]]; then
  echo
  echo "ERROR: BAZEL_REMOTE_CACHE must start with grpc://, grpcs://, http://, or https://."
  exit 1
fi

if [[ ${unsupported_executor} == "true" ]]; then
  echo
  echo "ERROR: BAZEL_REMOTE_EXECUTOR must start with grpc://, grpcs://, http://, or https://."
  exit 1
fi

if [[ ${localhost_cache} == "true" && ${allow_localhost} != "true" ]]; then
  echo
  echo "ERROR: BAZEL_REMOTE_CACHE points at localhost. Set GF_BAZEL_ALLOW_LOCALHOST_PROOF=true only with explicit proof; the shared lane expects the cluster cache endpoint."
  exit 1
fi

if [[ ${localhost_executor} == "true" && ${allow_localhost} != "true" ]]; then
  echo
  echo "ERROR: BAZEL_REMOTE_EXECUTOR points at localhost. Set GF_BAZEL_ALLOW_LOCALHOST_PROOF=true only with explicit proof."
  exit 1
fi

if [[ -n ${remote_executor} && -z ${remote_cache} ]]; then
  echo
  echo "ERROR: executor-backed mode requires BAZEL_REMOTE_CACHE."
  exit 1
fi

if [[ -n ${remote_executor} && -n ${remote_cache} &&
  ${remote_cache} != "${remote_executor}" &&
  ${GF_BAZEL_ALLOW_SEPARATE_EXECUTOR_CACHE:-false} != "true" ]]; then
  echo
  echo "ERROR: executor-backed mode requires BAZEL_REMOTE_CACHE to match BAZEL_REMOTE_EXECUTOR for the GloriousFlywheel REAPI cell."
  exit 1
fi

if [[ ${STRICT} == "true" && -z ${remote_cache} ]]; then
  echo
  echo "ERROR: strict mode requires BAZEL_REMOTE_CACHE to be set."
  exit 1
fi

echo
echo "Status: ${expected_mode}"
