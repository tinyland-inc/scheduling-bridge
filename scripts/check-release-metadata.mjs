import { readFileSync } from 'node:fs';

const read = (relativePath) =>
  readFileSync(new URL(relativePath, import.meta.url), 'utf8');

const packageJson = JSON.parse(read('../package.json'));
const moduleBazel = read('../MODULE.bazel');
const buildBazel = read('../BUILD.bazel');
const flakeNix = read('../flake.nix');
const ciWorkflow = read('../.github/workflows/ci.yml');
const publishWorkflow = read('../.github/workflows/publish.yml');
const deployModalWorkflow = read('../.github/workflows/deploy-modal.yml');
const dockerfile = read('../Dockerfile');
const modalApp = read('../modal-app.py');
const expectedPnpmVersion = packageJson.packageManager?.replace(/^pnpm@/, '');
const expectedRepositoryUrl = 'git+https://github.com/Jesssullivan/scheduling-bridge.git';
const expectedHomepage = 'https://github.com/Jesssullivan/scheduling-bridge';
const expectedBugsUrl = 'https://github.com/Jesssullivan/scheduling-bridge/issues';
const expectedPackageBasename = packageJson.name.split('/').at(-1);
const expectedRepositoryOwner = new URL(expectedRepositoryUrl.replace(/^git\+/, ''))
  .pathname.split('/')
  .filter(Boolean)[0]
  .toLowerCase();
const expectedGitHubPackageName = `@${expectedRepositoryOwner}/${expectedPackageBasename}`;

const extract = (source, pattern, label) => {
  const match = source.match(pattern);
  if (!match?.[1]) {
    throw new Error(`Unable to find ${label}`);
  }
  return match[1];
};

const parseMajor = (value, label) => {
  const match = String(value).match(/(\d+)/);
  if (!match?.[1]) {
    throw new Error(`Unable to parse ${label}`);
  }
  return Number(match[1]);
};

const scalar = (value) =>
  value
    .trim()
    .replace(/^(['"])(.*)\1\s*(?:#.*)?$/, '$2')
    .replace(/\s+#.*$/, '')
    .trim();

const parseSupportedNodeMajors = (engineRange) => {
  const majors = new Set();

  for (const rawClause of engineRange.split('||')) {
    const clause = rawClause.trim();
    const caret = clause.match(/^\^(\d+)\.0\.0$/);
    if (caret?.[1]) {
      majors.add(caret[1]);
      continue;
    }

    const bounded = clause.match(/^>=(\d+)\s+<(\d+)$/);
    if (bounded?.[1] && bounded?.[2]) {
      const lower = Number(bounded[1]);
      const upper = Number(bounded[2]);
      for (let major = lower; major < upper; major += 1) {
        majors.add(String(major));
      }
      continue;
    }

    throw new Error(`Unsupported node engines clause "${clause}" in "${engineRange}"`);
  }

  const sorted = Array.from(majors).sort((a, b) => Number(a) - Number(b));
  if (sorted.length === 0) {
    throw new Error(`Unsupported node engines range "${engineRange}"`);
  }

  return {
    lower: Number(sorted[0]),
    majors: sorted,
  };
};

const supportedNodeMajors = parseSupportedNodeMajors(packageJson.engines.node);
const minimumConsumerNodeMajor = String(supportedNodeMajors.lower);
const nodeTypesMajor = parseMajor(
  packageJson.devDependencies['@types/node'],
  '@types/node version',
);
const bazelNodeVersion = extract(
  moduleBazel,
  /node\.toolchain\(node_version = "([^"]+)"/,
  'node toolchain version',
);
const bazelNodeMajor = parseMajor(bazelNodeVersion, 'Bazel node toolchain version');
const flakeNodeMajor = parseMajor(
  extract(flakeNix, /\bnodejs_(\d+)\b/, 'flake Node package'),
  'flake Node package',
);
const ciNodeVersions = JSON.parse(
  extract(ciWorkflow, /node_versions:\s*'(\[[^\n]+\])'/, 'CI node versions'),
);
const publishNodeVersions = JSON.parse(
  extract(publishWorkflow, /node_versions:\s*'(\[[^\n]+\])'/, 'publish node versions'),
);
const ciPublishNodeVersion = extract(
  ciWorkflow,
  /publish_node_version:\s*"([^"]+)"/,
  'CI publish node version',
);
const ciBuildCommand = extract(
  ciWorkflow,
  /build_command:\s*([^\n]+)/,
  'CI build command',
);
const publishWorkflowNodeVersion = extract(
  publishWorkflow,
  /publish_node_version:\s*"([^"]+)"/,
  'publish workflow node version',
);
const publishBuildCommand = extract(
  publishWorkflow,
  /build_command:\s*([^\n]+)/,
  'publish workflow build command',
);
const dockerNodeMajor = parseMajor(
  extract(dockerfile, /setup_(\d+)\.x/, 'Docker NodeSource major'),
  'Docker NodeSource major',
);
const modalNodeMajor = parseMajor(
  extract(modalApp, /setup_(\d+)\.x/, 'Modal NodeSource major'),
  'Modal NodeSource major',
);
const nodeMajorSupported = (major) => supportedNodeMajors.majors.includes(String(major));
const usesPinnedPackageWorkflow = (workflow) =>
  /uses:\s*tinyland-inc\/ci-templates\/\.github\/workflows\/js-bazel-package\.yml@[0-9a-fA-F]{40}/.test(
    workflow,
  );
