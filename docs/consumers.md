# Consumers

Current downstream consumers should depend on the published package:

- SSOT delivery: the Bazel module `tummycrypt_scheduling_bridge` via
  `tinyland-inc/bazel-registry`
- derived npm-style route: GitHub Packages `@jesssullivan/scheduling-bridge`,
  built from the Bazel `//:pkg` artifact
- npmjs `@tummycrypt/scheduling-bridge` is retired for new versions and frozen
  at `0.5.11`; existing npmjs consumers (MassageIthaca pins `^0.5.11`) keep
  resolving the frozen versions, and consumer migration is tracked separately
- primary app consumer: `MassageIthaca`
- reusable library peer: `@tummycrypt/scheduling-kit`

Do not vendor this repo into app repositories. App repos should treat the bridge
as a package plus a deployed runtime endpoint. If an app needs Acuity DOM
selectors, browser orchestration, Modal build behavior, or bridge health tuple
interpretation, that belongs here first.

Consumer app configuration should use provider-neutral bridge names such as
`SCHEDULING_BRIDGE_URL` and `SCHEDULING_BRIDGE_AUTH_TOKEN`. `MODAL_*` names may
remain as compatibility aliases during migration, but they should not be used as
the forward app contract.
