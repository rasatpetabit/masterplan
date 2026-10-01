# Plan 07 Task 8 — pre-gate source evidence and gated runbook

Task label: `p07-t8-pregate`. **Source ready; integration/activation/release verification owed.** This document is build evidence, not independent approval or authority to execute the gates below. Plan 09 must retain dual emission until installed-consumer evidence exists.

## Entry, scope and provenance

- Assigned masterplan checkout: `/srv/dev/ras/masterplan/.worktrees/model-routing-07`, branch `model-routing/07-masterplan`.
- Entry HEAD: `f92d5bb4d8c42c585cd6de8fdfcf8017b4682f22`; entry status empty. `/proc/*/cwd` survey found only the executing shell/scan child in this checkout; no other writer. Repeated before evidence publication.
- Read-only joint checkout: `W=/srv/workflows/.worktrees/model-routing-r1`, HEAD `005d0e500573872cd716dc3cc5f648986b9bf70a`. Recorded with `printf '%s\n' "$W"; git -C "$W" rev-parse HEAD` before integration and the final full suite. Rechecked unchanged HEAD and empty status afterward.
- Read Task 8, common brief, amendments, design spec, INTENT, development conventions, relevant sequencer/producer/doctor/installer/release source and existing C3/C5/C7 integration. INTENT assessment: **serves** Purpose/Top invariant/Non-goals/Direction/Posture by proving harness-native, model-free dispatch without pretending source evidence is delivery.
- Existing-solution search: `test/dispatch-wave.native.test.mjs`, `test/fixtures/task5-panel-integration.mjs`, joint `dispatch-panel-execution.test.ts`, `dispatch-admission.test.ts`, native `review-admission.ts`, C3 `dispatch-receipt.ts`, C5 `resolve-dispatch.mjs`. Reused accepted APIs; no upstream workaround, vendored resolver, new panel coordinator or runtime code.
- Hindsight recall/retain requires a prohibited production-service request; not attempted. Repository evidence/WORKLOG is durable handoff, not canonical memory retention.

## Implementation and inventory

`test/routing-consumer-cutover.test.mjs` is the prescribed passing guard: legacy exports and packaged maps absent. No manufactured red regression against accepted cleanup.

`test/routing-consumer-integration.test.mjs` copies source modules into disposable installed-style release roots (not a real installer), with temporary HOME and synthetic C1. Absolute existing `W` and required joint files are mandatory. Its Node helper runs with cwd `$W/pi-subagents`, `--import tsx`, absolute file-URL imports and required export checks. Missing dependencies fail, never skip/fall back. The existing Task 5 helper now optionally consumes each launch's synthetic map so actual C2 reviewer identity changes under a fixture reorder; no descriptor model pin.

Executable coverage:

- Configured Pi/Claude Code/Codex and unconfigured non-Pi planning/task/challenge/finish producers; CLI host classification and actual finish-step CLI entrypoints.
- Atomic same-path C1 replacement with preserved timestamp changes plan/challenge/effort intent on every configured host; all descriptors remain model-free.
- Ten distinct refusal records/diagnostics: unknown phase, unknown usecase, explicit missing map, missing Pi map, empty explicit path, unreadable present file, invalid JSON, wrong schema, invalid references, retired environment knob. Zero launches on refusals. Directory-as-file makes unreadability reproducible even for privileged users.
- Actual task-review and committed-recovery producer descriptors, and actual durable finish-review producer descriptors, independently exhaust C7's policy-derived ceiling. Diff/head, attempt, reviewer and token vary; subject does not. Native C7 qualification alternates linked and primary cwd without splitting the canonical episode.
- Each producer: 8 admitted panels, 7 complete three-report adjudications, 1 incomplete panel with 2 retained reports/unfilled seat and no judge, 1 successful recovered seat, ninth launch denied with 0 children. One reservation per logical launch, including recovery. Raw C3 subject unchanged; served model/effort and attempt effort null until injected observed service. Receipts retained per seat/judge.
- Synthetic seat/adjudicator runners only. This is accepted native admission → C5 coordinator integration, not the live native Pi child-process/provider path, installation, or production measurements.

