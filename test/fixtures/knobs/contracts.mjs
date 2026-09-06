// test/fixtures/knobs/contracts.mjs — the knob contract registry (spec §4.4).
//
// Every non-metadata control surface maps to a two-value behavioral contract proven on a
// CONSUMER-side observable (an mp op's output, a gate, an event, a rendered protocol line for
// prompt-only controls, or a rejected/unknown exit). A seeded state field is NOT an
// observable — that is the inert `--complexity`/`--autonomy` class this work closes.
//
// This file is the single source of truth the harness (test/knob-contract.test.mjs) iterates.
// The AUTHORITATIVE SET of controls is DERIVED, not hand-listed: see discovery.mjs. The
// completeness test requires every derived control to resolve to a contract here or to one of
// the four closed metadata exemptions — so a new flag/config path/env read/emitted state
// field/prompt marker fails by being unmapped, not by a stale hand list.
//
// Entry shape:
//   id        — the control's name (matches the inventory: a flag, a config path, an env var,
//               a seed-state field, or a `<!-- knob: -->` marker).
//   kind      — 'flag' | 'config' | 'env' | 'state' | 'prompt-marker'
//   describe  — one-line human summary used in failure messages.
//   values    — [a, b] the two values to compare.
//   vary      — (input, value) => input spec; must differ from the base input in EXACTLY the
//               one knob the harness proves (the harness diffs the two specs).
//   observe   — async ({ input, fixtures }) => a consumer-side observable VALUE for that input.
//   promptOnly — true only for `<!-- knob: -->` prompt-only controls (a rendered protocol line
//               is the permitted observable). Everything else needs a code-side observable.
import { METADATA_EXEMPTIONS } from './discovery.mjs';

export { METADATA_EXEMPTIONS };

// The flag-registration observable: a REGISTERED flag is accepted by the CLI (reach the verb,
// exit 0), an UNREGISTERED one dies with the A7 fail-closed exit 2. This is a real
// consumer-side difference (rejectUnknownFlags runs before dispatch on every verb), not a
// seeded echo. `values` are ['present', 'absent'] — the registration surface's two states.
export const FLAG_REGISTRATION = {
  id: '__flag_registration__', // synthetic id never used directly; see flagContract()
  describe: 'a registered flag is accepted by the CLI; an unregistered one dies exit 2',
  values: ['present', 'absent'],
  promptOnly: false,
};

