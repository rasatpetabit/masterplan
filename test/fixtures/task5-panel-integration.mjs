// Read-only joint-checkout integration helper. C5 owns selection/recovery;
// synthetic callbacks are the only runners, so no provider or child Pi starts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const { W, launches, ceiling, map: fixture } = JSON.parse(fs.readFileSync(0, 'utf8'));
assert.ok(W && path.isAbsolute(W) && fs.statSync(W).isDirectory());
const fromCheckout = (relative) => import(pathToFileURL(path.join(W, 'pi-subagents', relative)).href);
const { resolveDispatch, executePanel } = await fromCheckout('engine/standalone/resolve-dispatch.mjs');
const { admitReviewLaunch, resolvedReviewSpec } = await fromCheckout('engine/runs/shared/review-admission.ts');
const { createDispatchReceipt, startDispatchAttempt, finishDispatchAttempt } = await fromCheckout('engine/runs/shared/dispatch-receipt.ts');
for (const fn of [resolveDispatch, executePanel, admitReviewLaunch, resolvedReviewSpec,
  createDispatchReceipt, startDispatchAttempt, finishDispatchAttempt]) assert.equal(typeof fn, 'function');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task5-c7-panel-'));
try {
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const db = path.join(root, 'state.db');
  const mapPath = path.join(root, 'dispatch-map.json');
  fs.writeFileSync(mapPath, JSON.stringify(fixture));
  const policy = path.join(root, 'policy.toml');
  fs.writeFileSync(policy, `[settings]\nstate_db = ${JSON.stringify(db)}\ndispatch_map = ${JSON.stringify(mapPath)}\n`);
  process.env.AGENT_HOOKS_POLICY = policy;
  process.env.HOME = home;
  delete process.env.PYTHONOPTIMIZE;
  process.env.PYTHONDONTWRITEBYTECODE = '1';
  const summary = { admissions: 0, denials: 0, deniedChildren: 0, complete: 0,
    incomplete: 0, recoveryAttempts: 0, subject: launches[0].descriptor.subject };
  assert.equal(launches.length, ceiling + 1);
  const counters = () => JSON.parse(execFileSync('python3', ['-c',
    'import json, sqlite3, sys; c=sqlite3.connect(sys.argv[1]); print(json.dumps(list(c.execute("select key, value from kv where scope=\'review_rounds\' and key like \'rounds:%\'"))))', db],
  { encoding: 'utf8' }));
  let counterKey;
  const assertRounds = (expected) => {
    const rows = counters();
    assert.equal(rows.length, 1, 'all linked-worktree launches share one counter');
    counterKey ??= rows[0][0]; // Hook-owned hashed key; never reproduce its algorithm.
    assert.equal(rows[0][0], counterKey, 'the canonical episode keeps its counter');
    assert.equal(JSON.parse(rows[0][1]), expected, 'seats/recovery cannot reserve extra rounds');
  };
  for (const [index, { descriptor, head, attempt, token, map: launchMap }] of launches.entries()) {
    assert.equal(descriptor.subject, summary.subject);
    assert.ok(head && attempt && token);
    const map = structuredClone(launchMap ?? fixture);
    // The additional fixture pool member makes one recovery possible without
    // prescribing any selected model. Selection and floors remain C2/C5-owned.
    if (index === 0) map.panels.critical.lists.push('pro');
    const request = Object.fromEntries(['agent', 'usecase', 'stakes', 'raiseTier', 'raiseEffort',
      'independentOf', 'noSubstitute', 'blocking', 'subject'].filter(k => Object.hasOwn(descriptor, k)).map(k => [k, descriptor[k]]));
    const decision = resolveDispatch(map, request);
    assert.equal(decision.kind, 'panel');
    assert.equal(decision.seats.length, 3);
    if (launchMap) assert.equal(decision.seats[0].model, launchMap.lists.frontier.models[0].model,
      'test policy replacement changes reviewer identity, not the episode subject');
    let children = 0;
    const incomplete = index === 1;
    // The harness consumes one producer descriptor. Its real admission adapter
    // expands the resolved panel at C7, not masterplan. Reviewer wording changes
    // across launches, while subject remains the canonical producer value.
    const task = `Review only src/a.txt lines 1-20 for ${index % 2 ? 'recovery identity' : 'artifact identity'}; return at most 4 findings.`;
    // Admission alternates the linked checkout and its primary repository;
    // qualification must not create a second episode for either cwd.
    const cwd = index % 2 ? descriptor.subject.split('::')[0] : descriptor.repo;
    const admit = () => admitReviewLaunch({ sessionId: 'isolated-task5', cwd,
      launchId: `task5-launch-${index}`, hooksRoot: path.join(W, 'hooks'), home,
      specs: [resolvedReviewSpec(decision, task, cwd, descriptor.subject)] });
    if (index === ceiling) {
      await assert.rejects(async () => { await admit(); children++; }, /review.*round|circuit.breaker/i);
      assert.equal(children, 0);
      summary.denials++;
      summary.deniedChildren += children;
      assertRounds(ceiling + 1);
      continue;
    }
    await admit();
    summary.admissions++;
    const receiptFor = (input, candidate, success) => {
      const receipt = input.receipt ?? createDispatchReceipt(input.decision, input.request,
        input.requestedEffort ?? input.decision.requestedEffort);
      assert.equal(receipt.subject, descriptor.subject);
      assert.equal(receipt.servedModel, null);
      assert.equal(receipt.servedEffort, null);
      startDispatchAttempt(receipt, candidate);
      assert.equal(receipt.attempts.at(-1).servedEffort, null);
      finishDispatchAttempt(receipt, success ? 'success' : 'provider-error', success ? undefined : 'synthetic unavailable',
        success ? { model: candidate.model, servedEffort: candidate.servedEffort } : undefined);
      if (success) {
        assert.equal(receipt.servedModel, candidate.model);
        assert.equal(receipt.servedEffort, candidate.servedEffort);
      }
      return receipt;
    };
    const result = await executePanel(map, request, decision, {
      async runSeat(input) {
        children++;
        assert.equal(input.request.subject, descriptor.subject);
        const failing = input.seat === 0 && (incomplete || (index === 0 && input.attempt === 0));
        if (input.attempt > 0) {
          summary.recoveryAttempts++;
          // Re-admitting the same native logical launch is idempotent; neither
          // panel seats nor recovery get another budget reservation.
          await admit();
        }
        return { status: failing ? 'retryable-error' : 'success',
          ...(failing ? {} : { report: { seat: input.seat, checked: descriptor.diff_sha } }),
          receipt: receiptFor(input, input.candidate, !failing) };
      },
      async runAdjudicator(input) {
        children++;
        assert.equal(incomplete, false, 'incomplete panel cannot adjudicate');
        assert.equal(input.request.usecase, 'adjudicate');
        assert.equal(input.request.subject, descriptor.subject);
        assert.deepEqual(input.reports.map(r => r.seat), [0, 1, 2]);
        return { status: 'success', verdict: 'supported', report: { reviewed: input.reports },
          receipt: receiptFor(input, input.decision.candidates[0], true) };
      },
    });
    if (incomplete) {
      assert.equal(result.verdict, 'inconclusive');
      assert.deepEqual(result.unfilledSeats, [0]);
      assert.deepEqual(result.reports.map(r => r.seat), [1, 2]);
      assert.equal(result.receipts.adjudicator, null);
      assert.equal(children, 3);
      summary.incomplete++;
    } else {
      assert.equal(result.verdict, 'supported');
      assert.equal(result.reports.length, 3);
      assert.deepEqual(result.unfilledSeats, []);
      assert.equal(children, index === 0 ? 5 : 4);
      summary.complete++;
    }
    for (const receipt of [...result.receipts.seats, result.receipts.adjudicator].filter(Boolean)) {
      assert.equal(receipt.subject, descriptor.subject);
      assert.ok(receipt.attempts.length > 0);
    }
    // Inspect the real isolated SQLite store after each launch. A three-seat
    // panel and its recovered seat reserve exactly ONE round for this subject.
    assertRounds(index + 1);
  }
  console.log(JSON.stringify(summary));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
