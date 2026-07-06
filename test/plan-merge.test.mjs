// test/plan-merge.test.mjs — regression suite for the deterministic plan merge core.
//
// This module owns the root-cause fix for two observed anomalies:
//   (1) codex field-shape drift — a drafter/assembler emitted `codex: {eligible,reason}`
//       (an object) but routing only honours the STRING enum "ok"|"no"|null; an object
//       silently falls through to the heuristic. Merge normalises; validate rejects.
//   (2) wave re-authoring / under-decomposition — an LLM re-waved disjoint tasks into
//       single-task waves. Here the LLM NEVER authors waves: deterministic JS layers them
//       from the dependency DAG + file-disjointness, packing each wave maximally.
//
// The single most load-bearing test is the cross-fragment FORWARD-REFERENCE dep case:
// parallel drafters emit fragments in arbitrary order, so a dependent task can carry a
// LOWER id than the task it depends on. Wave assignment must follow the dependency graph
// (topological order), never the id sequence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergePlanFragments,
  validatePlanIndex,
  renderPlanMd,
  renderPlanHtml,
  normalizeCodex,
  resolveAssetSrc,
  resolveRefTarget,
  parseAmendments,
} from '../lib/plan-merge.mjs';

// Fragment factory — one subsystem with its task list. Keeps tests terse.
const frag = (key, tasks) => ({ key, tasks });
const task = (key, over = {}) => ({
  key,
  description: `do ${key}`,
  files: [`${key}.js`],
  verify_commands: [`test ${key}`],
  ...over,
});

// Locate an emitted task by the source key carried through for provenance lookups.
// Emitted tasks are keyed by integer id; we match back via description (stable per key).
const byDesc = (index, key) => index.tasks.find((t) => t.description === `do ${key}`);

// ── normalizeCodex: the anomaly-1 normaliser ────────────────────────────────
test('normalizeCodex passes through the canonical string enum', () => {
  assert.equal(normalizeCodex('ok'), 'ok');
  assert.equal(normalizeCodex('no'), 'no');
  assert.equal(normalizeCodex(null), null);
  assert.equal(normalizeCodex(undefined), null);
});

test('normalizeCodex coerces booleans to the string enum', () => {
  assert.equal(normalizeCodex(true), 'ok');
  assert.equal(normalizeCodex(false), 'no');
});

test('normalizeCodex coerces the {eligible} object shape (anomaly 1)', () => {
  assert.equal(normalizeCodex({ eligible: true }), 'ok');
  assert.equal(normalizeCodex({ eligible: false }), 'no');
  assert.equal(normalizeCodex({ eligible: true, reason: 'has verify' }), 'ok');
});

test('normalizeCodex maps anything else to null (never leaks a non-enum)', () => {
  assert.equal(normalizeCodex('maybe'), null);
  assert.equal(normalizeCodex(0), null);
  assert.equal(normalizeCodex(1), null);
  assert.equal(normalizeCodex({}), null);
  assert.equal(normalizeCodex({ eligible: 'yes' }), null);
  assert.equal(normalizeCodex([]), null);
});

// ── id assignment ────────────────────────────────────────────────────────────
test('merge assigns 1-based integer ids in fragment-then-task order', () => {
  const index = mergePlanFragments([
    frag('auth', [task('a1'), task('a2')]),
    frag('api', [task('b1')]),
  ]);
  assert.deepEqual(index.tasks.map((t) => t.id), [1, 2, 3]);
  for (const t of index.tasks) assert.ok(Number.isInteger(t.id));
  assert.equal(index.schema_version, '6.0');
});

test('merge normalises every task codex to the string enum in output', () => {
  const index = mergePlanFragments([
    frag('s', [
      task('obj', { codex: { eligible: true, reason: 'x' } }),
      task('bool', { codex: false, files: ['bool.js'] }),
      task('str', { codex: 'ok', files: ['str.js'] }),
    ]),
  ]);
  assert.equal(byDesc(index, 'obj').codex, 'ok');
  assert.equal(byDesc(index, 'bool').codex, 'no');
  assert.equal(byDesc(index, 'str').codex, 'ok');
  // And the produced index passes its own validator.
  assert.deepEqual(validatePlanIndex(index), []);
});