Reader inventory command and full output: [p07-task8/reader-inventory.txt](p07-task8/reader-inventory.txt).

```bash
rg -n 'workflow-map|MP_ROUTING_POLICY|fallback_reviewers|resolvePanel|laneAliasMap' lib bin commands/masterplan.md
```

Nine hits: stale nonexecutable comments in `bin/masterplan.mjs:154`, `lib/wave.mjs:102`, `lib/dispatch-wave.mjs:6,423`, `lib/dispatch/index.mjs:5`, `lib/dispatch/routing.mjs:6`; explicit retirement detection/diagnostic in `lib/dispatch/routing-policy.mjs:16–17`; doctor migration diagnostic in `lib/doctor/routing-policy-health.mjs:6`. No active legacy reader remains. Stale comments are not readers and were left to their owning cleanup slice, not expanded into Task 8 runtime edits. Also inspected `bin/doctor.mjs` (module discovery only) and `lib/finish-step.mjs:125–175,410–455,2309ff` (C1 intent, persisted episode, historic review receipts; no seat/model/recovery authority).

## Verification: commands, exits, counts, complete outputs

Every positive check sourced `/etc/profile.d/inference-gateway.sh` without printing its environment/credential values. HOME was disposable and seeded only with `test/fixtures/dispatch-map.json` at `.pi/workflows/dispatch-map.json`; `MP_ROUTING_POLICY`, `MP_DISPATCH_MAP`, `PYTHONOPTIMIZE` unset. Helper processes disable Python bytecode and tsx cache writes.

**Read-only ruling:** orchestrate build writes `dist`; staging test recompiles it and temporarily writes `cache/generations/mode.json`. Therefore the first four sequential commands ran in a byte-for-byte disposable copy of the named joint checkout (`cp -a "$W/." "$T/joint"`, remove copied `.git` pointer). No tracked source edits or joint checkout writes. Original `W` was restored for masterplan checks and every integration/full run. Dependency symlinks were read-only, not deployed. The copy and HOME were removed at turn end.

The exact fail-fast order was:

```bash
set -euo pipefail
source /etc/profile.d/inference-gateway.sh
export W=/srv/workflows/.worktrees/model-routing-r1
printf '%s\n' "$W"; git -C "$W" rev-parse HEAD
T=$(mktemp -d /tmp/p07-t8-checks-XXXXXX)
cp -a "$W/." "$T/joint"; rm -f "$T/joint/.git"
M=/srv/dev/ras/masterplan/.worktrees/model-routing-07
export HOME="$T/home" USERPROFILE="$T/home" TSX_DISABLE_CACHE=1 PYTHONDONTWRITEBYTECODE=1
mkdir -p "$HOME/.pi/workflows"
cp "$M/test/fixtures/dispatch-map.json" "$HOME/.pi/workflows/dispatch-map.json"
unset MP_DISPATCH_MAP MP_ROUTING_POLICY PYTHONOPTIMIZE
export W="$T/joint"
cd "$W/pi-orchestrate"
npm run build
npm run typecheck:tests
npm run test:unit
cd "$W/pi-compiled-extensions"
node --test test/stage.test.mjs
cd "$M"
export W=/srv/workflows/.worktrees/model-routing-r1
printf '%s\n' "$W"; git -C "$W" rev-parse HEAD
node --test test/*.test.mjs
node bin/doctor.mjs --only=routing-policy-health
# After integration file was added, same shell environment and recorded W:
node --test test/routing-consumer-integration.test.mjs
node --test test/*.test.mjs
```

