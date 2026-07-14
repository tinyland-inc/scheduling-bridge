import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');

export const rootPath = (...segments) => path.join(repoRoot, ...segments);

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    ...options,
  });

  if (result.error) {
    return result;
  }

  if (typeof result.status === 'number' && result.status !== 0) {
    process.exit(result.status);
  }

  return result;
};

export const resolveBazelCommand = () => {
  for (const candidate of ['bazel', 'bazelisk']) {
    const probe = spawnSync(candidate, ['version'], {
      cwd: repoRoot,
      stdio: 'ignore',
    });

    if (!probe.error && probe.status === 0) {
      return {
        command: candidate,
        prefixArgs: [],
      };
    }
  }

  return {
    command: 'npx',
    prefixArgs: ['--yes', '@bazel/bazelisk'],
  };
};

// Resolve the Bazel output_user_root for npm-script-driven Bazel invocations
// (pnpm test / typecheck / check:package). In CI these run BEFORE the
// ci-templates cache-backed validate step in the same workspace. If they shared
// the default Bazel output base, their warm local action cache would satisfy
// the cache-backed step's targets and the shared remote cache would never be
// queried — a NOMINAL (local/disk-only) result that is NOT enrollment
// (TIN-2110, cache-first / TIN-1997 Option D). To keep the cache-backed lane a
// real over-the-wire attach, the npm-script Bazel server is isolated into a
// dedicated output base in CI so the cache-backed step (which invokes
// `bazelisk build` directly on the DEFAULT base) starts cold and fetches from
// the shared remote cache. Local dev is unchanged (default base, no env set).
const resolveOutputUserRoot = () => {
  if (process.env.BAZEL_OUTPUT_USER_ROOT) {
    return process.env.BAZEL_OUTPUT_USER_ROOT;
  }
  if (process.env.GITHUB_ACTIONS === 'true' || process.env.CI) {
    const base =
      process.env.RUNNER_TEMP || process.env.TMPDIR || process.env.TMP || '/tmp';
    return path.join(base, 'bazel-npm-script-output-root');
  }
  return undefined;
};

export const runBazel = (...args) => {
  const bazel = resolveBazelCommand();
  const outputUserRoot = resolveOutputUserRoot();
  const startupArgs = outputUserRoot ? [`--output_user_root=${outputUserRoot}`] : [];
  const result = run(bazel.command, [...bazel.prefixArgs, ...startupArgs, ...args]);

  if (result.error) {
    fail(result.error.message);
  }
};

export const runNode = (...args) => {
  const result = run('node', args);

  if (result.error) {
    fail(result.error.message);
  }
};

export const syncDerivedDist = () => {
  const sourceDist = rootPath('bazel-bin', 'pkg', 'dist');
  const targetDist = rootPath('dist');

  if (!existsSync(sourceDist)) {
    fail(`Expected Bazel-derived dist at ${sourceDist}`);
  }

  rmSync(targetDist, { force: true, recursive: true });
  cpSync(sourceDist, targetDist, { recursive: true });
};

export const syncDerivedPackage = () => {
  const sourcePkg = rootPath('bazel-bin', 'pkg');
  const targetPkg = rootPath('pkg');

  if (!existsSync(rootPath('bazel-bin', 'pkg', 'package.json'))) {
    fail(`Expected Bazel-derived package at ${sourcePkg}`);
  }

  rmSync(targetPkg, { force: true, recursive: true });
  cpSync(sourcePkg, targetPkg, { recursive: true });
};

// Materialize the Bazel-resolved @tummycrypt/scheduling-kit package onto disk so
// the runtime images (Docker/Modal) can copy it into node_modules. The kit is
// supplied ONLY from the Bzlmod module graph (//:kit_runtime -> the kit's
// //:pkg), never npm: it is a required peerDependency (^0.11.1) but npmjs is
// frozen at 0.8.0 and .npmrc keeps auto-install-peers=false, so the runtime
// `pnpm install --prod` never resolves it. Without this the container crashloops
// at boot with ERR_MODULE_NOT_FOUND '@tummycrypt/scheduling-kit'.
export const syncDerivedKit = () => {
  const sourceKit = rootPath('bazel-bin', 'kit_runtime');
  const targetKit = rootPath('kit');

  if (!existsSync(path.join(sourceKit, 'package.json'))) {
    fail(`Expected Bazel-derived kit (package.json at root) at ${sourceKit}`);
  }

  rmSync(targetKit, { force: true, recursive: true });
  cpSync(sourceKit, targetKit, { recursive: true });
};