// ── wave layering: the anomaly-2 guard ───────────────────────────────────────
test('N disjoint no-dep tasks all land in wave 0 (anti-under-decomposition)', () => {
  const tasks = ['t1', 't2', 't3', 't4', 't5'].map((k) => task(k)); // distinct files
  const index = mergePlanFragments([frag('s', tasks)]);
  assert.deepEqual(index.tasks.map((t) => t.wave), [0, 0, 0, 0, 0]);
});

test('tasks sharing a file are serialised into different waves', () => {
  const index = mergePlanFragments([
    frag('s', [
      task('a', { files: ['shared.js'] }),
      task('b', { files: ['shared.js'] }),
    ]),
  ]);
  assert.notEqual(byDesc(index, 'a').wave, byDesc(index, 'b').wave);
});

test('a dependency forces the dependent into a strictly higher wave', () => {
  const index = mergePlanFragments([
    frag('s', [
      task('base', { files: ['base.js'] }),
      task('dep', { files: ['dep.js'], deps: ['base'] }),
    ]),
  ]);
  assert.ok(byDesc(index, 'dep').wave > byDesc(index, 'base').wave);
});

// THE load-bearing test: cross-fragment dep where the dependent has a LOWER id than its
// dependency (fragment order places the dependent first). id-order wave assignment breaks
// here; topological-order assignment is correct.
test('cross-fragment forward-reference dep waves correctly (lower-id dependent)', () => {
  const index = mergePlanFragments([
    // fragment B drafted/ordered FIRST → its task gets the lower id…
    frag('B', [task('b-consumer', { files: ['b.js'], deps: ['a-producer'] })]),
    // …but it depends on a task in fragment A, drafted second → higher id.
    frag('A', [task('a-producer', { files: ['a.js'] })]),
  ]);
  const consumer = byDesc(index, 'b-consumer');
  const producer = byDesc(index, 'a-producer');
  assert.equal(producer.id, 2);          // assigned second
  assert.equal(consumer.id, 1);          // assigned first (lower id)
  assert.equal(producer.wave, 0);        // no deps
  assert.equal(consumer.wave, 1);        // strictly after its dependency despite lower id
});

test('a diamond of cross-fragment deps layers to the longest path', () => {
  // a (w0) → b,c (w1) → d (w2). b and c are disjoint so they share wave 1.
  const index = mergePlanFragments([
    frag('top', [task('a', { files: ['a.js'] })]),
    frag('mid', [
      task('b', { files: ['b.js'], deps: ['a'] }),
      task('c', { files: ['c.js'], deps: ['a'] }),
    ]),
    frag('bot', [task('d', { files: ['d.js'], deps: ['b', 'c'] })]),
  ]);
  assert.equal(byDesc(index, 'a').wave, 0);
  assert.equal(byDesc(index, 'b').wave, 1);
  assert.equal(byDesc(index, 'c').wave, 1);
  assert.equal(byDesc(index, 'd').wave, 2);
});

// ── fail-loud invariants ─────────────────────────────────────────────────────
test('a dependency cycle fails loud rather than hanging', () => {
  assert.throws(
    () => mergePlanFragments([
      frag('s', [
        task('a', { deps: ['b'] }),
        task('b', { deps: ['a'] }),
      ]),
    ]),
    /cycle/i,
  );
});

test('a dangling dep (unknown key) fails loud', () => {
  assert.throws(
    () => mergePlanFragments([frag('s', [task('a', { deps: ['ghost'] })])]),
    /unknown|ghost/i,
  );
});

test('a duplicate task key across fragments fails loud', () => {
  assert.throws(
    () => mergePlanFragments([
      frag('A', [task('dup')]),
      frag('B', [task('dup')]),
    ]),
    /duplicate/i,
  );
});

// ── determinism ──────────────────────────────────────────────────────────────
test('merge is deterministic — same input yields byte-identical output', () => {
  const build = () => mergePlanFragments([
    frag('A', [task('a1', { deps: [] }), task('a2', { files: ['a1.js'] })]),
    frag('B', [task('b1', { deps: ['a1'] })]),
  ]);
  assert.equal(JSON.stringify(build()), JSON.stringify(build()));
});