| Command | Exit | Pass / fail / skip | Complete credential-safe output |
|---|---:|---|---|
| `node --test test/routing-consumer-cutover.test.mjs` | 0 | 1 / 0 / 0 | [cutover.txt](p07-task8/cutover.txt) |
| `npm run build` | 0 | tsc, no diagnostics | [sequential.txt](p07-task8/sequential.txt) |
| `npm run typecheck:tests` | 0 | tsc, no diagnostics | same |
| `npm run test:unit` | 0 | 228 / 0 / 0, 32 suites | same |
| `node --test test/stage.test.mjs` | 0 | 11 / 0 / 0 | same |
| pre-integration `node --test test/*.test.mjs` | 0 | 3014 / 0 / 0, 4 suites | same |
| `node bin/doctor.mjs --only=routing-policy-health` | 0 | 1 PASS, 0 error/warn | same |
| `node --test test/routing-consumer-integration.test.mjs` | 0 | 3 / 0 / 0 | [integration.txt](p07-task8/integration.txt) |
| post-integration `node --test test/*.test.mjs` | 0 | 3017 / 0 / 0, 4 suites | [full-suite.txt](p07-task8/full-suite.txt) |
| `env -u W node --test test/routing-consumer-integration.test.mjs` (same isolated HOME) | 1, expected | 0 / 3 / 0 | [missing-w.txt](p07-task8/missing-w.txt) |
| `git diff --check` | 0 | no whitespace errors | no output |

Doctor: `PASS routing-policy-health: C1 discovery configured ... (schema 1; phase/usecase/agent references valid)`; `masterplan doctor: 1 finding(s) — 0 error, 0 warn.` All result records inspected. The 25 result titles containing SKIP in the sequential log exercise doctor/config no-op behavior; none is a TAP `# SKIP` or a skipped integration. Final suite has no skips/failures. Entry baseline 3013; guard + three integration tests explain final 3017.

First integration development run: 2 pass / 1 fail / 0 skip because the subprocess inherited the parent harness's Pi signal, misclassifying synthetic Claude Code. Cleared `PI_CODING_AGENT` in subprocess fixture environment (no product change). Final focused and full runs above include the corrected fixture plus reviewer variation/finish CLI coverage.

Independent frontier review is **owed**, not obtained or invented. Governed reviewer/advisor tools are not exposed on this child surface; review stays parent-owned and blocks delivery, not completion of this build brief. No new product/architecture decisions; only test isolation/fixture implementation details. No manager, namespace/container, ansible, deploy/install/restart/activation, production-service request, credential-value read, live counter mutation, protected-config edit, merge or push occurred. Disposable test repositories perform local commits/worktree operations only. Source commits use ordinary hooks-enabled git; core.hooksPath is unset and the repository hooks directory contains samples only (no hook bypass/changes).

## Exact gate runbook — NOT EXECUTED

All actions below require fresh direct operator authority for the named gate. The authorization for this build grants none of them. Re-read the named plans, `RELEASING.md`, production-boundary and concurrency rules at execution time. Never reuse a guessed generation, release version/ref/SHA, install metadata or successful source run as deployment approval. Record complete credential-safe outputs in delivery evidence; refuse every missing/mismatched identity or failed required check. No credential values belong in evidence.

### Gate 1 — integrate independently reviewed source

Preconditions: frontier review of exact source/evidence (cancellation, host classification, reviewer binding, C4, panel ownership/package contents); accepted dispositions; target repo/branch expressly authorized; no overlapping writer. Preserve other sessions' dirty README/bundles/uncommitted work. Survey both repositories before any merge:

```bash
git -C "$TARGET_REPO" status --porcelain=v1
git -C "$TARGET_REPO" branch -vv
git -C "$TARGET_REPO" worktree list --porcelain
git -C "$TARGET_REPO" log --oneline --all -20
ps -eo pid,ppid,comm
# Inspect /proc/<relevant-pid>/cwd; compare live sessions and overlapping diffs.
git -C "$TARGET_REPO" rev-parse HEAD
# SOURCE_SHA comes from the independently reviewed source receipt; require full SHA.
test "$(git -C "$SOURCE_REPO" rev-parse "$SOURCE_SHA^{commit}")" = "$SOURCE_SHA"
git -C "$TARGET_REPO" merge --no-ff --no-edit "$SOURCE_SHA"
git -C "$TARGET_REPO" rev-parse HEAD
git -C "$TARGET_REPO" status --porcelain=v1
```

