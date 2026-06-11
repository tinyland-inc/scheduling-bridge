# scheduling-bridge

`scheduling-bridge` is the remote Acuity automation service published as
`@tummycrypt/scheduling-bridge`.

The repo owns browser automation, HTTP bridge endpoints, Docker and
K8s/container runtime packaging, and the bridge runtime truth exposed by
`/health`.

It does not own app deployment, business-specific UI, or reusable
backend-agnostic checkout components. It also does not own cluster state or
public-edge routing. Those are consumer app, infrastructure, and
`scheduling-kit` responsibilities.

## Authority Summary

- Bazel `//:pkg` builds the publishable package artifact.
- `pnpm build` materializes local `pkg/` and `dist/` from `bazel-bin/pkg`.
- CI and publish workflows extract `./bazel-bin/pkg`.
- Docker and K8s/container runtimes consume the materialized `pkg/` artifact
  rather than rebuilding from source inside runtime images.
- K8s/container execution is the accepted next-production bridge route; Modal
  is legacy proofing context with automatic deploys disabled while TIN-981
  closes the surface.
- Generated facts live in `docs/generated/repo-facts.md`.
