"""
Modal Labs deployment for the scheduling bridge server.

Runs the Node.js bridge server with Playwright + Chromium
inside a Modal container with GPU-free compute.

Usage:
    modal deploy modal-app.py              # Deploy to Modal
    modal serve modal-app.py               # Local dev with hot reload
    modal run modal-app.py                 # One-shot test run

Environment variables (set in Modal dashboard or .env):
    AUTH_TOKEN           - Required Bearer token for all endpoints
    ACUITY_BASE_URL      - Acuity scheduling URL
    ACUITY_BYPASS_COUPON - 100% gift certificate code
    PLAYWRIGHT_HEADLESS  - Browser headless mode (default: true)
    PLAYWRIGHT_TIMEOUT   - Page timeout in ms (default: 30000)
"""

import os

import modal

APP_NAME = os.environ.get("MODAL_APP_NAME", "scheduling-middleware")
RELEASE_SHA = os.environ.get("MIDDLEWARE_RELEASE_SHA", "local")
RELEASE_REF = os.environ.get("MIDDLEWARE_RELEASE_REF", "local")
RELEASE_VERSION = os.environ.get("MIDDLEWARE_RELEASE_VERSION", "local")
RELEASE_BUILT_AT = os.environ.get("MIDDLEWARE_RELEASE_BUILT_AT", "")

app = modal.App(APP_NAME)

# Base image: Playwright's official image with Chromium pre-installed
image = (
    modal.Image.from_registry(
        "mcr.microsoft.com/playwright:v1.58.2-noble",
        add_python="3.12",
    )
    .env({
        "MIDDLEWARE_RELEASE_SHA": RELEASE_SHA,
        "MIDDLEWARE_RELEASE_REF": RELEASE_REF,
        "MIDDLEWARE_RELEASE_VERSION": RELEASE_VERSION,
        "MIDDLEWARE_RELEASE_BUILT_AT": RELEASE_BUILT_AT,
    })
    .run_commands(
        # Normalize to the same Node major used by Bazel and CI.
        "apt-get remove -y nodejs || true",
        "rm -f /usr/local/bin/node /usr/local/bin/npm /usr/local/bin/npx",
        "curl -fsSL https://deb.nodesource.com/setup_24.x | bash -",
        "apt-get install -y nodejs",
        "node --version",
        "corepack enable && corepack prepare pnpm@9.15.9 --activate",
        "apt-get clean && rm -rf /var/lib/apt/lists/*",
    )
    .add_local_file("package.json", "/app/package.json", copy=True)
    .add_local_file("pnpm-lock.yaml", "/app/pnpm-lock.yaml", copy=True)
    .add_local_dir("pkg", "/app", copy=True)
    .run_commands(
        # Runtime image consumes the same Bazel-derived artifact that npm publishes.
        "cd /app && pnpm install --prod --frozen-lockfile --ignore-scripts",
        "ls -la /app/dist/server/handler.js",
    )
)


@app.function(
    image=image,
    # No GPU needed - browser automation only
    cpu=2.0,
    memory=2048,
    # Keep warm for low latency (1 container always ready)
    min_containers=1,
    # 5 minute timeout (wizard can take up to 60s per booking)
    timeout=300,
    secrets=[modal.Secret.from_name("scheduling-middleware-secrets")],
)
@modal.concurrent(max_inputs=3)
@modal.web_server(port=3001, startup_timeout=30)
def server():
    import subprocess

    subprocess.Popen(
        ["node", "dist/server/handler.js"],
        cwd="/app",
        env={
            **__import__("os").environ,
            "NODE_ENV": "production",
            "PORT": "3001",
            "PLAYWRIGHT_HEADLESS": "true",
        },
    )
