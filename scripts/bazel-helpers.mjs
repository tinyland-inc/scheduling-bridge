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

export const runBazel = (...args) => {
  const bazel = resolveBazelCommand();
  const outputUserRoot = process.env.BAZEL_OUTPUT_USER_ROOT;
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
