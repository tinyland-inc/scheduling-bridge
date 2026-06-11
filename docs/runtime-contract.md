# Runtime Contract

`GET /health` is the bridge runtime truth surface.

Downstream apps should use it to verify:

- bridge release SHA, ref, version, and build timestamp
- protocol version
- flow owner
- backend
- transport
- endpoint and capability shape

Package metadata says what a consumer compiled against. `/health` says what the
deployed bridge is actually running. Promotion and beta validation should check
both when claims depend on the live bridge.

## Provider Truth

The bridge contract is provider-agnostic: a Node HTTP server exposing the
protocol endpoints and `/health` tuple.

- K8s/container execution is the accepted next-production bridge route and is
  the current MassageIthaca K8s shadow runtime.
- Modal is legacy proofing context. Automatic Modal deploys are disabled; the
  manual workflow requires explicit acknowledgement while TIN-981 closes the
  surface.
- Provider state, tailnet exposure, and public-edge routing are managed by the
  infrastructure repo.
- Docker is the local/container compatibility target and must mirror the same
  `dist/server/handler.js` entrypoint.
- Consumer apps should name the remote endpoint with `SCHEDULING_BRIDGE_URL`
  and `SCHEDULING_BRIDGE_AUTH_TOKEN`; legacy `MODAL_*` aliases are transition
  compatibility, not the forward contract.