const hasWorkflowConcurrency = (workflow) => /\nconcurrency:\n/.test(workflow);
const doesNotInheritAllSecrets = (workflow) => !/secrets:\s*inherit/.test(workflow);

const checks = [
  {
    label: 'MODULE.bazel version',
    actual: extract(moduleBazel, /module\([\s\S]*?version = "([^"]+)"/m, 'module version'),
    expected: packageJson.version,
  },
  {
    label: 'BUILD.bazel npm_package version',
    actual: extract(buildBazel, /npm_package\([\s\S]*?version = "([^"]+)"/m, 'npm_package version'),
    expected: packageJson.version,
  },
  {
    label: 'BUILD.bazel npm_package name',
    actual: extract(buildBazel, /npm_package\([\s\S]*?package = "([^"]+)"/m, 'npm_package name'),
    expected: packageJson.name,
  },
  {
    label: 'MODULE.bazel pnpm version',
    actual: extract(moduleBazel, /pnpm_version = "([^"]+)"/, 'pnpm_version'),
    expected: expectedPnpmVersion,
  },
  {
    label: 'package.json repository',
    actual: packageJson.repository?.url,
    expected: expectedRepositoryUrl,
  },
  {
    label: 'package.json homepage',
    actual: packageJson.homepage,
    expected: expectedHomepage,
  },
  {
    label: 'package.json bugs URL',
    actual: packageJson.bugs?.url,
    expected: expectedBugsUrl,
  },
  {
    label: 'MODULE.bazel Node major is supported',
    actual: String(nodeMajorSupported(bazelNodeMajor)),
    expected: 'true',
  },
  {
    label: 'flake Node major is supported',
    actual: String(nodeMajorSupported(flakeNodeMajor)),
    expected: 'true',
  },
  {
    label: 'Docker Node major is supported',
    actual: String(nodeMajorSupported(dockerNodeMajor)),
    expected: 'true',
  },
  {
    label: 'Modal Node major is supported',
    actual: String(nodeMajorSupported(modalNodeMajor)),
    expected: 'true',
  },
  {
    label: '@types/node major matches minimum consumer Node',
    actual: String(nodeTypesMajor),
    expected: minimumConsumerNodeMajor,
  },
  {
    label: 'CI node versions',
    actual: JSON.stringify(ciNodeVersions),
    expected: JSON.stringify(supportedNodeMajors.majors),
  },
  {
    label: 'publish workflow node versions are supported',
    actual: String(publishNodeVersions.every(nodeMajorSupported)),
    expected: 'true',
  },
  {
    label: 'CI publish node version is supported',
    actual: String(nodeMajorSupported(ciPublishNodeVersion)),
    expected: 'true',
  },
  {
    label: 'publish workflow node version is supported',
    actual: String(nodeMajorSupported(publishWorkflowNodeVersion)),
    expected: 'true',
  },
  {
    label: 'CI build command',
    actual: scalar(ciBuildCommand),
    expected: 'node scripts/check-artifact-authority.mjs',
  },
  {
    label: 'publish workflow build command',
    actual: scalar(publishBuildCommand),
    expected: 'node scripts/check-artifact-authority.mjs',
  },
  {
    label: 'CI reusable workflow pin',
    actual: String(usesPinnedPackageWorkflow(ciWorkflow)),
    expected: 'true',
  },
  {
    label: 'CI contents permission',
    actual: scalar(extract(ciWorkflow, /contents:\s*([^\n]+)/, 'CI contents permission')),
    expected: 'read',
  },
  {
    label: 'CI concurrency',
    actual: String(hasWorkflowConcurrency(ciWorkflow)),
    expected: 'true',
  },
  {
    label: 'CI least privilege secrets',
    actual: String(doesNotInheritAllSecrets(ciWorkflow)),
    expected: 'true',
  },
  {
    label: 'CI runner mode',
    actual: scalar(extract(ciWorkflow, /runner_mode:\s*([^\n]+)/, 'CI runner_mode')),
    expected: 'shared',
  },
  {
    label: 'CI publish mode',
    actual: scalar(extract(ciWorkflow, /publish_mode:\s*([^\n]+)/, 'CI publish_mode')),
    expected: 'same_runner',
  },
  {
    label: 'CI package artifact path',
    actual: scalar(extract(ciWorkflow, /package_dir:\s*([^\n]+)/, 'CI package_dir')),
    expected: './bazel-bin/pkg',
  },
  {
    label: 'CI npm provenance intent',
    actual: scalar(
      extract(ciWorkflow, /npm_publish_provenance:\s*([^\n]+)/, 'CI npm provenance'),
    ),
    expected: 'true',
  },
  {
    label: 'CI Bazel package target',
    actual: extract(ciWorkflow, /bazel_targets:\s*"([^"]+)"/, 'CI bazel_targets').includes(
      '//:pkg',
    )
      ? 'present'
      : '<missing>',
    expected: 'present',
  },
  {
    label: 'CI GitHub Packages name',
    actual: extract(ciWorkflow, /github_package_name:\s*"([^"]+)"/, 'CI github_package_name'),
    expected: expectedGitHubPackageName,
  },
  {
    label: 'publish reusable workflow pin',
    actual: String(usesPinnedPackageWorkflow(publishWorkflow)),
    expected: 'true',
  },
  {
    label: 'publish concurrency',
    actual: String(hasWorkflowConcurrency(publishWorkflow)),
    expected: 'true',
  },
  {
    label: 'publish packages permission',
    actual: scalar(
      extract(publishWorkflow, /packages:\s*([^\n]+)/, 'publish packages permission'),
    ),
    expected: 'write',
  },
  {
    label: 'publish provenance permission',
    actual: scalar(
      extract(publishWorkflow, /id-token:\s*([^\n]+)/, 'publish id-token permission'),
    ),
    expected: 'write',
  },
  {
    label: 'publish package artifact path',
    actual: scalar(extract(publishWorkflow, /package_dir:\s*([^\n]+)/, 'publish package_dir')),
    expected: './bazel-bin/pkg',
  },
  {
    label: 'publish npm provenance',
    actual: scalar(
      extract(
        publishWorkflow,
        /npm_publish_provenance:\s*([^\n]+)/,
        'publish npm provenance',
      ),
    ),
    expected: 'true',
  },
  {
    label: 'publish Bazel package target',
    actual: extract(
      publishWorkflow,
      /bazel_targets:\s*"([^"]+)"/,
      'publish bazel_targets',
    ).includes('//:pkg')
      ? 'present'
      : '<missing>',
    expected: 'present',
  },
  {
    label: 'publish GitHub Packages name',
    actual: extract(publishWorkflow, /github_package_name:\s*"([^"]+)"/, 'publish github_package_name'),
    expected: expectedGitHubPackageName,
  },
  {
    label: 'Docker artifact input',
    actual: dockerfile.includes('COPY pkg/ ./') ? 'pkg' : '<missing>',
    expected: 'pkg',
  },
  {
    label: 'Docker install mode',
    actual: dockerfile.includes('pnpm install --prod --frozen-lockfile --ignore-scripts')
      ? 'artifact-runtime'
      : '<missing>',
    expected: 'artifact-runtime',
  },
  {
    label: 'Docker source build removed',
    actual: dockerfile.includes('pnpm build') || dockerfile.includes('COPY src/')
      ? 'source-build'
      : 'artifact-only',
    expected: 'artifact-only',
  },
  {
    label: 'Modal artifact input',
    actual: modalApp.includes('.add_local_dir("pkg", "/app", copy=True)') ? 'pkg' : '<missing>',
    expected: 'pkg',
  },
  {
    label: 'Modal install mode',
    actual: modalApp.includes('pnpm install --prod --frozen-lockfile --ignore-scripts')
      ? 'artifact-runtime'
      : '<missing>',
    expected: 'artifact-runtime',
  },
  {
    label: 'Modal source build removed',
    actual: modalApp.includes('cd /app && pnpm build') || modalApp.includes('.add_local_dir("src"')
      ? 'source-build'
      : 'artifact-only',
    expected: 'artifact-only',
  },
  {
    label: 'Deploy Modal workflow build step',
    actual: deployModalWorkflow.includes('Materialize Bazel-derived runtime package')
      && deployModalWorkflow.includes('run: pnpm build')
      ? 'present'
      : '<missing>',
    expected: 'present',
  },
];

const failures = checks.filter((check) => check.actual !== check.expected);

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(
      `${failure.label} mismatch: expected "${failure.expected}", found "${failure.actual}"`,
    );
  }
  process.exit(1);
}

console.log(
  `release metadata aligned for ${packageJson.name}@${packageJson.version} (pnpm ${expectedPnpmVersion}, Node ${packageJson.engines.node}, Bazel Node ${bazelNodeVersion})`,
);
