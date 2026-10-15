// test/goal-removal-compat.test.mjs — Step 1: lock goals hash compatibility
// before removing goal blocks.
//
// Guards:
// (a) Hash stability from source for every committed bundle in docs/masterplan/*/goals.md
//     that has a goals lineage in events.jsonl. The hash is computed through the
//     production seam (pinnedGoalsEvidenceHash / resolveFormatPin) and asserted equal
//     to the latest lineage hash in events.jsonl, and goals.md bytes are asserted
//     identical to git HEAD.
// (b) Zero-G documents: documents with only a topic: anchor and a ## Intent block
//     (legacy/v2 and schema_backed versioned) parse with goals: [] and hash under
//     both applicable pins without throwing; stripped-representation downgrade under
//     schema_backed still throws.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  parseGoals,
  goalsHash,
  encodeIntentBlock,
  decodeIntent,
  INTENT_CODEC_VERSION,
} from '../lib/goals.mjs';
import {
  buildSeedState,
  writeState,
  resolveFormatPin,
} from '../lib/bundle.mjs';
import { pinnedGoalsEvidenceHash } from '../lib/promote.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNS_DIR = path.join(REPO_ROOT, 'docs', 'masterplan');

// ---------------------------------------------------------------------------
// (a) Hash stability from source, not literals
// ---------------------------------------------------------------------------

test('(a) committed bundles with goals lineage match latest lineage hash via durable format pin seam', () => {
  assert.ok(fs.existsSync(RUNS_DIR), `runs directory must exist at ${RUNS_DIR}`);

  const entries = fs.readdirSync(RUNS_DIR, { withFileTypes: true });
  const bundlesChecked = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const slug = entry.name;
    const bundleDir = path.join(RUNS_DIR, slug);
    const goalsMdPath = path.join(bundleDir, 'goals.md');
    const eventsPath = path.join(bundleDir, 'events.jsonl');
    const statePath = path.join(bundleDir, 'state.yml');

    if (!fs.existsSync(goalsMdPath) || !fs.existsSync(eventsPath)) {
      continue;
    }

    const eventsContent = fs.readFileSync(eventsPath, 'utf8');
    const events = eventsContent
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    // Lineage events are goals_frozen and goal_amended
    const lineage = events.filter((e) => e && (e.type === 'goals_frozen' || e.type === 'goal_amended'));
    if (lineage.length === 0) {
      continue;
    }

    // Extract the latest lineage hash
    const lastEvent = lineage[lineage.length - 1];
    const data = lastEvent.data && typeof lastEvent.data === 'object' ? lastEvent.data : lastEvent;
    const latestRecordedHash =
      lastEvent.type === 'goal_amended'
        ? (data.goals_hash ?? data.new_goals_hash ?? data.new_hash ?? data.hash)
        : (data.goals_hash ?? data.hash);

    assert.ok(
      typeof latestRecordedHash === 'string' && latestRecordedHash.startsWith('sha256:'),
      `bundle ${slug} must carry a valid sha256 lineage hash in event ${lastEvent.type}`,
    );

    // Compute hash via the SAME production seam used by the CLI (pinnedGoalsHash -> pinnedGoalsEvidenceHash)
    assert.ok(fs.existsSync(statePath), `bundle ${slug} must have state.yml`);
    const goalsMdText = fs.readFileSync(goalsMdPath, 'utf8');
    const computedHash = pinnedGoalsEvidenceHash(statePath, goalsMdText);

    // Also verify resolveFormatPin aligns with the computation
    const pinResolution = resolveFormatPin(statePath);
    assert.ok(
      pinResolution.pin === 'legacy' || pinResolution.pin === 'schema_backed',
      `bundle ${slug} format pin must resolve to 'legacy' or 'schema_backed', got ${JSON.stringify(pinResolution)}`,
    );
    const directGoalsHash = goalsHash(goalsMdText, { formatPin: pinResolution.pin });
    assert.equal(
      computedHash,
      directGoalsHash,
      `pinnedGoalsEvidenceHash and goalsHash({ formatPin: ${pinResolution.pin} }) must agree for bundle ${slug}`,
    );

    // Assert computed equals the latest lineage hash recorded in events.jsonl
    assert.equal(
      computedHash,
      latestRecordedHash,
      `bundle ${slug} computed goals hash must match latest lineage hash recorded in events.jsonl`,
    );

    // Assert that the on-disk goals.md bytes are unchanged versus git HEAD
    const relGoalsMdPath = path.relative(REPO_ROOT, goalsMdPath);
    const headBytes = execFileSync('git', ['-C', REPO_ROOT, 'show', `HEAD:${relGoalsMdPath}`]);
    const diskBytes = fs.readFileSync(goalsMdPath);
    assert.equal(
      Buffer.compare(diskBytes, headBytes),
      0,
      `bytes of ${relGoalsMdPath} must be byte-identical to git HEAD`,
    );

    bundlesChecked.push({ slug, pin: pinResolution.pin, hash: computedHash });
  }

  // Ensure we checked all expected committed bundles with goals lineage
  const checkedSlugs = bundlesChecked.map((b) => b.slug).sort();
  const expectedSlugs = [
    'blocked-task-injection',
    'dispatch-subagent-reconcile',
    'fabric-default-dual-reg',
    'intent-to-completion',
    'planf3-ideas',
    'simplify-dedup-2',
    'v10-validation',
  ].sort();

  for (const expected of expectedSlugs) {
    assert.ok(
      checkedSlugs.includes(expected),
      `expected committed bundle ${expected} to be checked for goals lineage hash stability`,
    );
  }
  assert.ok(bundlesChecked.length >= 7, `must have checked at least 7 bundles, checked ${bundlesChecked.length}`);
});