Apply separately to masterplan and the joint workflows integration under their respective grants. Expected: intended source ancestor of target, no lost unrelated lines, no conflict/dirty-path sweep, recorded pre-merge tip and merge commit. Run each repository's required checks at integrated tips with original exported W (and synthetic disposable HOME for source suites). On conflict stop; abort only this merge via `git merge --abort`. Post-landing rollback is an explicitly reviewed `git revert -m 1 "$INTEGRATION_MERGE_SHA"` after another survey, not a reset of shared work. Integration never installs/pushes implicitly.

### Gate 2 — orchestrate/workflow coupled generation

Preconditions: plans 01/02 C1 delivered, dual vocabulary live, plan 08 C7 installed/migration disposition proved, plans 04–06 R1 prerequisites and adoption procedure satisfied. Production compiled package must be the approved copied release outside `/srv/dev` (not a symlink to dev); source integration alone does not satisfy this. Identify `COMPILED_PACKAGE` from deployed release metadata/actual loader package, not a guessed path. Source/build staging must be reviewed clean snapshots. Confirm production mode from `cache/generations/mode.json` and coupled targets from shipped `scripts/targets.mjs`; do not enable mode yourself. Record current/previous IDs and manifests before staging. Do not use `PI_COMPILED_NO_INVENTORY` or receipt overrides for production activation.

These are the existing staging/library interfaces (there is no `stage-generation.mjs` CLI). Execute after authority, from the approved compiled package:

```bash
cd "$COMPILED_PACKAGE"
export GENERATION_ROOT="$(pwd -P)/cache/generations"
node --input-type=module <<'JS'
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { stageTarget } from './scripts/build-lib.mjs';
import { TARGETS } from './scripts/targets.mjs';
import { assembleGeneration } from './scripts/generation-lib.mjs';
const root = process.env.GENERATION_ROOT;
if (!path.isAbsolute(root) || fs.realpathSync(root).startsWith('/srv/dev/')) throw Error('invalid production root');
const mode = JSON.parse(fs.readFileSync(path.join(root, 'mode.json')));
if (mode.enabled !== true) throw Error('coupled generation mode not enabled');
const selection = JSON.parse(fs.readFileSync(path.join(root, 'current.json')));
if (!selection.current) throw Error('missing current generation');
const members = {};
for (const name of ['workflow', 'orchestrate']) {
  const target = TARGETS.find(t => t.name === name);
  if (!target) throw Error('missing coupled target');
  const staged = await stageTarget(target); // strict, no publication/fallback
  members[name] = { source: staged.artifact, inputHash: staged.hash,
    sha256: createHash('sha256').update(fs.readFileSync(staged.artifact)).digest('hex') };
}
const id = 'routing-' + createHash('sha256').update(JSON.stringify(members)).digest('hex');
const manifest = await assembleGeneration(root, { id, kind: 'orchestrate', ...members });
console.log(JSON.stringify({ root, new: id, previous: selection.current, manifest }));
JS
```

Set/export `NEW_GENERATION` and `PREVIOUS_GENERATION` only from this successful staging JSON. Record both digests/input hashes and source revisions. Refuse existing generation collision rather than overwriting it. Before activation, run both source projects' declared build/typecheck/test scripts, compiled tests including `node --test test/generation-loader.test.mjs test/reload-entry.test.mjs`, and a real-Pi-loader pair probe against **these staged bytes**, with sandbox selection and isolated receipts. For the latter, copy the compiled package's `workflow/index.js`, `workflow/loader-receipt.mjs`, `scripts/generation-lib.mjs` and staged generation into a disposable package tree; write its sandbox `current.json` selecting NEW_GENERATION only (not the production pointer). Use `loadExtensionsCached([sandboxEntry], sandboxCwd, createEventBus(), createExtensionRuntime())` and `clearExtensionCache()` from the actual installed Pi release recorded in the loader metadata. Assert `errors=[]`, exactly one aggregate extension, commands include exactly one `orchestrate`/`ultracode`, tools include `workflow`/`workflow_control`; reload it and repeat. Run the same sandbox probe on saved previous generation. `PI_COMPILED_RECEIPTS` must point into the sandbox for these probes. Record module release SHA and observed registrations; synthetic member tests alone do not prove staged-byte delivery.

