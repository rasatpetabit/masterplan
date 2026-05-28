// lib/migrate.mjs — schema read-compat ladder (build step 1; right-size per Resolved #7).
//
// Ordered pure-function chain applied to a bundle on load, original backed up.
//   migrate(state) -> state at the current schema version
// One frozen real bundle per historical version becomes a node:test fixture.
//
// DIAL (decide before this lands): if the installed base is single-version,
// collapse the ladder to a one-shot migrate+backup; keep the multi-rung ladder
// only if multiple in-flight schema versions are confirmed. Don't pre-build rungs
// no user needs.
// TODO(step 1): confirm installed-base versions; implement applicable rungs + tests.
export {};