test('merge does not mutate its input fragments', () => {
  const input = [frag('s', [task('a', { codex: { eligible: true } })])];
  const snapshot = JSON.stringify(input);
  mergePlanFragments(input);
  assert.equal(JSON.stringify(input), snapshot);
});

// ── validatePlanIndex: strict gate (also guards hand-authored / serial-path indexes) ──
test('validatePlanIndex accepts a clean index', () => {
  const index = mergePlanFragments([frag('s', [task('a'), task('b', { files: ['b.js'] })])]);
  assert.deepEqual(validatePlanIndex(index), []);
});

test('validatePlanIndex rejects a non-string codex (the silent-fallthrough trap)', () => {
  const bad = { schema_version: '6.0', tasks: [
    { id: 1, description: 'x', wave: 0, files: [], verify_commands: [], codex: { eligible: true } },
  ] };
  const errors = validatePlanIndex(bad);
  assert.ok(errors.some((e) => /codex/i.test(e)));
});

test('validatePlanIndex rejects non-integer id and wave', () => {
  const bad = { schema_version: '6.0', tasks: [
    { id: '1', description: 'x', wave: 0, files: [], verify_commands: [], codex: null },
    { id: 2, description: 'y', wave: 1.5, files: [], verify_commands: [], codex: null },
  ] };
  const errors = validatePlanIndex(bad);
  assert.ok(errors.some((e) => /id/i.test(e)));
  assert.ok(errors.some((e) => /wave/i.test(e)));
});

test('validatePlanIndex rejects duplicate ids and empty descriptions', () => {
  const bad = { schema_version: '6.0', tasks: [
    { id: 1, description: 'x', wave: 0, files: [], verify_commands: [], codex: null },
    { id: 1, description: '   ', wave: 1, files: [], verify_commands: [], codex: null },
  ] };
  const errors = validatePlanIndex(bad);
  assert.ok(errors.some((e) => /duplicate/i.test(e)));
  assert.ok(errors.some((e) => /description/i.test(e)));
});

test('validatePlanIndex rejects same-wave file overlap', () => {
  const bad = { schema_version: '6.0', tasks: [
    { id: 1, description: 'x', wave: 0, files: ['shared.js'], verify_commands: [], codex: null },
    { id: 2, description: 'y', wave: 0, files: ['shared.js'], verify_commands: [], codex: null },
  ] };
  const errors = validatePlanIndex(bad);
  assert.ok(errors.some((e) => /shared\.js/.test(e) && /wave/i.test(e)));
});

// ── renderPlanMd: plan.md is a deterministic projection of the index ─────────
test('renderPlanMd is deterministic and contains every task', () => {
  const index = mergePlanFragments([
    frag('s', [task('a'), task('b', { files: ['b.js'] }), task('c', { files: ['c.js'], deps: ['a'] })]),
  ]);
  const md1 = renderPlanMd(index, { title: 'Test plan' });
  const md2 = renderPlanMd(index, { title: 'Test plan' });
  assert.equal(md1, md2);
  for (const t of index.tasks) assert.ok(md1.includes(t.description), `plan.md missing "${t.description}"`);
  assert.ok(md1.includes('# Test plan'));
});

// ── renderPlanHtml: plan.html is a deterministic, escaped, self-contained projection ──
// A fixed index literal (not via mergePlanFragments) so statuses/fields are controlled.
const htmlIndex = {
  schema_version: '6.0',
  tasks: [
    { id: 1, description: 'do a', wave: 0, files: ['a.js'], verify_commands: ['test a'], codex: null },
    { id: 2, description: 'do b', wave: 0, files: ['b.js'], verify_commands: [], codex: 'ok' },
    { id: 3, description: 'do c', wave: 1, files: ['c.js'], verify_commands: ['test c'], codex: 'no', spec_refs: ['S1'] },
  ],
};

