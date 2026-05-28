// lib/paths.mjs — single source of truth for filesystem locations (build step 1).
//
// resolveConfigDir() and friends replace the ~17 hardcoded `~/.claude` paths
// scattered through the v7 prose/scripts. Pure, env-driven, node:test'able.
// TODO(step 1): implement resolveConfigDir(), resolveBundleDir(slug), etc. + tests.
export {};