// Registry of substantive two-value behavioral contracts. Every DERIVED non-exempt control
// must resolve here or to the generic flag-registration contract (see flagContract below).
export const REGISTRY = [
  // ---- config paths -------------------------------------------------------
  {
    id: 'complexity',
    kind: 'config',
    describe: 'complexity low vs high changes the interview caps (floor/cap)',
    values: ['low', 'high'],
    vary: (input, v) => ({ ...input, complexity: v }),
    promptOnly: false,
    observe: async ({ input, fixtures }) => {
      const st = fixtures[input._id].interviewStatus;
      return { floor: st.floor, cap: st.cap };
    },
  },
  {
    id: 'complexity_source',
    kind: 'config',
    describe: 'complexity_source cli vs repo changes the seeded complexity_source field',
    values: ['cli', 'repo'],
    vary: (input, v) => ({ ...input, complexity_source: v }),
    promptOnly: false,
    observe: async ({ input, fixtures }) => fixtures[input._id].seededState.complexity_source ?? null,
  },
  {
    id: 'autonomy',
    kind: 'config',
    describe: 'autonomy gated vs loose changes whether an install step asks before running',
    values: ['gated', 'loose'],
    vary: (input, v) => ({ ...input, autonomy: v }),
    promptOnly: false,
    observe: async ({ input, fixtures }) => {
      const fx = fixtures[input._id].finish;
      return { ask: fx.ask, gate: fx.gate };
    },
  },
  {
    id: 'planning_mode',
    kind: 'config',
    describe: 'planning_mode serial vs parallel changes the resume-phase op',
    values: ['serial', 'parallel'],
    vary: (input, v) => ({ ...input, planning_mode: v }),
    promptOnly: false,
    observe: async ({ input, fixtures }) => fixtures[input._id].resumeOp.planning_mode ?? null,
  },
  {
    id: 'context_watch.threshold',
    kind: 'config',
    describe: 'threshold changes context-status recommendation.compact at a fixed usage',
    values: [1, 99],
    vary: (input, v) => ({ ...input, 'context_watch.threshold': v }),
    promptOnly: false,
    observe: async ({ input, fixtures }) => {
      const r = fixtures[input._id].contextStatus;
      return { compact: r.recommendation?.compact ?? null };
    },
  },
  {
    id: 'context_watch.focus',
    kind: 'config',
    describe: 'focus changes context-status recommendation.focus',
    values: [null, 'a custom focus'],
    vary: (input, v) => ({ ...input, 'context_watch.focus': v }),
    promptOnly: false,
    observe: async ({ input, fixtures }) => fixtures[input._id].contextStatus.recommendation?.focus ?? null,
  },
  {
    id: 'interview.probing_minimum',
    kind: 'config',
    describe: 'probing_minimum 1 vs 3 changes the minimum resolved for a schema-backed interview (and so whether endInterview refuses at a fixed eligible count)',
    values: [1, 3],
    vary: (input, v) => ({ ...input, 'interview.probing_minimum': v }),
    promptOnly: false,
    observe: async ({ input, fixtures }) => fixtures[input._id].probing,
  },
  {
    id: 'interview',
    kind: 'config',
    describe: 'the interview container (probing_minimum) changes the resolved probing minimum at a fixed complexity',
    values: [{ probing_minimum: { low: 1, medium: 2, high: 4 } }, { probing_minimum: { low: 2, medium: 3, high: 6 } }],
    vary: (input, v) => ({ ...input, interview: v }),
    promptOnly: false,
    observe: async ({ input, fixtures }) => fixtures[input._id].probing,
  },
  {
    id: 'adversary_review',
    kind: 'config',
    describe: 'adversary_review on vs off changes the review_context.enabled in the wave record',
    values: ['on', 'off'],
    vary: (input, v) => ({ ...input, adversary_review: v }),
    promptOnly: false,
    observe: async ({ input, fixtures }) => {
      const fx = fixtures[input._id];
      return { reviewContextEnabled: fx.reviewContext?.enabled ?? null };
    },
  },
  {
    id: 'render_images',
    kind: 'config',
    describe: 'render_images on vs off changes the set-render-config op output',
    values: ['off', 'on'],
    vary: (input, v) => ({ ...input, render_images: v }),
    promptOnly: false,
    observe: async ({ input, fixtures }) => fixtures[input._id].renderConfig?.images ?? null,
  },
  {
    id: 'fabric',
    kind: 'config',
    describe: 'fabric on vs off changes whether the fabric wave path is executable (flag-off refusal)',
    values: ['on', 'off'],
    vary: (input, v) => ({ ...input, fabric: v }),
    promptOnly: false,
    observe: async ({ input, fixtures }) => {
      const fx = fixtures[input._id];
      return { flagOff: fx.fabricGate?.flagOff ?? false, outcome: fx.fabricGate?.outcome ?? null };
    },
  },
  {
    id: 'done.version_from',
    kind: 'config',
    describe: 'done.version_from changes which file the version gate reads the version from',
    values: ['a.json', 'b.json'],
    vary: (input, v) => ({ ...input, 'done.version_from': v }),
    promptOnly: false,
    observe: async ({ input, fixtures }) => fixtures[input._id].versionFrom ?? null,
  },
  {
    id: 'done.install',
    kind: 'config',
    describe: 'done.install present vs absent changes the deploy-step progression (install group exists)',
    values: ['absent', 'present'],
    vary: (input, v) => ({ ...input, 'done.install': v }),
    promptOnly: false,
    observe: async ({ input, fixtures }) => {
      const fx = fixtures[input._id].deploySteps;
      return { groups: fx.groups ?? null, stepCount: fx.stepCount ?? 0 };
    },
  },
  {
    id: 'done.release',
    kind: 'config',
    describe: 'done.release present vs absent changes the deploy-step progression (release group exists)',
    values: ['absent', 'present'],
    vary: (input, v) => ({ ...input, 'done.release': v }),
    promptOnly: false,
    observe: async ({ input, fixtures }) => {
      const fx = fixtures[input._id].deploySteps;
      return { groups: fx.groups ?? null, stepCount: fx.stepCount ?? 0 };
    },
  },
  {
    id: 'done.live_check',
    kind: 'config',
    describe: 'done.live_check present vs absent changes whether a live-check step is armed',
    values: ['absent', 'present'],
    vary: (input, v) => ({ ...input, 'done.live_check': v }),
    promptOnly: false,
    observe: async ({ input, fixtures }) => {
      const fx = fixtures[input._id].deploySteps;
      return { groups: fx.groups ?? null, hasLiveCheck: fx.hasLiveCheck ?? false };
    },
  },
  {
    id: 'done.commit_paths',
    kind: 'config',
    describe: 'done.commit_paths changes the set of files the deploy step commits',
    values: ['a.txt', 'b.txt'],
    vary: (input, v) => ({ ...input, 'done.commit_paths': v }),
    promptOnly: false,
    observe: async ({ input, fixtures }) => {
      // The real consumer is the commit set the finish machine derives from the done
      // definition (stepCommitsSince), not the raw input echo.
      const fx = fixtures[input._id];
      return { commitPaths: fx.deploySteps?.commitPaths ?? null };
    },
  },
  {
    id: 'done.user_only',
    kind: 'config',
    describe: 'done.user_only present vs absent changes the user-only step list in the done definition',
    values: ['absent', 'present'],
    vary: (input, v) => ({ ...input, 'done.user_only': v }),
    promptOnly: false,
    observe: async ({ input, fixtures }) => {
      const fx = fixtures[input._id].deploySteps;
      return { groups: fx.groups ?? null, userOnly: fx.userOnly ?? null };
    },
  },
  // ---- environment controls ----------------------------------------------
  {
    id: 'CLAUDE_CODE_SESSION_ID',
    kind: 'env',
    describe: 'CLAUDE_CODE_SESSION_ID (and --session/--host) changes the Guard-D owner identity',
    values: ['session-a', 'session-b'],
    vary: (input, v) => ({ ...input, CLAUDE_CODE_SESSION_ID: v }),
    promptOnly: false,
    observe: async ({ input, fixtures }) => {
      const fx = fixtures[input._id];
      return { host: fx.ownerIdentity?.host ?? null, session: fx.ownerIdentity?.session ?? null };
    },
  },
  {
    id: 'MP_CONTEXT_WINDOW',
    kind: 'env',
    describe: 'MP_CONTEXT_WINDOW changes the resolved context window (window_source env)',
    values: ['300000', '600000'],
    vary: (input, v) => ({ ...input, MP_CONTEXT_WINDOW: v }),
    promptOnly: false,
    observe: async ({ input, fixtures }) => fixtures[input._id].contextStatus.window ?? null,
  },
  {
    id: 'MP_DISPATCH_WAVE_CONCURRENCY',
    kind: 'env',
    describe: 'MP_DISPATCH_WAVE_CONCURRENCY changes the bounded wave concurrency',
    values: ['2', '4'],
    vary: (input, v) => ({ ...input, MP_DISPATCH_WAVE_CONCURRENCY: v }),
    promptOnly: false,
    observe: async ({ input, fixtures }) => fixtures[input._id].concurrency,
  },
  {
    id: 'SKYNET_VERIFY_ALLOWLIST',
    kind: 'env',
    describe: 'SKYNET_VERIFY_ALLOWLIST changes the effective gateway verify allowlist',
    values: ['bash -c', 'sh -c'],
    vary: (input, v) => ({ ...input, SKYNET_VERIFY_ALLOWLIST: v }),
    promptOnly: false,
    observe: async ({ input, fixtures }) => fixtures[input._id].verifyAllowlist,
  },
  {
    id: 'MP_ROUTING_POLICY',
    kind: 'env',
    describe: 'MP_ROUTING_POLICY changes the routing-policy cache key (the policy source)',
    values: [null, 'workflow-map'],
    vary: (input, v) => ({ ...input, MP_ROUTING_POLICY: v }),
    promptOnly: false,
    observe: async ({ input, fixtures }) => fixtures[input._id].routingCacheKey,
  },
  {
    id: 'CLAUDE_CONFIG_DIR',
    kind: 'env',
    describe: 'CLAUDE_CONFIG_DIR overrides the resolved Claude config dir (resolveConfigDir)',
    values: [null, '/tmp/alt-claude'],
    vary: (input, v) => ({ ...input, CLAUDE_CONFIG_DIR: v }),
    promptOnly: false,
    observe: async ({ input, fixtures }) => fixtures[input._id].configDir,
  },
  {
    id: 'HOME',
    kind: 'env',
    describe: 'HOME changes the default Claude config dir and user config resolution',
    values: ['/tmp/home-a', '/tmp/home-b'],
    vary: (input, v) => ({ ...input, HOME: v }),
    promptOnly: false,
    observe: async ({ input, fixtures }) => fixtures[input._id].configDir,
  },
  {
    id: 'MASTERPLAN_RUNS_DIR',
    kind: 'env',
    describe: 'MASTERPLAN_RUNS_DIR changes where run bundles resolve (resolveRunsDir)',
    values: [null, '/tmp/runs'],
    vary: (input, v) => ({ ...input, MASTERPLAN_RUNS_DIR: v }),
    promptOnly: false,
    observe: async ({ input, fixtures }) => fixtures[input._id].runsDir,
  },
  {
    id: 'MP_BIN',
    kind: 'env',
    describe: 'MP_BIN overrides the resolved masterplan bin path (resolveMasterplanBin)',
    values: [null, '/tmp/alt-bin/masterplan.mjs'],
    vary: (input, v) => ({ ...input, MP_BIN: v }),
    promptOnly: false,
    observe: async ({ input, fixtures }) => fixtures[input._id].binPath,
  },
  {
    id: 'MP_MARKETPLACE_DIR',
    kind: 'env',
    describe: 'MP_MARKETPLACE_DIR overrides the marketplace dir used by resolveMasterplanBin',
    values: [null, '/tmp/alt-market'],
    vary: (input, v) => ({ ...input, MP_MARKETPLACE_DIR: v }),
    promptOnly: false,
    observe: async ({ input, fixtures }) => fixtures[input._id].binPath,
  },
  {
    id: 'PI_CODING_AGENT',
    kind: 'env',
    describe: 'PI_CODING_AGENT routes to the codex-suppressed (no-Workflow) path',
    values: [null, 'true'],
    vary: (input, v) => ({ ...input, PI_CODING_AGENT: v }),
    promptOnly: false,
    observe: async ({ input, fixtures }) => fixtures[input._id].suppression,
  },
  {
    id: 'CLAUDE_PLUGIN_ROOT',
    kind: 'env',
    describe: 'CLAUDE_PLUGIN_ROOT changes the plugin.json candidate readPluginVersion checks',
    values: ['unset', 'set'],
    vary: (input, v) => ({ ...input, CLAUDE_PLUGIN_ROOT: v }),
    promptOnly: false,
    observe: async ({ input, fixtures }) => fixtures[input._id].pluginVersion,
  },
  // ---- seed-state controls (emitted by buildSeedState) -------------------
  {
    id: 'spec_path',
    kind: 'state',
    describe: 'spec_path changes which spec file the seeded bundle points at',
    values: ['spec-a.md', 'spec-b.md'],
    vary: (input, v) => ({ ...input, spec_path: v }),
    promptOnly: false,
    observe: async ({ input, fixtures }) => fixtures[input._id].seededState.spec_path ?? null,
  },
  {
    id: 'plan_path',
    kind: 'state',
    describe: 'plan_path changes which plan file the seeded bundle points at',
    values: ['plan-a.md', 'plan-b.md'],
    vary: (input, v) => ({ ...input, plan_path: v }),
    promptOnly: false,
    observe: async ({ input, fixtures }) => fixtures[input._id].seededState.plan_path ?? null,
  },
  {
    id: 'plan_index_path',
    kind: 'state',
    describe: 'plan_index_path changes which plan index the seeded bundle points at',
    values: ['plan-a.json', 'plan-b.json'],
    vary: (input, v) => ({ ...input, plan_index_path: v }),
    promptOnly: false,
    observe: async ({ input, fixtures }) => fixtures[input._id].seededState.plan_index_path ?? null,
  },
  {
    id: 'phase',
    kind: 'state',
    describe: 'phase brainstorm vs plan changes the seeded phase and the resume-phase op',
    values: ['brainstorm', 'plan'],
    vary: (input, v) => ({ ...input, phase: v }),
    promptOnly: false,
    observe: async ({ input, fixtures }) => fixtures[input._id].seededState.phase ?? null,
  },
  {
    id: 'status',
    kind: 'state',
    describe: 'status in-progress vs archived changes the runs-list/status projection',
    values: ['in-progress', 'archived'],
    vary: (input, v) => ({ ...input, status: v }),
    promptOnly: false,
    observe: async ({ input, fixtures }) => fixtures[input._id].statusGate ?? null,
  },
  {
    id: 'concurrency.owner_lock',
    kind: 'state',
    describe: 'concurrency.owner_lock on vs off changes whether Guard-D blocks a foreign owner',
    values: ['on', 'off'],
    vary: (input, v) => ({ ...input, 'concurrency.owner_lock': v }),
    promptOnly: false,
    observe: async ({ input, fixtures }) => {
      const fx = fixtures[input._id];
      return { ownerLockOff: fx.ownerLockOff ?? null, outcome: fx.ownerLock?.outcome ?? null };
    },
  },
  {
    id: 'review.adversary',
    kind: 'state',
    describe: 'review.adversary true vs absent changes the wave review_context.enabled',
    values: [true, false],
    vary: (input, v) => ({ ...input, 'review.adversary': v }),
    promptOnly: false,
    observe: async ({ input, fixtures }) => {
      const fx = fixtures[input._id];
      return { reviewContextEnabled: fx.reviewContext?.enabled ?? null };
    },
  },
  {
    id: 'render.images',
    kind: 'state',
    describe: 'render.images on vs off changes the set-render-config op output',
    values: ['off', 'on'],
    vary: (input, v) => ({ ...input, 'render.images': v }),
    promptOnly: false,
    observe: async ({ input, fixtures }) => fixtures[input._id].renderConfig?.images ?? null,
  },
  {
    id: 'dispatch.fabric',
    kind: 'state',
    describe: 'dispatch.fabric true vs absent changes the fabric wave path executability',
    values: [true, false],
    vary: (input, v) => ({ ...input, 'dispatch.fabric': v }),
    promptOnly: false,
    observe: async ({ input, fixtures }) => {
      const fx = fixtures[input._id];
      return { flagOff: fx.fabricGate?.flagOff ?? false, outcome: fx.fabricGate?.outcome ?? null };
    },
  },
  {
    id: 'goals_enabled',
    kind: 'state',
    describe: 'goals_enabled true vs absent changes the finish spec-gate re-arm and goal machinery',
    values: [true, false],
    vary: (input, v) => ({ ...input, 'goals_enabled': v }),
    promptOnly: false,
    observe: async ({ input, fixtures }) => {
      const fx = fixtures[input._id];
      return { goalsGate: fx.goalsGate ?? null };
    },
  },
  // ---- prompt-only markers (rendered protocol lines are the permitted observable) -----
  {
    id: 'context_watch',
    kind: 'prompt-marker',
    describe: 'the context_watch knob marker renders the measured-context gate line in the protocol',
    values: ['present', 'absent'],
    vary: (input, v) => ({ ...input, marker: v }),
    promptOnly: true,
    observe: async ({ input, fixtures }) => {
      const pm = fixtures[input._id].promptMarker;
      return { declared: pm.declared, referenced: input.marker === 'present' ? pm.referenced : !pm.declared };
    },
  },
  {
    id: 'render_images_marker',
    kind: 'prompt-marker',
    describe: 'the render_images knob marker declares the plan->execute render control',
    values: ['present', 'absent'],
    vary: (input, v) => ({ ...input, marker: v }),
    promptOnly: true,
    observe: async ({ input, fixtures }) => {
      const pm = fixtures[input._id].promptMarker;
      return { declared: pm.declared, referenced: input.marker === 'present' ? pm.referenced : !pm.declared };
    },
  },
];