The staged-byte pair probe can be run with the following explicit command after `PI_RELEASE` is resolved/verified from the actual installed Pi metadata (not the historical release literal in older tests). It copies only the named loader/library/generation bytes; it never activates a production pointer or starts a Pi provider session:

```bash
export PI_RELEASE NEW_GENERATION PREVIOUS_GENERATION GENERATION_ROOT
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const release = process.env.PI_RELEASE;
assert.ok(release && path.isAbsolute(release) && !fs.realpathSync(release).startsWith('/srv/dev/'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-gate-pair-'));
try {
  const sandbox = path.join(root, 'package');
  fs.mkdirSync(sandbox, { recursive: true });
  fs.writeFileSync(path.join(sandbox, 'package.json'), '{"type":"module"}');
  for (const rel of ['workflow/index.js', 'workflow/loader-receipt.mjs', 'scripts/generation-lib.mjs']) {
    fs.mkdirSync(path.dirname(path.join(sandbox, rel)), { recursive: true });
    fs.copyFileSync(rel, path.join(sandbox, rel));
  }
  const store = path.join(sandbox, 'cache/generations'); fs.mkdirSync(store, { recursive: true });
  process.env.PI_COMPILED_RECEIPTS = path.join(root, 'receipts');
  const load = rel => import(pathToFileURL(path.join(release, rel)).href);
  const { clearExtensionCache, createExtensionRuntime, loadExtensionsCached } = await load('dist/core/extensions/loader.js');
  const { createEventBus } = await load('dist/core/event-bus.js');
  for (const id of [process.env.NEW_GENERATION, process.env.PREVIOUS_GENERATION]) {
    assert.ok(id && id !== 'null');
    fs.cpSync(path.join(process.env.GENERATION_ROOT, id), path.join(store, id), { recursive: true });
    fs.writeFileSync(path.join(store, 'current.json'), JSON.stringify({ schema: 1, current: id, previous: null }));
    for (const reload of [false, true]) {
      clearExtensionCache();
      const result = await loadExtensionsCached([path.join(sandbox, 'workflow/index.js')], sandbox, createEventBus(), createExtensionRuntime());
      assert.deepEqual(result.errors, []); assert.equal(result.extensions.length, 1);
      const extension = result.extensions[0];
      const commands = [...extension.commands.keys()]; const tools = [...extension.tools.keys()];
      for (const name of ['orchestrate', 'ultracode']) assert.equal(commands.filter(n => n === name).length, 1);
      for (const name of ['workflow', 'workflow_control']) assert.ok(tools.includes(name));
      console.log(JSON.stringify({ id, reload, commands, tools, errors: result.errors }));
    }
  }
} finally { fs.rmSync(root, { recursive: true, force: true }); }
JS
```

If current upstream APIs differ, stop and update/review the probe against that installed loader before activation, rather than treating a missing export as success.

Then, with original production receipt configuration restored, require real live-PID/start-time aggregate-loader adoption receipts (R1 step B, including detached runners); missing adoption blocks activation. The named native commands are:

```bash
cd "$COMPILED_PACKAGE"
node scripts/generation.mjs validate "$GENERATION_ROOT" "$NEW_GENERATION"
node scripts/generation.mjs activate "$GENERATION_ROOT" "$NEW_GENERATION" "$PREVIOUS_GENERATION"
cat "$GENERATION_ROOT/current.json"
node scripts/generation.mjs validate "$GENERATION_ROOT" "$NEW_GENERATION"
cat "$GENERATION_ROOT/$NEW_GENERATION/manifest.json"
sha256sum "$GENERATION_ROOT/$NEW_GENERATION/"{workflow,orchestrate}.mjs
```

