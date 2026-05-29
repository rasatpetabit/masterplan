// test/migrate.test.mjs — legacy (pre-v8) bundle read-compat (Resolved #7; build step 1).
//
// Three FROZEN fixtures — structurally real, identifiers synthetic (advisor: exercise the
// dangerous path, not just the trivial one). Sanitized from real runs before publish; the
// structural shape the extractor depends on is preserved verbatim:
//   5.0-inflight-sample ...... in-flight 5.0, 32 tasks, MIXED statuses (complete/pending/in_progress),
//                              `- idx:` at COLUMN 0, multi-line folded `note:` scalars. The risky path.
//   5.0-archived-codex-routing 5.0, 15 tasks all complete, `- idx:` INDENTED, 7+ col-0 keys AFTER
//                              `tasks:` incl. a `recent_events:` list — proves region-bounding.
//   5.1-archived-cc3-visibility 5.1, NO tasks block, deeply-nested brainstorm_anchor folded scalars.
// Plus synthetic inline YAML for the refuse (<5.0) and fail-loud (malformed task / unparseable gate) paths.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { migrate, detectSchemaVersion, extractLegacyFields, MigrationError } from '../lib/migrate.mjs';
import { decideNextAction } from '../lib/resume.mjs';
import { parseState, serializeState } from '../lib/bundle.mjs';

const fx = (name) => readFileSync(new URL(`./fixtures/legacy-bundles/${name}`, import.meta.url), 'utf8');
const SAMPLE = fx('5.0-inflight-sample.yml');
const CODEX = fx('5.0-archived-codex-routing-fix.yml');
const CC3 = fx('5.1-archived-cc3-visibility.yml');
const taskById = (tasks, id) => tasks.find((t) => t.id === id);
const rawTask = (tasks, idx) => tasks.find((t) => t.idx === idx);

// ---- detectSchemaVersion: tolerant across quote styles + `---` doc marker ----
test('detectSchemaVersion: single-quoted (sample), double-quoted (codex), 5.1 (cc3)', () => {
  assert.equal(detectSchemaVersion(SAMPLE), '5.0'); // schema_version: '5.0'
  assert.equal(detectSchemaVersion(CODEX), '5.0'); // ---\nschema_version: "5.0"
  assert.equal(detectSchemaVersion(CC3), '5.1');
});
test('detectSchemaVersion: bare value and absent', () => {
  assert.equal(detectSchemaVersion('schema_version: 5.0\nslug: x\n'), '5.0');
  assert.equal(detectSchemaVersion('slug: ancient\ncurrent_phase: foo\n'), null);
});

// ---- extractLegacyFields: the targeted line-extractor (no full YAML parse) ----
test('extract(sample): header scalars + 32 mixed-status tasks, `- idx:` at column 0', () => {
  const f = extractLegacyFields(SAMPLE);
  assert.equal(f.slug, '2026-05-13-sample-datasheet-redesign');
  assert.equal(f.status, 'in-progress');
  assert.equal(f.tasks.length, 32);
  assert.equal(rawTask(f.tasks, 1).status, 'complete');
  assert.equal(rawTask(f.tasks, 28).status, 'pending');
  assert.equal(rawTask(f.tasks, 32).status, 'in_progress');
  assert.equal(f.pending_gate, null);
});
test('extract(codex): region bounds at first col-0 key — recent_events NOT mis-parsed as tasks', () => {
  const f = extractLegacyFields(CODEX);
  assert.equal(f.tasks.length, 15); // exactly 15 — proves the bound (recent_events has `- "..."` items)
  assert.ok(f.tasks.every((t) => t.status === 'complete'));
  assert.equal(f.status, 'archived');
});
test('extract(cc3 5.1): no tasks block -> empty task list; nested blobs ignored', () => {
  const f = extractLegacyFields(CC3);
  assert.deepEqual(f.tasks, []);
});

