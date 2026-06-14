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
#   BAZEL_REMOTE_EXECUTOR set  => executor-backed   (DEFINED + ENFORCED; never selected by any current repo)
#   else BAZEL_REMOTE_CACHE set => shared-cache-backed
#   else                        => compatibility-local-only
#
# The DECLARED mode is GF_BAZEL_SUBSTRATE_MODE. TIN-2109 makes this manifest-driven:
# the cache-backed lane reads tinyland.repo.json `enrollment.substrateMode` and
# exports it as GF_BAZEL_SUBSTRATE_MODE so the manifest is the AUTHORITATIVE
# expected mode. Declared-vs-actual is the effective_mode != expected_mode check.
#
# Fail-closed (exit 1) when:
#   - either endpoint contains a literal ${...} placeholder (unexpanded secret/var)
#   - either endpoint does not start with grpc://, grpcs://, http://, or https://
#   - localhost/127.0.0.1/::1 endpoint without GF_BAZEL_ALLOW_LOCALHOST_PROOF=true
#   - executor set without a cache endpoint
#   - executor != cache unless GF_BAZEL_ALLOW_SEPARATE_EXECUTOR_CACHE=true
#   - declared GF_BAZEL_SUBSTRATE_MODE disagreeing with endpoint presence
#   - --strict with an empty BAZEL_REMOTE_CACHE
#   - (TIN-2109) --strict on a hosted / repo-shaped runner: a missing substrate is a
#     deterministic failure, never a silent degrade to a GitHub-hosted build. Gated by
#     GF_BAZEL_RUNNER_LABELS; reject ubuntu-*/windows-*/macos-*/bare self-hosted and any
#     repo-shaped <name>-nix* label. Override only with GF_BAZEL_ALLOW_HOSTED_RUNNER=true.
#   - (TIN-2109) declared/effective mode executor-backed without the FULL executor
#     contract: BAZEL_REMOTE_EXECUTOR + BAZEL_REMOTE_CACHE + a cluster runner class +
#     a proof-artifact image digest (GF_BAZEL_REAPI_PROOF_IMAGE_DIGEST). This contract
#     is DEFINED + ENFORCED but selected by no current repo (cache-first / Option D).

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
  GF_BAZEL_RUNNER_LABELS    Optional comma/space-separated runner labels. When set under
                            --strict the gate REJECTS hosted (ubuntu-*/windows-*/macos-*),
                            bare self-hosted, and repo-shaped (<name>-nix*) labels so a
                            missing substrate fails closed instead of degrading to a
                            GitHub-hosted build. Cluster classes: tinyland-nix,
                            tinyland-nix-heavy, tinyland-nix-kvm, tinyland-nix-gpu,
                            tinyland-docker, tinyland-dind.
  GF_BAZEL_ALLOW_HOSTED_RUNNER
                            Set true to bypass the hosted/repo-label rejection (explicit
                            escape hatch only; the shared lane never enables it).
  GF_BAZEL_REAPI_PROOF_IMAGE_DIGEST
                            Digest-pinned REAPI worker image. REQUIRED when the declared/
                            effective mode is executor-backed (proof-artifact wiring).
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