// ---------------------------------------------------------------------------
// Synthetic knobs the guard must REJECT (spec §4.4): the harness proves none of these can
// register a passing contract.
// ---------------------------------------------------------------------------
export const SYNTHETIC_BAD = [
  {
    id: 'synthetic_read_but_ignored',
    kind: 'flag',
    describe: 'read but the value never reaches a consumer-side observable',
    values: ['a', 'b'],
    vary: (input, v) => ({ ...input, ignored: v }),
    promptOnly: false,
    observe: async ({ input }) => ({ ignored: 'a' }), // never reads input.ignored
  },
  {
    id: 'synthetic_seeded_state_only',
    kind: 'flag',
    describe: 'only a seeded state field differs — writer-side proof',
    values: ['a', 'b'],
    vary: (input, v) => ({ ...input, seeded: v }),
    promptOnly: false,
    observe: async ({ input }) => ({ seeded: input.seeded }), // the seeded field itself
  },
];

// A fixture pair that changes TWO inputs at once — the harness must reject it.
export const TWO_INPUT_DIFF = {
  id: 'synthetic_two_input_diff',
  kind: 'flag',
  describe: 'varies two inputs at once — must be rejected by the single-variable harness',
  values: ['x', 'z'],
  vary: (input, v) => ({ ...input, a: v, b: `changed-${v}` }),
  promptOnly: false,
  observe: async ({ input }) => ({ a: input.a, b: input.b }),
};