test('(a) no committed bundle has goals lineage events without a goals.md', () => {
  const entries = fs.readdirSync(RUNS_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const slug = entry.name;
    const bundleDir = path.join(RUNS_DIR, slug);
    const goalsMdPath = path.join(bundleDir, 'goals.md');
    const eventsPath = path.join(bundleDir, 'events.jsonl');
    if (!fs.existsSync(eventsPath)) continue;

    const eventsContent = fs.readFileSync(eventsPath, 'utf8');
    const events = eventsContent
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    const lineage = events.filter((e) => e && (e.type === 'goals_frozen' || e.type === 'goal_amended'));
    if (lineage.length > 0) {
      assert.ok(
        fs.existsSync(goalsMdPath),
        `bundle ${slug} carries goals lineage events but is missing goals.md`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// (b) Zero-G documents: topic anchor + ## Intent only
// ---------------------------------------------------------------------------

function makeTempBundle(formatPin) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zero-g-test-'));
  const statePath = path.join(tmpDir, 'state.yml');
  writeState(
    statePath,
    {
      ...buildSeedState({
        slug: 'zero-g-test',
        topic: 'Zero-G compatibility test bundle',
        createdAt: '2026-10-14T00:00:00.000Z',
        complexity: 'low',
      }),
      format_pin: formatPin,
    },
  );
  return {
    tmpDir,
    statePath,
    cleanup: () => {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    },
  };
}

test('(b) zero-G legacy/v2 Intent document parses with goals: [] and hashes under legacy pin', () => {
  const legacyZeroG = [
    'topic: |',
    '  Build the zero-G compatibility lock.',
    '## Intent',
    'why: remove numbered goal blocks while keeping intent block as the standard',
    'outcome: zero-G documents parse and hash stably without requiring G blocks',
    'anti_goals:',
    '- do not break archived bundle hashes',
    '- do not allow silent format-pin downgrades',
    'done_means: test suite passes and hash compatibility locked',
    '',
  ].join('\n');

  // 1. parseGoals produces goals: []
  const parsed = parseGoals(legacyZeroG);
  assert.equal(parsed.topicSeed, 'Build the zero-G compatibility lock.');
  assert.deepEqual(parsed.goals, []);
  assert.ok(parsed.intent, 'intent block must be parsed');
  assert.equal(parsed.intent.why, 'remove numbered goal blocks while keeping intent block as the standard');
  assert.equal(parsed.intent.outcome, 'zero-G documents parse and hash stably without requiring G blocks');
  assert.deepEqual(parsed.intent.anti_goals, [
    'do not break archived bundle hashes',
    'do not allow silent format-pin downgrades',
  ]);
  assert.equal(parsed.intent.done_means, 'test suite passes and hash compatibility locked');

  // 2. Hashing under legacy pin (both explicitly and as default) does not throw
  const hashDefault = goalsHash(legacyZeroG);
  const hashLegacy = goalsHash(legacyZeroG, { formatPin: 'legacy' });
  assert.match(hashLegacy, /^sha256:[0-9a-f]{64}$/);
  assert.equal(hashDefault, hashLegacy, 'default hash and explicit formatPin: legacy must match');

  // 3. Hash through production seam with a legacy-pinned bundle state
  const bundle = makeTempBundle('legacy');
  try {
    const pinnedHash = pinnedGoalsEvidenceHash(bundle.statePath, legacyZeroG);
    assert.equal(pinnedHash, hashLegacy, 'pinnedGoalsEvidenceHash under legacy pin must match goalsHash');
  } finally {
    bundle.cleanup();
  }

  // 4. Downgrade refusal: attempting to hash a legacy zero-G document under schema_backed pin throws
  assert.throws(
    () => goalsHash(legacyZeroG, { formatPin: 'schema_backed' }),
    /format-pin downgrade refused/,
  );
  const schemaBundle = makeTempBundle('schema_backed');
  try {
    assert.throws(
      () => pinnedGoalsEvidenceHash(schemaBundle.statePath, legacyZeroG),
      /format-pin downgrade refused/,
    );
  } finally {
    schemaBundle.cleanup();
  }
});

test('(b) zero-G schema_backed versioned document parses with goals: [] and hashes under both pins', () => {
  const authoritative = {
    version: INTENT_CODEC_VERSION,
    schema: { identity: 'design-intent@zero-g', format_version: 1 },
    sections: {
      purpose: { body: 'Verify zero-G hash stability under versioned schema-backed representation.' },
      non_goals: { items: ['no numbered G blocks required', 'no second canonicalizer'] },
      top_invariant: { body: 'Both canonicalizers accept empty goals list byte-identically.' },
      direction: { body: 'Intent is the primary standard of completed work.' },
      posture: { body: 'Fail closed on downgrade or malformed intent.' },
    },
    context: {
      outcome: { body: 'Zero-G schema-backed document hashes without throwing.' },
      done_means: { body: 'release' },
    },
    evidence: [{ section: 'purpose', source: 'operator design review 2026-10-14' }],
    reconciliation: [{ target: 'repository INTENT.md §1', status: 'verified' }],
  };

  const enc = encodeIntentBlock(authoritative);
  assert.ok(enc.ok, `encodeIntentBlock must succeed: ${JSON.stringify(enc)}`);

  const schemaBackedZeroG = `topic: |\n  Versioned zero-G topic.\n${enc.block}\n`;

  // 1. decodeIntent and validateIntentBinding confirm validity
  const dec = decodeIntent(schemaBackedZeroG);
  assert.equal(dec.versioned, true);
  assert.equal(dec.error, undefined);
  assert.ok(dec.authoritative);

  // 2. parseGoals produces goals: []
  const parsed = parseGoals(schemaBackedZeroG);
  assert.equal(parsed.topicSeed, 'Versioned zero-G topic.');
  assert.deepEqual(parsed.goals, []);

  // 3. Hashes under schema_backed pin without throwing
  const richHash = goalsHash(schemaBackedZeroG, { formatPin: 'schema_backed' });
  assert.match(richHash, /^sha256:[0-9a-f]{64}$/);

  // 4. Hashes under legacy pin without throwing
  const legHash = goalsHash(schemaBackedZeroG, { formatPin: 'legacy' });
  assert.match(legHash, /^sha256:[0-9a-f]{64}$/);
  const defHash = goalsHash(schemaBackedZeroG);
  assert.equal(defHash, legHash, 'default hash must match formatPin: legacy');

  // Both pins produce valid but distinct hashes
  assert.notEqual(richHash, legHash, 'schema_backed and legacy pins must produce distinct hashes for versioned doc');

  // Production seam testing with durable bundle pins
  const schemaBundle = makeTempBundle('schema_backed');
  const legacyBundle = makeTempBundle('legacy');
  try {
    // Production seam under schema_backed pin
    const pinnedRich = pinnedGoalsEvidenceHash(schemaBundle.statePath, schemaBackedZeroG);
    assert.equal(pinnedRich, richHash, 'pinnedGoalsEvidenceHash under schema_backed must match goalsHash');

    // Production seam under legacy pin
    const pinnedLeg = pinnedGoalsEvidenceHash(legacyBundle.statePath, schemaBackedZeroG);
    assert.equal(pinnedLeg, legHash, 'pinnedGoalsEvidenceHash under legacy must match goalsHash');

    // 5. Stripped-representation downgrade under schema_backed pin still throws:
    // (5a) completely stripped of intent:
    const strippedDoc = 'topic: |\n  Versioned zero-G topic with stripped intent.\n';
    assert.throws(
      () => goalsHash(strippedDoc, { formatPin: 'schema_backed' }),
      /format-pin downgrade refused/,
    );
    assert.throws(
      () => pinnedGoalsEvidenceHash(schemaBundle.statePath, strippedDoc),
      /format-pin downgrade refused/,
    );

    // (5b) replaced with legacy/v2 Intent block:
    const replacedLegacyDoc = [
      'topic: |',
      '  Downgraded zero-G topic.',
      '## Intent',
      'why: attempt downgrade',
      'outcome: failure',
      'anti_goals:',
      '- none',
      'done_means: error',
      '',
    ].join('\n');
    assert.throws(
      () => goalsHash(replacedLegacyDoc, { formatPin: 'schema_backed' }),
      /format-pin downgrade refused/,
    );
    assert.throws(
      () => pinnedGoalsEvidenceHash(schemaBundle.statePath, replacedLegacyDoc),
      /format-pin downgrade refused/,
    );

    // 6. Unknown format pin throws loudly
    assert.throws(
      () => goalsHash(schemaBackedZeroG, { formatPin: 'v3-invalid' }),
      /unknown format pin/,
    );

    // 7. Malformed versioned representation under schema_backed throws
    const malformedDoc = schemaBackedZeroG.replace('"version": 1', '"version": 99');
    assert.throws(
      () => goalsHash(malformedDoc, { formatPin: 'schema_backed' }),
      /unknown intent codec version 99/,
    );
  } finally {
    schemaBundle.cleanup();
    legacyBundle.cleanup();
  }
});
