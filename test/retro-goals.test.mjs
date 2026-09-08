import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderRetroGoals, escapeCell, latestEventData, classifyCompletionForRetro, archivePushedState, renderRetroSummary, upsertRetroCompletion } from '../lib/retro-goals.mjs';

test('returns empty string when goals not enabled', () => {
	const result1 = renderRetroGoals({ goalsEnabled: false, goals: [{ id: 'G1', text: 'x' }] });
	assert.equal(result1, '');

	const result2 = renderRetroGoals({ goals: [{ id: 'G1', text: 'x' }] });
	assert.equal(result2, '');
});

test('renders table with heading and header row for active goals', () => {
	const goals = [
		{ id: 'G1', text: 'First goal' },
		{ id: 'G2', text: 'Second goal' },
	];
	const str = renderRetroGoals({ goalsEnabled: true, goals });

	assert.ok(str.includes('## Goal verdicts'));
	assert.ok(str.includes('| Goal | Statement | Verdict | Evidence | Waiver |'));
	assert.ok(str.includes('| --- | --- | --- | --- | --- |'));
	assert.ok(str.includes('G1'));
	assert.ok(str.includes('First goal'));
	assert.ok(str.includes('G2'));
	assert.ok(str.includes('Second goal'));

	// Check for em dashes in verdict/evidence/waiver columns
	const lines = str.split('\n');
	const g1Line = lines.find((l) => l.includes('G1'));
	assert.ok(g1Line);
	// The row should have em dashes for verdict, evidence, waiver
	assert.ok(g1Line.includes('—'));

	assert.ok(!str.endsWith('\n'));
});

test('fills verdict and evidence from latest goal_check event', () => {
	const goals = [{ id: 'G1', text: 'ship it' }];
	const events = [
		{
			type: 'goal_check',
			ts: '2023-01-01T00:00:00Z',
			data: {
				verdicts: {
					G1: { verdict: 'achieved', evidence: 'tests pass' },
				},
			},
		},
	];
	const str = renderRetroGoals({ goalsEnabled: true, goals, events });

	assert.ok(str.includes('achieved'));
	assert.ok(str.includes('tests pass'));
});

test('uses the LATEST goal_check when multiple present', () => {
	const goals = [{ id: 'G1', text: 'goal one' }];
	const events = [
		{
			type: 'goal_check',
			ts: '2023-01-01T00:00:00Z',
			data: {
				verdicts: {
					G1: { verdict: 'missed', evidence: 'old evidence' },
				},
			},
		},
		{
			type: 'goal_check',
			ts: '2023-01-02T00:00:00Z',
			data: {
				verdicts: {
					G1: { verdict: 'achieved', evidence: 'new evidence' },
				},
			},
		},
	];
	const str = renderRetroGoals({ goalsEnabled: true, goals, events });

	assert.ok(str.includes('achieved'));
	assert.ok(!str.includes('missed'));
});

test('renders waiver from goal_waived reasons', () => {
	const goals = [{ id: 'G1', text: 'goal one' }];
	const events = [
		{
			type: 'goal_check',
			ts: '2023-01-01T00:00:00Z',
			data: {
				verdicts: {
					G1: { verdict: 'missed', evidence: 'failed' },
				},
			},
		},
		{
			type: 'goal_waived',
			ts: '2023-01-01T00:00:00Z',
			data: {
				reasons: {
					G1: 'accepted risk',
				},
			},
		},
	];
	const str = renderRetroGoals({ goalsEnabled: true, goals, events });

	assert.ok(str.includes('waived: accepted risk'));
});

test('lists tombstoned goals with reasons', () => {
	const goals = [
		{ id: 'G1', text: 'active one' },
		{
			id: 'G2',
			text: 'old',
			tombstone: { reason: 'superseded by G3', amended_at: '2026-01-01' },
		},
	];
	const str = renderRetroGoals({ goalsEnabled: true, goals });

	assert.ok(str.includes('### Tombstoned goals'));
	assert.ok(str.includes('- **G2** — superseded by G3'));

	// Ensure G2 is not in the table rows
	const lines = str.split('\n');
	const tableRows = lines.filter(
		(l) => l.startsWith('|') && !l.includes('---') && !l.includes('Goal |')
	);
	const g2InTable = tableRows.some((r) => r.includes('G2'));
	assert.ok(!g2InTable);
});

test('renders no-goals note when goalsEnabled but zero goals', () => {
	const str = renderRetroGoals({ goalsEnabled: true, goals: [] });

	assert.ok(str.includes('## Goal verdicts'));
	assert.ok(str.includes('_No goals were recorded for this run._'));
	assert.ok(!str.includes('| Goal | Statement | Verdict | Evidence | Waiver |'));
});

test('escapeCell escapes pipes and collapses whitespace', () => {
	assert.equal(escapeCell('a | b'), 'a \\| b');
	assert.equal(escapeCell('x\n  y\t z'), 'x y z');
	assert.equal(escapeCell(null), '—');
	assert.equal(escapeCell(undefined), '—');
});