# --- TIN-2109: runner-class classification (reject hosted / repo-label fallback) ---
# Cluster capability classes accepted for substrate-backed work. Anything else
# (GitHub-hosted, bare self-hosted, or a repo-shaped <name>-nix* label) is a
# silent-degrade vector and must fail closed in --strict.
runner_labels_raw="${GF_BAZEL_RUNNER_LABELS:-}"
allow_hosted_runner="${GF_BAZEL_ALLOW_HOSTED_RUNNER:-false}"
runner_class=""
runner_reject_reason=""
is_cluster_label() {
  case "$1" in
  tinyland-nix | tinyland-nix-heavy | tinyland-nix-kvm | tinyland-nix-gpu | tinyland-docker | tinyland-dind)
    return 0 ;;
  *) return 1 ;;
  esac
}
classify_runner() {
  # Sets runner_class to the first cluster-class label found. If none, sets
  # runner_reject_reason to the first disqualifying label (hosted / bare
  # self-hosted / repo-shaped), else leaves both empty (no labels supplied).
  local raw="$1"
  raw="${raw//,/ }"
  local label
  for label in ${raw}; do
    if is_cluster_label "${label}"; then
      runner_class="${label}"
      return 0
    fi
  done
  for label in ${raw}; do
    case "${label}" in
    ubuntu-* | windows-* | macos-* | ubuntu | windows | macos)
      runner_reject_reason="hosted GitHub runner label '${label}'"
      return 0
      ;;
    self-hosted)
      runner_reject_reason="bare 'self-hosted' label (no capability class)"
      return 0
      ;;
    *-nix | *-nix-* | *-docker | *-dind)
      runner_reject_reason="repo-shaped runner label '${label}' (not a shared tinyland capability class)"
      return 0
      ;;
    esac
  done
  if [[ -n ${raw// /} ]]; then
    runner_reject_reason="no tinyland capability-class label in '${raw}'"
  fi
}
if [[ -n ${runner_labels_raw} ]]; then
  classify_runner "${runner_labels_raw}"
fi

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
Runner class:       ${runner_class:-${runner_labels_raw:+unclassified (${runner_labels_raw})}}
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

# TIN-2109: reject hosted / repo-shaped runner fallback under --strict. A
# missing substrate must be a deterministic failure, never a silent degrade to a
# GitHub-hosted build. Only enforced when runner labels are supplied AND --strict
# is on, so non-cache-backed callers stay unaffected.
if [[ ${STRICT} == "true" && -n ${runner_labels_raw} && -z ${runner_class} &&
  ${allow_hosted_runner} != "true" ]]; then
  echo
  echo "ERROR: strict cache-backed lane refuses to run on ${runner_reject_reason:-a non-cluster runner}. The substrate must attach on a shared tinyland capability-class runner (tinyland-nix, tinyland-nix-heavy, tinyland-nix-kvm, tinyland-nix-gpu, tinyland-docker, tinyland-dind). Hosted/repo-label fallback is rejected; set GF_BAZEL_ALLOW_HOSTED_RUNNER=true only with explicit non-shared-lane justification."
  exit 1
fi

# TIN-2109: executor-backed contract. When the declared/effective mode is
# executor-backed, the FULL contract is required and any missing piece fails
# closed. This is DEFINED + ENFORCED here but selected by NO current repo
# (cache-first / TIN-1997 Option D); kit/bridge declare shared-cache-backed.
if [[ ${effective_mode} == "executor-backed" || -n ${remote_executor} ]]; then
  if [[ -z ${remote_executor} ]]; then
    echo
    echo "ERROR: declared substrateMode=executor-backed requires BAZEL_REMOTE_EXECUTOR (the REAPI executor endpoint)."
    exit 1
  fi
  if [[ -z ${remote_cache} ]]; then
    echo
    echo "ERROR: executor-backed mode requires BAZEL_REMOTE_CACHE (the CAS/action-cache authority)."
    exit 1
  fi
  if [[ -n ${runner_labels_raw} && -z ${runner_class} && ${allow_hosted_runner} != "true" ]]; then
    echo
    echo "ERROR: executor-backed mode requires a cluster runner class for platform identity (@gloriousflywheel//platforms:linux-x86_64); got ${runner_reject_reason:-no capability-class label}."
    exit 1
  fi
  if [[ -z ${GF_BAZEL_REAPI_PROOF_IMAGE_DIGEST:-} ]]; then
    echo
    echo "ERROR: executor-backed mode requires GF_BAZEL_REAPI_PROOF_IMAGE_DIGEST (the digest-pinned REAPI worker image for proof-artifact wiring). The flywheel-reapi-proof authority must publish evidence with remote_processes > 0 and a worker_image_digest before a target class is proved."
    exit 1
  fi
fi

if [[ ${STRICT} == "true" && -z ${remote_cache} ]]; then
  echo
  echo "ERROR: strict mode requires BAZEL_REMOTE_CACHE to be set."
  exit 1
fi

echo
echo "Status: ${expected_mode}"
