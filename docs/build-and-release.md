# Build And Release

The release path is artifact-first.

1. Keep `package.json`, `MODULE.bazel`, and `BUILD.bazel` aligned.
2. Run `pnpm check:release-metadata`.
3. Build the package with `bazel build //:pkg`.
4. Use `pnpm build` when local `pkg/` and `dist/` materialization is needed.
5. Publish from `./bazel-bin/pkg`.
6. Deploy Docker and K8s/container runtimes from the same materialized package
   surface.

## Delivery Doctrine

Package delivery follows one source of truth:

1. The Bzlmod module graph is the canonical (SSOT) delivery mechanism.
   Consumers depend on `tummycrypt_scheduling_bridge` through the
   `tinyland-inc/bazel-registry` registry line already present in `.bazelrc`.
2. GitHub Packages (`@jesssullivan/scheduling-bridge`) is a derived package:
   the out-of-ecosystem alternative route for npm-style consumers, built from
   the same Bazel `//:pkg` output (`./bazel-bin/pkg`) that the module graph
   models.
3. npmjs (`@tummycrypt/scheduling-bridge`) is retired for first-party
   delivery. It is frozen at `0.5.11`, and `npm_publish_mode: disabled` in the
   publish workflow is permanent policy, not a temporary outage. Existing
   npmjs consumers keep resolving the frozen versions; consumer migration is
   tracked separately.

## Commands

```bash
pnpm install --frozen-lockfile
pnpm check:release-metadata
pnpm check:artifact-authority
pnpm typecheck
pnpm test
pnpm build
pnpm check:package
pnpm docs:generate
```

`pnpm typecheck`, `pnpm test`, `pnpm build`, and `pnpm check:package` route
through Bazel so local and CI paths exercise the same package graph.

`pnpm test:host` intentionally bypasses Bazel and runs Vitest under the host
Node selected by CI. Keep it in the package workflow when widening consumer
engine support so the matrix proves the published package can execute on every
advertised downstream major.

For sandboxed local validation where Bazel cannot write its default output root,
set `BAZEL_OUTPUT_USER_ROOT=/tmp/<repo>-bazel-out`.

## Node Policy

The npm package advertises Node 22 and Node 24 consumer support. That is the
downstream contract for apps such as MassageIthaca.

Bridge-owned runtime and artifact authority remains Node 24:

- Bazel Node toolchain
- Nix development shell
- Docker runtime image
- K8s/container runtime image
- npm/GitHub Packages publish runner

Do not collapse these two concerns. Consumer support is broader than the bridge
runtime image, and package CI must prove both supported consumer majors.

## Runtime Provider Policy

K8s/container execution is the accepted next-production bridge route. Modal
is legacy proofing context with automatic deploys disabled and manual dispatch
guarded by explicit acknowledgement. Every provider must consume the same
materialized package and launch the same `dist/server/handler.js` entrypoint.
Provider-specific deployment mechanics must not fork the bridge protocol or
package artifact.

## Bazel Cache Contract

Local Bazel use defaults to the repo-local disk cache in `.bazelrc`:

```bash
bazel build //:pkg
bazel test //:test
```

Contributor machines can opt into a remote cache by adding a private
`user.bazelrc`; this repository intentionally keeps private cache topology out
of public source. CI remote-cache behavior is owned by the shared
`js-bazel-package` workflow and its runner environment. The public contract is
that CI must still publish the Bazel package artifact from `./bazel-bin/pkg`
with local fallback available when the remote cache is unavailable.

## Release Checklist

Before cutting a bridge release, verify these surfaces together:

- Bazel registry entry in `tinyland-inc/bazel-registry` for the new version
  (the SSOT delivery surface)
- GitHub Packages package: `@jesssullivan/scheduling-bridge`, derived from the
  Bazel `//:pkg` artifact
- tag and GitHub release for the package version
- Bazel package artifact from `./bazel-bin/pkg`
- Docker and K8s/container runtime images built from the materialized `pkg/`
  surface
- `/health` release tuple for the deployed bridge
- npmjs stays frozen: `@tummycrypt/scheduling-bridge` is retired at `0.5.11`,
  and `npm_publish_mode: disabled` must remain in the publish workflow

SBOM or package attestation beyond the shared workflow contract is deferred so
this repo does not grow a parallel release authority.

## Nix

Use `nix develop` or `direnv allow` to enter the Node 24, pnpm, Bazelisk,
Playwright, MkDocs, and paper-tooling shell.