test('escapes pipe characters in statement cells so the table stays valid', () => {
	const goals = [{ id: 'G1', text: 'do a | b thing' }];
	const str = renderRetroGoals({ goalsEnabled: true, goals });

	assert.ok(str.includes('do a \\| b thing'));
});

test('latestEventData returns last matching event data or null', () => {
	const events = [
		{
			type: 'goal_check',
			ts: '2023-01-01T00:00:00Z',
			data: { verdicts: { G1: { verdict: 'v1' } } },
		},
		{
			type: 'goal_check',
			ts: '2023-01-02T00:00:00Z',
			data: { verdicts: { G1: { verdict: 'v2' } } },
		},
	];

	const result1 = latestEventData(events, 'goal_check');
	assert.deepEqual(result1, { verdicts: { G1: { verdict: 'v2' } } });

	const result2 = latestEventData(events, 'nope');
	assert.equal(result2, null);

	const result3 = latestEventData(null, 'goal_check');
	assert.equal(result3, null);
});

test('parses goals from goalsMd when goals array absent', () => {
	const goalsMd = `topic: shipping
## G1: ship the thing
signal: ci green
`;
	const str = renderRetroGoals({ goalsEnabled: true, goalsMd });

	assert.ok(str.includes('ship the thing'));
});

// ---- completion + archive-push summary (task 30) ----------------------------

test('classifyCompletionForRetro: complete / merged / incomplete preserved', () => {
	assert.equal(classifyCompletionForRetro({ completion: 'complete' }), 'complete');
	assert.equal(classifyCompletionForRetro({ completion: 'merged' }), 'merged');
	assert.equal(classifyCompletionForRetro({ completion: 'incomplete:kept' }), 'incomplete:kept');
	assert.equal(classifyCompletionForRetro({ completion: 'incomplete:intent_rejected:intent' }), 'incomplete:intent_rejected:intent');
});

test('classifyCompletionForRetro: no completion field → legacy (never complete)', () => {
	assert.equal(classifyCompletionForRetro({}), 'legacy');
	assert.equal(classifyCompletionForRetro(undefined), 'legacy');
	assert.equal(classifyCompletionForRetro(null), 'legacy');
	assert.equal(classifyCompletionForRetro({ completion: null }), 'legacy');
	assert.equal(classifyCompletionForRetro({ completion: '' }), 'legacy');
	assert.equal(classifyCompletionForRetro({ completion: 'incomplete:' }), 'legacy');
	assert.equal(classifyCompletionForRetro({ completion: 'bogus' }), 'legacy');
});

test('archivePushedState: no events → pushed no, no decline', () => {
	assert.deepEqual(archivePushedState([]), { pushed: 'no', sha: null, declined: null });
	assert.deepEqual(archivePushedState(null), { pushed: 'no', sha: null, declined: null });
});

test('archivePushedState: archive_pushed flips pushed to yes with the sha', () => {
	const events = [
		{ type: 'deploy_step', group: 'install', index: 0 },
		{ type: 'archive_pushed', sha: '0123456789abcdef' },
	];
	const st = archivePushedState(events);
	assert.equal(st.pushed, 'yes');
	assert.equal(st.sha, '0123456789abcdef');
	assert.equal(st.declined, null);
});

test('archivePushedState: decline records the reason, pushed stays no', () => {
	const events = [
		{ type: 'archive_push_skipped', reason: 'operator declined' },
	];
	const st = archivePushedState(events);
	assert.equal(st.pushed, 'no');
	assert.equal(st.sha, null);
	assert.equal(st.declined, 'operator declined');
});

test('renderRetroSummary: complete + pushed yes with short sha', () => {
	const out = renderRetroSummary({
		state: { completion: 'complete' },
		events: [{ type: 'archive_pushed', sha: '0123456789abcdef' }],
	});
	assert.ok(out.includes('## Completion'));
	assert.ok(out.includes('**Completion:** complete'));
	assert.ok(out.includes('**Pushed to origin:** yes (0123456789ab)'));
});

test('renderRetroSummary: local archive without archive_pushed is visibly pushed: no', () => {
	const out = renderRetroSummary({
		state: { completion: 'incomplete:kept' },
		events: [],
	});
	assert.ok(out.includes('**Completion:** incomplete:kept'));
	assert.ok(out.includes('**Pushed to origin:** no'));
});

test('renderRetroSummary: legacy pre-v10 archive with no completion field', () => {
	const out = renderRetroSummary({ state: {}, events: [] });
	assert.ok(out.includes('**Completion:** legacy (pre-v10 archive with no completion class)'));
	assert.ok(out.includes('**Pushed to origin:** no'));
});

test('renderRetroSummary: declined push surfaces the reason', () => {
	const out = renderRetroSummary({
		state: { completion: 'merged' },
		events: [{ type: 'archive_push_skipped', reason: 'keep local' }],
	});
	assert.ok(out.includes('**Pushed to origin:** no (declined: keep local)'));
});