test('renderPlanHtml is deterministic and contains every task, every wave, and an inline SVG', () => {
  const h1 = renderPlanHtml(htmlIndex, { title: 'Test plan' });
  const h2 = renderPlanHtml(htmlIndex, { title: 'Test plan' });
  assert.equal(h1, h2);
  for (const t of htmlIndex.tasks) assert.ok(h1.includes(t.description), `plan.html missing "${t.description}"`);
  assert.ok(h1.includes('Test plan'));
  assert.ok(/Wave 0/.test(h1) && /Wave 1/.test(h1), 'both wave sections present');
  assert.ok(/<svg/.test(h1), 'expected an inline SVG wave diagram');
});

test('renderPlanHtml output is independent of task input order (determinism, no leak)', () => {
  const shuffled = { ...htmlIndex, tasks: [htmlIndex.tasks[2], htmlIndex.tasks[0], htmlIndex.tasks[1]] };
  assert.equal(renderPlanHtml(htmlIndex, { title: 'T' }), renderPlanHtml(shuffled, { title: 'T' }));
});

test('renderPlanHtml escapes untrusted fields and embeds no executable or remote markup', () => {
  const evil = {
    schema_version: '6.0',
    tasks: [{
      id: 1,
      description: '<script>alert(1)</script>',
      wave: 0,
      files: ['<img src=x onerror=alert(1)>'],
      verify_commands: ['echo "&"'],
      codex: null,
      spec_refs: ['<b>ref</b>'],
    }],
  };
  const h = renderPlanHtml(evil, { title: '<title-inject>' });
  // With full escaping, the only real tags are the renderer's own — and it emits no
  // script/img/iframe/link. Untrusted '<' must survive only as escaped text.
  assert.ok(!h.includes('<script'), 'raw <script leaked into output');
  assert.ok(!h.includes('<img'), 'raw <img leaked into output');
  assert.ok(!/<(iframe|link)\b/i.test(h), 'no remote-resource tags');
  assert.ok(h.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'description must be HTML-escaped');
  assert.ok(h.includes('&lt;img src=x onerror=alert(1)&gt;'), 'file value must be HTML-escaped');
});

test('renderPlanHtml numerically coerces id/wave so a corrupted index cannot inject markup through them', () => {
  // render-plan does not run validatePlanIndex, so a hand-edited index could carry string id/wave.
  const bad = {
    schema_version: '6.0',
    tasks: [{ id: '1<script>', description: 'x', wave: '0"><script>alert(1)</script>', files: [] }],
  };
  const h = renderPlanHtml(bad, { title: 'T' });
  assert.ok(!h.includes('<script'), 'id/wave must be coerced to numbers, never interpolated as raw markup');
});

test('renderPlanHtml status badges reflect meta.taskStatus; unknown and missing fall back to pending', () => {
  const h = renderPlanHtml(htmlIndex, { title: 'T', taskStatus: { 1: 'done', 2: 'bogus' } });
  // Assert on the badge element class (not bare 'status-done', which appears in the inline CSS).
  assert.ok(h.includes('badge status-done'), 'id 1 → done');
  assert.ok(h.includes('badge status-pending'), 'id 2 bogus→pending and id 3 missing→pending');
  assert.ok(!h.includes('badge status-bogus'), 'unknown status must never become a CSS class (whitelist)');
});

test('renderPlanHtml with no taskStatus renders every task as pending', () => {
  const h = renderPlanHtml(htmlIndex, { title: 'T' });
  assert.ok(h.includes('badge status-pending'));
  assert.ok(!h.includes('badge status-done') && !h.includes('badge status-failed'));
});

// ── renderPlanHtml: F4 narrative / refs / amendments / assets (the render HUB) ──
// bundleDir + an injectable fileExists let the trust boundary run fully offline: no disk,
// no clock. Presence (not any render flag) decides img/link emission.
const richIndex = {
  schema_version: '6.0',
  tasks: [
    { id: 1, description: 'do a', wave: 0, files: ['a.js'], verify_commands: ['test a'], codex: null, goals: ['G1', 'G2'] },
    { id: 2, description: 'do b', wave: 1, files: ['b.js'], verify_commands: [], codex: 'ok', goals: ['G2'] },
  ],
};

const amendMd = [
  '# Plan', '', '## Amendments', '',
  '### 2026-07-06 — widen scope', 'added task 2 for the API layer',
  '', '### 2026-07-07 — trim verify', 'dropped a redundant check',
].join('\n');