Expected: validate schema/id/kind plus two correct digests; activate selection current=new/previous=saved prior; one pointer owns both members; mode remains enabled. Fresh/reloaded authorized sessions prove command ownership, workflow availability, conduct enter/leave and directive handshake. R1 raw-review-rule retirement is a **separate** plan-08-authorized action, never bundled here. On failure, re-enable raw rules through their owner first if R1 rolled them back, then:

```bash
node scripts/generation.mjs rollback "$GENERATION_ROOT" "$NEW_GENERATION"
cat "$GENERATION_ROOT/current.json"
node scripts/generation.mjs validate "$GENERATION_ROOT" "$PREVIOUS_GENERATION"
cat "$GENERATION_ROOT/$PREVIOUS_GENERATION/manifest.json"
sha256sum "$GENERATION_ROOT/$PREVIOUS_GENERATION/"{workflow,orchestrate}.mjs
```

Rollback's second argument is the generation **now active**. Require saved previous pair selected, reload/reprobe affected sessions; retain C7 while any caller runs and never restore counters to an earlier database.

### Gate 3 — masterplan tagged release/install and installed verification

Preconditions: Gate 1 complete, independent acceptance, release version chosen from current reviewed release state, clean release worktree inside the owning repo's `.worktrees/`; no dirty README copied in. Read `RELEASING.md` fully again. Run its seven version-bearing edits in that worktree: canonical plugin, marketplace root/plugin, Codex plugin, package, README current release, llms current release, CHANGELOG dated entry. A new release number is not chosen by this build; set `VERSION` from the reviewed release record. Record source SHA and clean state. Restore `W=/srv/workflows/.worktrees/model-routing-r1` and recorded HEAD for every release-suite run.

```bash
cd "$RELEASE_WORKTREE"
cat RELEASING.md
export W=/srv/workflows/.worktrees/model-routing-r1
printf '%s\n' "$W"; git -C "$W" rev-parse HEAD
source /etc/profile.d/inference-gateway.sh
H=$(mktemp -d); mkdir -p "$H/.pi/workflows"
cp test/fixtures/dispatch-map.json "$H/.pi/workflows/dispatch-map.json"
env -u MP_ROUTING_POLICY -u MP_DISPATCH_MAP HOME="$H" node --test test/*.test.mjs
rm -rf "$H"
git diff --check
git add -- .claude-plugin/plugin.json .claude-plugin/marketplace.json .codex-plugin/plugin.json package.json README.md llms.txt CHANGELOG.md
git commit -m "release: v$VERSION — model-free consumer cutover" -- .claude-plugin/plugin.json .claude-plugin/marketplace.json .codex-plugin/plugin.json package.json README.md llms.txt CHANGELOG.md
node scripts/release.mjs --version="$VERSION"
```

Expected: full suite all pass/no skips, manifest hygiene consistent, clean version commit, one annotated tag `v$VERSION` at reviewed tip; refuse foreign/existing mismatched tag or dirty paths. Before installation, read the actual default install-root metadata (installer declares `$HOME/.local/share/masterplan/.pi-install.json`) and retain **ref/SHA/source**, not just `--check`. Parse only non-secret identity fields; do not print environments:

```bash
node --input-type=module <<'JS'
import fs from 'node:fs';
import path from 'node:path';
const meta = JSON.parse(fs.readFileSync(path.join(process.env.HOME, '.local/share/masterplan/.pi-install.json')));
for (const key of ['ref', 'sha', 'source']) if (typeof meta[key] !== 'string' || !meta[key]) throw Error('missing rollback ' + key);
if (!/^[0-9a-f]{40}$/.test(meta.sha)) throw Error('invalid rollback SHA');
console.log(JSON.stringify({ ref: meta.ref, sha: meta.sha, source: meta.source }));
JS
```
 Set `PREVIOUS_REF`, `PREVIOUS_SHA`, `PREVIOUS_SOURCE` from that metadata and `RELEASE_TAG`, `RELEASE_SHA`, `RELEASE_SOURCE` from reviewed release output. Verify both in their recorded repositories:

```bash
: "${PREVIOUS_REF:?}" "${PREVIOUS_SHA:?}" "${PREVIOUS_SOURCE:?}"
: "${RELEASE_TAG:?}" "${RELEASE_SHA:?}" "${RELEASE_SOURCE:?}"
test "$(git -C "$PREVIOUS_SOURCE" rev-parse "$PREVIOUS_REF^{commit}")" = "$PREVIOUS_SHA"
test "$(git -C "$RELEASE_SOURCE" rev-parse "$RELEASE_TAG^{commit}")" = "$RELEASE_SHA"
test "$(git -C "$RELEASE_SOURCE" cat-file -t "refs/tags/$RELEASE_TAG")" = tag
# Separate publication authority required:
git -C "$RELEASE_SOURCE" push origin "$RELEASE_TAG"
# Wait for tag release-publish CI success and record it before separate install authority:
cd "$RELEASE_SOURCE"
node bin/install-pi.mjs --ref="$RELEASE_TAG"
node bin/install-pi.mjs --check
```

Expected `install_pi: installed` (or truthful idempotent), recorded SHA/version/current below copied release root; `install_pi: check_ok`. Inspect installed release for absent `policy/workflow-map.json`/`dispatch-map.json`, no packaged resolver, no runtime symlink into `/srv/dev`. Read effective C1 discovery from installed `lib/dispatch/routing-policy.mjs` using actual host and override metadata (not synthetic source fixture); require configured schema 1 for Pi. Run installed doctor routing-policy-health and a read-only native planning/review descriptor, preserving custom C4/subject/model-free fields. Read-only installed check commands (from the installed current release, after Gate 3 authority; not executed here):

```bash
cd "$HOME/.local/share/masterplan/current"
node bin/doctor.mjs --only=routing-policy-health
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { discoverDispatchMap } from './lib/dispatch/routing-policy.mjs';
import { buildPlanWorkItem } from './lib/continue.mjs';
const discovery = discoverDispatchMap({ host: 'pi' });
assert.equal(discovery.status, 'configured'); assert.equal(discovery.schema, 1);
const descriptor = buildPlanWorkItem({ key: 'delivery-check' }, {
  roots: [process.cwd()], specPath: process.cwd() + '/INTENT.md', repoRoot: process.cwd(), host: 'pi', policy: discovery.policy,
});
assert.equal(descriptor.phase, 'plan'); assert.equal(Object.hasOwn(descriptor, 'model'), false);
console.log(JSON.stringify({ discovery: { status: discovery.status, path: discovery.path, schema: discovery.schema }, descriptor }));
JS
```

Separately authorized live smoke in a fresh Pi session: `/orchestrate conduct`, `/orchestrate status`, `/orchestrate off`, `/orchestrate status` (expect truthful conduct entry/exit, original parent selection restored, no blocked-conduct request traffic). Invoke the native tool with `subagent({ agent: 'breaker', usecase: 'adversarial-assessment', stakes: 'critical', blocking: true, subject: 'docs/handoffs/2026-10-01-p07-task8-pregate-evidence.md', task: 'Review only docs/handoffs/2026-10-01-p07-task8-pregate-evidence.md lines 1-80 for source-evidence fidelity; return at most 4 findings.' })` in the reviewed repository cwd; retain observed C3 receipts (3 seat reports and adjudication, or explicit inconclusive/unfilled seats). No production measurement is claimed until this occurs.

Rollback, only using previously verified metadata/source identity:

```bash
node "$PREVIOUS_SOURCE/bin/install-pi.mjs" --source="$PREVIOUS_SOURCE" --ref="$PREVIOUS_REF"
node "$PREVIOUS_SOURCE/bin/install-pi.mjs" --check
```

Expected current and metadata SHA equal PREVIOUS_SHA and `check_ok`; reprobe installed discovery/native behavior. Never edit an immutable release directory, move a historical tag, restore counters, or link production to dev. Before Plan 09 drops dual emission, parent records all gate SHAs, staged/current/rollback identities, installed-consumer receipts and live measurements; source-only passing tests cannot discharge that obligation.
