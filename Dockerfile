# Dockerfile
# Standalone middleware server with Playwright + Chromium
# for running the Acuity wizard automation remotely.
#
# Usage:
#   docker build -t scheduling-bridge .
#   docker run -p 3001:3001 \
#     -e AUTH_TOKEN=... \
#     -e ACUITY_BASE_URL=https://example.as.me \
#     -e ACUITY_BYPASS_COUPON=... \
#     scheduling-bridge
#
FROM mcr.microsoft.com/playwright:v1.58.2-noble

LABEL org.opencontainers.image.source="https://github.com/Jesssullivan/scheduling-bridge"
LABEL org.opencontainers.image.description="Acuity Scheduling middleware with Playwright browser automation"
LABEL org.opencontainers.image.licenses="MIT"
LABEL org.opencontainers.image.title="scheduling-bridge"
LABEL org.opencontainers.image.vendor="tummycrypt"

# Install Node.js 24 + pnpm
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && \
    apt-get install -y nodejs && \
    corepack enable && corepack prepare pnpm@9.15.9 --activate && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy the Bazel-derived package plus lockfile for runtime dependency install.
# .npmrc carries auto-install-peers=false, which must match the lockfile's
# autoInstallPeers setting for frozen installs (the scheduling-kit peer is
# satisfied by the Bazel module graph, not npm).
COPY package.json pnpm-lock.yaml .npmrc ./
COPY pkg/ ./

RUN test -f dist/server/handler.js && \
    pnpm install --prod --frozen-lockfile --ignore-scripts

# Supply @tummycrypt/scheduling-kit from the Bazel module graph — NOT npm.
# The kit is a required peerDependency (^0.11.1) but auto-install-peers=false and
# npmjs is frozen at 0.8.0, so the frozen install above never places it in
# node_modules. The runtime entrypoint eagerly imports the kit
# (dist/core/types.js + the capabilities surface), so without this copy the
# container crashloops at boot with ERR_MODULE_NOT_FOUND. The repo build recipe
# (scripts/build-derived-artifacts.mjs) materializes the Bazel-resolved kit
# (//:kit_runtime) into ./kit — the same artifact-only route as ./pkg; copy it
# in AFTER the frozen install so pnpm cannot prune it as an extraneous package.
COPY kit/ ./node_modules/@tummycrypt/scheduling-kit/

# Fail the build early (not just at container boot) if the kit did not land.
# The end-to-end ESM boot resolution is proven by the docker-ghcr boot smoke.
RUN test -f node_modules/@tummycrypt/scheduling-kit/package.json \
    || (echo "FATAL: @tummycrypt/scheduling-kit missing from node_modules (Bazel kit materialization failed)" >&2; exit 1)

# Non-root user for security
RUN useradd -m -s /bin/bash middleware
USER middleware

EXPOSE 3001

ENV NODE_ENV=production
ENV PORT=3001
ENV PLAYWRIGHT_HEADLESS=true
ENV PLAYWRIGHT_TIMEOUT=30000

HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD wget -qO- --tries=1 http://localhost:3001/health

CMD ["node", "dist/server/handler.js"]