test('renderRetroSummary: no state renders nothing', () => {
	assert.equal(renderRetroSummary(), '');
	assert.equal(renderRetroSummary({ events: [] }), '');
});

// ---- adversary r1 finding 3: FIRST terminal answer is authoritative ----------------------

test('archivePushedState: an earlier decline wins over a later pushed record (first-answer rule)', () => {
  const events = [
    { type: 'archive_push_skipped', reason: 'keep local' },
    { type: 'archive_pushed', sha: '0123456789abcdef' },
  ];
  const st = archivePushedState(events);
  assert.equal(st.pushed, 'no');
  assert.equal(st.sha, null);
  assert.equal(st.declined, 'keep local');
});

test('archivePushedState: an earlier pushed record wins over a later decline (first-answer rule)', () => {
  const events = [
    { type: 'archive_pushed', sha: '0123456789abcdef' },
    { type: 'archive_push_skipped', reason: 'late regret' },
  ];
  const st = archivePushedState(events);
  assert.equal(st.pushed, 'yes');
  assert.equal(st.sha, '0123456789abcdef');
  assert.equal(st.declined, null);
});

test('archivePushedState: repeated pushed records take the FIRST (not the last) sha', () => {
  const events = [
    { type: 'archive_pushed', sha: 'aaaaaaaaaaaa0000' },
    { type: 'archive_pushed', sha: 'bbbbbbbbbbbb1111' },
  ];
  const st = archivePushedState(events);
  assert.equal(st.pushed, 'yes');
  assert.equal(st.sha, 'aaaaaaaaaaaa0000');
});

test('archivePushedState: repeated declines take the FIRST reason', () => {
  const events = [
    { type: 'archive_push_skipped', reason: 'first decline' },
    { type: 'archive_push_skipped', reason: 'second decline' },
  ];
  const st = archivePushedState(events);
  assert.equal(st.pushed, 'no');
  assert.equal(st.declined, 'first decline');
});

// ---- adversary r1 finding 1: idempotent upsert of the ## Completion block ---------------

test('upsertRetroCompletion appends the block to a body without one', () => {
  const body = '## Goal verdicts\n\n| Goal | Verdict |\n| --- | --- |\n';
  const out = upsertRetroCompletion(body, {
    state: { completion: 'complete' },
    events: [{ type: 'archive_pushed', sha: '0123456789abcdef' }],
  });
  assert.ok(out.startsWith('## Goal verdicts'));
  assert.ok(out.includes('## Completion'));
  assert.ok(out.includes('**Completion:** complete'));
  assert.ok(out.includes('**Pushed to origin:** yes (0123456789ab)'));
  // The goal verdicts section is untouched and comes first.
  assert.ok(out.indexOf('## Goal verdicts') < out.indexOf('## Completion'));
});

test('upsertRetroCompletion replaces an existing block in place (idempotent)', () => {
  const body = [
    '## Goal verdicts',
    '',
    '| Goal | Verdict |',
    '| --- | --- |',
    '',
    '## Completion',
    '',
    '**Completion:** legacy (pre-v10 archive with no completion class)',
    '**Pushed to origin:** no',
    '',
  ].join('\n');
  const once = upsertRetroCompletion(body, {
    state: { completion: 'complete' },
    events: [{ type: 'archive_pushed', sha: '0123456789abcdef' }],
  });
  const twice = upsertRetroCompletion(once, {
    state: { completion: 'complete' },
    events: [{ type: 'archive_pushed', sha: '0123456789abcdef' }],
  });
  assert.equal(twice, once, 're-upserting the same state is a byte-for-byte no-op');
  assert.equal(once.split('## Completion').length - 1, 1, 'exactly one Completion block');
  assert.ok(once.includes('**Completion:** complete'));
  assert.ok(once.includes('**Pushed to origin:** yes (0123456789ab)'));
  // The goal verdicts section survives unchanged.
  assert.ok(once.includes('| Goal | Verdict |'));
});

test('upsertRetroCompletion replaces only the Completion block, preserving later sections', () => {
  const body = [
    '## Goal verdicts',
    '',
    '| Goal | Verdict |',
    '',
    '## Completion',
    '',
    '**Completion:** incomplete:kept',
    '**Pushed to origin:** no',
    '',
    '## Other notes',
    'some trailing text',
    '',
  ].join('\n');
  const out = upsertRetroCompletion(body, {
    state: { completion: 'merged' },
    events: [{ type: 'archive_push_skipped', reason: 'keep local' }],
  });
  assert.ok(out.includes('## Other notes'));
  assert.ok(out.includes('some trailing text'));
  assert.ok(out.includes('**Completion:** merged'));
  assert.ok(out.includes('**Pushed to origin:** no (declined: keep local)'));
  assert.equal(out.split('## Completion').length - 1, 1);
});

test('upsertRetroCompletion: no state renders nothing (no block added)', () => {
  assert.equal(upsertRetroCompletion('## Goal verdicts\n', {}), '## Goal verdicts\n');
  assert.equal(upsertRetroCompletion('', { events: [] }), '');
});
