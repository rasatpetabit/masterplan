import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderRetroGoals, escapeCell, latestEventData } from '../lib/retro-goals.mjs';

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
