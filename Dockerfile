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
COPY package.json pnpm-lock.yaml ./
COPY pkg/ ./

RUN test -f dist/server/handler.js && \
    pnpm install --prod --frozen-lockfile --ignore-scripts

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