// ---- migrate(): one-shot 5.x -> 6.0 field map ----
test('migrate(sample 5.0): -> 6.0, provenance, task shape, in_progress normalizes to pending', () => {
  const s = migrate(SAMPLE);
  assert.equal(s.schema_version, '6.0');
  assert.equal(s.migrated_from, '5.0');
  assert.equal(s.active_run, null); // dead session — no live workflow survives
  assert.equal(s.pending_gate, null);
  assert.equal(s.tasks.length, 32);
  assert.deepEqual(taskById(s.tasks, 1), { id: 1, status: 'done', wave: null, files: [] });
  assert.equal(taskById(s.tasks, 28).status, 'pending'); // pending -> pending
  assert.equal(taskById(s.tasks, 32).status, 'pending'); // in_progress -> pending (re-dispatch)
});
test('migrate(codex 5.0): all 15 tasks -> done', () => {
  const s = migrate(CODEX);
  assert.equal(s.schema_version, '6.0');
  assert.equal(s.tasks.length, 15);
  assert.ok(s.tasks.every((t) => t.status === 'done'));
});
test('migrate(cc3 5.1): no tasks -> resume controller decides complete', () => {
  const s = migrate(CC3);
  assert.equal(s.schema_version, '6.0');
  assert.deepEqual(s.tasks, []);
  assert.equal(decideNextAction(s, {}).action, 'complete'); // end-to-end: migrated state resumes cleanly
});
test('migrate(sample 5.0) + resume: in-flight migrated tasks carry null waves -> guard fires until backfill', () => {
  // The composition cc3 CANNOT expose (it has zero tasks -> early `complete`). A migrated IN-FLIGHT
  // bundle carries wave:null; decideNextAction must fail loud, not silently dispatch an empty wave.
  // The L1 shell backfills waves from a plan.md re-parse (step-2 contract) before resume.
  assert.throws(() => decideNextAction(migrate(SAMPLE), {}), /backfill waves from plan\.index\.json/);
});

// ---- 6.0 passthrough: already-v8 flat state round-trips unchanged ----
test('migrate(6.0): passthrough via the flat parser (no transform)', () => {
  const v8 = { schema_version: '6.0', slug: 'demo', pending_gate: null, active_run: null,
               tasks: [{ id: 1, status: 'done', wave: 0, files: ['a.js'] }] };
  const text = serializeState(v8);
  assert.deepEqual(migrate(text), parseState(text));
});
test('migrate(6.1 / 7.0): future flat versions also pass through', () => {
  assert.equal(migrate('schema_version: "6.1"\nslug: x\n').slug, 'x');
  assert.equal(migrate('schema_version: "7.0"\nslug: y\n').schema_version, '7.0');
});

// ---- refuse pre-5.0 loudly (R3: don't silently break; backup preserved by caller) ----
test('migrate(<5.0): throws MigrationError with recovery guidance', () => {
  assert.throws(() => migrate('schema_version: "4.0"\nslug: old\n'), (e) => {
    assert.ok(e instanceof MigrationError);
    assert.match(e.message, /v7|re-import|brainstorm/i);
    return true;
  });
  assert.throws(() => migrate('slug: ancient\ncurrent_phase: foo\n'), MigrationError); // no version at all
});

// ---- fail-loud: never write a half-migrated state when structure is unparseable ----
test('fail-loud: a task with idx but no status throws (no silent partial)', () => {
  const bad = 'schema_version: "5.0"\nslug: x\ntasks:\n- idx: 1\n  name: orphan\n- idx: 2\n  status: complete\n';
  assert.throws(() => migrate(bad), MigrationError);
});
test('fail-loud: non-null pending_gate with no extractable id throws; with id extracts {id}', () => {
  const noId = 'schema_version: "5.0"\nslug: x\npending_gate:\n  opened_at: "t"\ntasks: []\n';
  assert.throws(() => migrate(noId), MigrationError);
  const withId = 'schema_version: "5.0"\nslug: x\npending_gate:\n  id: plan_approval\n  opened_at: "t"\ntasks: []\n';
  assert.equal(migrate(withId).pending_gate.id, 'plan_approval');
});

// ---- purity ----
test('migrate returns fresh structures (no shared task refs)', () => {
  const s = migrate(SAMPLE);
  s.tasks[0].status = 'mutated';
  assert.equal(migrate(SAMPLE).tasks[0].status, 'done'); // re-parse unaffected
});
