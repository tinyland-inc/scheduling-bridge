import {
  runBazel,
  syncDerivedDist,
  syncDerivedKit,
  syncDerivedPackage,
} from './bazel-helpers.mjs';

runBazel('build', '//:pkg', '//:kit_runtime');
syncDerivedPackage();
syncDerivedDist();
syncDerivedKit();

console.log(
  'Materialized local `pkg/`, `dist/`, and `kit/` from Bazel outputs ' +
    '(`bazel-bin/pkg`, `bazel-bin/kit_runtime`).',
);
