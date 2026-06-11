# Consumers

Current downstream consumers should depend on the published package:

- npm package: `@tummycrypt/scheduling-bridge`
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