test('renderPlanHtml renders narrative, refs, amendments and goals offline', () => {
  const metaArg = {
    title: 'Rich plan',
    bundleDir: '/repo/docs/masterplan/self',
    fileExists: (p) => p === '/repo/docs/masterplan/other/plan.html',
    narrative: { purpose: 'Do the thing', problem: 'It is broken', solution: 'Fix it deterministically' },
    refs: { back: [{ slug: 'other', label: 'Predecessor' }], forward: [] },
    amendmentsMd: amendMd,
  };
  const h = renderPlanHtml(richIndex, metaArg);
  assert.ok(/Purpose/.test(h) && h.includes('Do the thing'), 'purpose narrative present');
  assert.ok(/Problem/.test(h) && h.includes('It is broken'), 'problem narrative present');
  assert.ok(/Solution/.test(h) && h.includes('Fix it deterministically'), 'solution narrative present');
  assert.ok(h.includes('href="../other/plan.html"'), 'resolvable same-repo ref links to target plan.html');
  assert.ok(h.includes('Predecessor'), 'ref label rendered');
  assert.ok(/Amendments/.test(h), 'amendments section present');
  assert.ok(h.includes('widen scope') && h.includes('trim verify'), 'both amendment summaries present');
  assert.ok(h.includes('2026-07-06') && h.includes('2026-07-07'), 'amendment dates present');
  assert.ok(h.includes('added task 2 for the API layer'), 'amendment detail present');
  assert.ok(/Goals/.test(h) && h.includes('G1') && h.includes('G2'), 'goals block present');
  assert.equal(h, renderPlanHtml(richIndex, metaArg), 'render is deterministic (offline)');
});

test('renderPlanHtml embeds no <img> when assets are absent (by-presence)', () => {
  const h = renderPlanHtml(richIndex, {
    title: 'T',
    bundleDir: '/repo/docs/masterplan/self',
    fileExists: () => false,
  });
  assert.ok(!h.includes('<img'), 'absent assets must produce no <img>');
});

test('renderPlanHtml embeds present assets by slot name via relative src', () => {
  const present = new Set([
    '/repo/docs/masterplan/self/assets/hero.png',
    '/repo/docs/masterplan/self/assets/wave-0.png',
  ]);
  const h = renderPlanHtml(richIndex, {
    title: 'T',
    bundleDir: '/repo/docs/masterplan/self',
    fileExists: (p) => present.has(p),
  });
  assert.ok(h.includes('src="assets/hero.png"'), 'hero embeds by slot name, relative src');
  assert.ok(h.includes('src="assets/wave-0.png"'), 'wave-0 embeds by slot name, relative src');
  assert.ok(!h.includes('src="assets/wave-1.png"'), 'absent wave-1 asset is not embedded');
});

test('renderPlanHtml renders a same-repo ref as plain text when the target has no plan.html', () => {
  const h = renderPlanHtml(richIndex, {
    title: 'T',
    bundleDir: '/repo/docs/masterplan/self',
    fileExists: () => false,
    refs: { back: [{ slug: 'ghost' }], forward: [] },
  });
  assert.ok(!h.includes('href='), 'no link when the target plan.html is absent (never a broken link)');
  assert.ok(h.includes('ghost'), 'ref still surfaces as plain text');
});

test('renderPlanHtml renders <script>/quote fixtures in meta, ref labels and amendments inert', () => {
  const h = renderPlanHtml(richIndex, {
    title: 'T',
    bundleDir: '/repo/docs/masterplan/self',
    fileExists: () => false,
    narrative: { purpose: '<script>alert(1)</script>', problem: '"><img src=x>', solution: 'ok' },
    refs: { back: [{ slug: 'other', label: '<script>evil</script>' }], forward: [] },
    amendmentsMd: ['## Amendments', '', '### 2026-07-06 — <script>boom</script>', 'detail "<img src=x onerror=alert(1)>"'].join('\n'),
  });
  assert.ok(!h.includes('<script'), 'no raw <script from any user-controlled string');
  assert.ok(!/<img\s+src=x/i.test(h), 'no raw <img from meta/amendment fixtures');
  assert.ok(h.includes('&lt;script&gt;'), 'user script fixtures survive only as escaped text');
});

