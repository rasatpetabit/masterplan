// lib/doctor/state-schema.mjs — v8 doctor check (ports v7 #9 + #10 folded).
//
// External surface: <repoRoot>/docs/masterplan/*/state.yml.
// Plan-scoped: reads each bundle's state.yml and validates it against the canonical v8 core
// schema (CORE_REQUIRED_FIELDS + validateCoreState from lib/bundle.mjs — SINGLE SOURCE OF
// TRUTH; never redefined here). Check #10 ("unparseable") folds in: parseState is tolerant,
// so the only "unparseable" signal is zero modellable keys — that is an ERROR, not a SKIP.
//
// Ordering contract: a bundle with schema_version numerically < 6 is silently skipped — legacy
// bundles are legacy-bundle.mjs's concern, not ours. This includes bundles where schema_version
// is stored as a YAML-quoted string like '5.1' or "5.0" (v7 practice); parseState returns those
// as bare strings which we normalise to float for the guard. An absent or unparseable
// schema_version falls through to validateCoreState which flags it as an ERROR (correct).
// Returns ≥1 finding: ERRORs per schema violation, WARN per slug dir that exists but has no
// readable state.yml (orphan/incomplete bundle, Codex #4), one PASS when all bundles are valid,
// SKIP when there are no slug dirs at all.
import fs from 'node:fs';
import path from 'node:path';
import { resolveRunsDir, bundleArtifacts } from '../paths.mjs';
import { parseState, validateCoreState } from '../bundle.mjs';

const ID = 'state-schema';

export function check(repoRoot, opts = {}) {
  const runsDir = resolveRunsDir(repoRoot, {});
  let slugs;
  try {
    slugs = fs.readdirSync(runsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [{ id: ID, severity: 'SKIP', summary: 'no run bundles under docs/masterplan', fix: null }];
  }
  if (slugs.length === 0) {
    return [{ id: ID, severity: 'SKIP', summary: 'no run bundles under docs/masterplan', fix: null }];
  }

  const findings = [];
  for (const slug of slugs) {
    const statePath = bundleArtifacts(repoRoot, slug, {}).state;
    let text;
    try {
      text = fs.readFileSync(statePath, 'utf8');
    } catch {
      // Slug dir present under docs/masterplan but no readable state.yml: an orphan dir or an
      // incomplete/corrupt bundle. WARN (not ERROR) — a transient or hand-created non-bundle dir
      // should surface for cleanup without hard-failing doctor (exit 1). The prior behaviour
      // silently skipped it, so a docs/masterplan full of orphan dirs returned PASS — false
      // confidence (Codex #4). WARN keeps doctor exit 0 while still flagging the anomaly.
      findings.push({
        id: ID, severity: 'WARN',
        summary: `bundle ${slug}: directory exists under docs/masterplan but state.yml is missing or unreadable`,
        fix: 'restore state.yml (re-run `/masterplan import`, or recreate from a clean template), or remove the orphan directory',
      });
      continue;
    }

    const state = parseState(text);

    // Legacy bundle: schema_version numerically < 6 → defer to legacy-bundle.mjs.
    // parseState may return a string (e.g. "'5.1'" or "5.0") when the v7 YAML used single/double
    // quotes around the version. Strip wrapping quotes and parse to float for the guard.
    // This MUST run before the zero-keys check: a v7 block-YAML bundle that still carries a
    // col-0 `schema_version:` line should be deferred (legacy-bundle WARNs), never ERROR'd here.
    const sv = state.schema_version;
    const svNum = typeof sv === 'number' ? sv
      : typeof sv === 'string' ? parseFloat(sv.replace(/^['"]|['"]$/g, ''))
      : NaN;
    if (!Number.isNaN(svNum) && svNum < 6) continue;

    // Check #10 folded: zero keys = unparseable. Reached only when no readable schema_version
    // deferred above, so a genuinely contentless/garbled state.yml is the true ERROR case.
    if (Object.keys(state).length === 0) {
      findings.push({
        id: ID, severity: 'ERROR',
        summary: `bundle ${slug}: state.yml is unparseable (no modellable keys)`,
        fix: 'check for malformed YAML (tabs, illegal leading chars); re-create state.yml from a clean template',
      });
      continue;
    }

    // v8 core validation.
    const problems = validateCoreState(state);
    for (const prob of problems) {
      findings.push({
        id: ID, severity: 'ERROR',
        summary: `bundle ${slug}: ${prob}`,
        fix: 'add/correct the field in state.yml; run `/masterplan doctor` to re-verify',
      });
    }

    // Task-status integrity (D1/D3, G6): validate every task status against the canonical enum and
    // require a non-empty reason for blocked/waived. The whole point of those statuses is the
    // auditable rationale — a reasonless block/waive defeats "diagnose why this wave is gated" and
    // loses the operator-consent trail. The enum mirrors bin/masterplan.mjs VALID_TASK_STATUS (lib
    // cannot import bin); keep them in sync. blocked/waived are never counted dispatchable here —
    // doctor reports no dispatchable count (wave.mjs/resume.mjs own that filter).
    const VALID_TASK_STATUS = ['pending', 'in_progress', 'done', 'blocked', 'waived'];
    for (const task of Array.isArray(state.tasks) ? state.tasks : []) {
      if (!VALID_TASK_STATUS.includes(task.status)) {
        findings.push({
          id: ID, severity: 'ERROR',
          summary: `bundle ${slug}: task ${task.id} has unknown status ${JSON.stringify(task.status)} (expected one of: ${VALID_TASK_STATUS.join(', ')})`,
          fix: `set task ${task.id} status to a valid value via \`mp mark-task\` (or \`mp waive-task\` for waived)`,
        });
        continue; // a bad status makes the reason checks below meaningless
      }
      if (task.status === 'blocked' && (!task.block_reason || String(task.block_reason).trim() === '')) {
        findings.push({
          id: ID, severity: 'WARN',
          summary: `bundle ${slug}: task ${task.id} is blocked with no block_reason (can't diagnose why the wave is gated)`,
          fix: `mp mark-task --status=blocked --id=${task.id} --reason="<why blocked>"`,
        });
      }
      if (task.status === 'waived' && (!task.waive_reason || String(task.waive_reason).trim() === '')) {
        findings.push({
          id: ID, severity: 'WARN',
          summary: `bundle ${slug}: task ${task.id} is waived with no waive_reason (the operator-consent rationale is missing)`,
          fix: `record the waiver rationale (a waived task must carry the operator-consent reason)`,
        });
      }
    }
  }

  if (findings.length === 0) {
    return [{ id: ID, severity: 'PASS', summary: 'all bundle state cores are schema-valid', fix: null }];
  }
  return findings;
}
