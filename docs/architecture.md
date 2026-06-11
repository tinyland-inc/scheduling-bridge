# Architecture

The bridge wraps Acuity's public booking UI behind a stable HTTP contract.

```text
HTTP request
-> src/server/handler.ts
-> shared service catalog resolution
-> Acuity wizard steps
-> browser/page lifecycle layer
-> Playwright against Acuity
```

The important boundary is ownership: this repo owns the remote automation
service, not the downstream application UX. Consumer apps should call the
published package and deployed bridge endpoint instead of copying selector,
browser, Modal, or Acuity DOM logic.

Effect is useful here because browser and page lifecycle are real resource
management problems. Keep that usage near lifecycle, retry, and orchestration
boundaries; do not add abstraction where synchronous code is clearer.