test('resolveAssetSrc rejects path traversal outside the bundle assets/ dir', () => {
  const bundle = '/repo/docs/masterplan/self';
  assert.equal(resolveAssetSrc(bundle, '../../../etc/passwd'), null);
  assert.equal(resolveAssetSrc(bundle, '../secret'), null);
  const ok = resolveAssetSrc(bundle, 'hero');
  assert.equal(ok.rel, 'assets/hero.png');
});

test('resolveRefTarget re-validates the stored slug and rejects traversal outside the repo root', () => {
  const bundle = '/repo/docs/masterplan/self';
  assert.equal(resolveRefTarget(bundle, { slug: '../evil' }), null);
  assert.equal(resolveRefTarget(bundle, { slug: 'a/b' }), null);
  assert.equal(resolveRefTarget(bundle, { slug: '..' }), null);
  const t = resolveRefTarget(bundle, { slug: 'other' });
  assert.equal(t.rel, '../other/plan.html');
  assert.ok(t.abs.startsWith('/repo/'));
  const c = resolveRefTarget(bundle, { slug: 'x', repo: '/other-repo' });
  assert.ok(c.abs.startsWith('/other-repo/'));
});

test('parseAmendments extracts ordered timeline entries from the ## Amendments block', () => {
  const entries = parseAmendments(amendMd);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], { date: '2026-07-06', summary: 'widen scope', detail: 'added task 2 for the API layer' });
  assert.equal(entries[1].summary, 'trim verify');
  assert.deepEqual(parseAmendments('# Plan\n\nno section here'), []);
});

// ── goal tracking ────────────────────────────────────────────────────────────
test('mergePlanFragments carries per-task goals through to the emitted index', () => {
  const index = mergePlanFragments([
    frag('s', [
      task('a', { goals: ['G1', 'G2'] }),
      task('b', { files: ['b.js'] }),
    ]),
  ]);
  assert.deepEqual(byDesc(index, 'a').goals, ['G1', 'G2']);
  assert.deepEqual(byDesc(index, 'b').goals, []);
});

test('validatePlanIndex flags an uncovered non-tombstoned goal', () => {
  const index = mergePlanFragments([frag('s', [task('a', { goals: ['G1'] })])]);
  const errors = validatePlanIndex(index, [{ id: 'G1' }, { id: 'G2' }]);
  assert.ok(errors.some((e) => e.includes('G2') && e.includes('covered')), 'G2 must be flagged as uncovered');
  assert.ok(!errors.some((e) => e.includes('G1')), 'G1 must not be flagged');
});

test('validatePlanIndex flags a task citing an unknown goal', () => {
  const index = mergePlanFragments([frag('s', [task('a', { goals: ['G1', 'GX'] })])]);
  const errors = validatePlanIndex(index, [{ id: 'G1' }]);
  assert.ok(errors.some((e) => e.includes('GX') && e.includes('unknown')), 'GX must be flagged as unknown');
});

test('validatePlanIndex exempts a tombstoned goal from coverage', () => {
  const index = mergePlanFragments([frag('s', [task('a', { goals: ['G1'] })])]);
  const errors = validatePlanIndex(index, [{ id: 'G1' }, { id: 'G2', tombstone: true }]);
  assert.ok(!errors.some((e) => e.includes('G2')), 'tombstoned G2 must not be flagged as uncovered');

  const index2 = mergePlanFragments([frag('s', [task('a', { goals: ['G1', 'G2'] })])]);
  const errors2 = validatePlanIndex(index2, [{ id: 'G1' }, { id: 'G2', tombstone: true }]);
  assert.ok(!errors2.some((e) => e.includes('unknown')), 'citing a tombstoned goal must not be an unknown-ref error');
});

test('validatePlanIndex with an empty goals list is a no-op (pre-feature bundles)', () => {
  const index = mergePlanFragments([
    frag('s', [task('a', { goals: ['G1'] }), task('b', { files: ['b.js'] })]),
  ]);
  assert.deepEqual(validatePlanIndex(index), []);
  assert.deepEqual(validatePlanIndex(index, []), []);
});
