# Historical Release Disposition Report: `masterplan` v10.0.6 to v10.0.14

## 1. Executive Summary

This report establishes the **Historical Release Disposition** for `masterplan` release **v10.0.6** following rigorous validation of its tagged release surfaces (live Pi execution evidence, live Claude plugin execution evidence, 138-test bootstrap failure recovery table verification, and green GitHub Actions CI status).

Per operator decisions **Q4** and **Q5**, this report audits all commits between tag `v10.0.6` (`80e3337b8bb8ce50105b218b605b66273ddf8185`) and current repository HEAD (`v10.0.14`), resolving whether `v10.0.6` could be retained or whether `v10.0.7` was owed.

**Verdict**: 
While the immediate commits following tag `v10.0.6` were documentation and bundle lifecycle landings (`intent-to-completion` finish docs), commit `192e6b9` identified and resolved an active shipped-surface defect: **a schema-backed `goals-amend` deadlock with `set-phase`**. Under the governing decision rule (**Q4**: *"Docs-only commits past the tag keep 10.0.6; any shipped-surface defect forces 10.0.7"*), this shipped-surface code defect strictly mandated the publication of **v10.0.7**. Furthermore, as confirmed by repository history, **v10.0.7** was cut and published at `ba5d8e1`, followed by successive maintenance releases through **v10.0.14**. The disposition of `v10.0.6` is therefore definitively historical and complete.

---

## 2. Governing Operator Decisions

From the canonical decision ledger (`events.jsonl`):
- **Q4**: *"Docs-only commits past the tag keep 10.0.6; any shipped-surface defect forces 10.0.7."*
- **Q5**: *"Validate v10.0.6 as tagged per the anchor; record that v10.0.7+ already shipped, so the disposition is historical."*
- **Q3**: *"Evidence and disposition only; record any defect found and let the disposition carry the fix into v10.0.7."*

---

## 3. Post-Tag Commit Audit: v10.0.6 to v10.0.7

Tag `v10.0.6` was created at commit `80e3337b8bb8ce50105b218b605b66273ddf8185`. The chronological sequence of commits immediately following `v10.0.6` leading up to `v10.0.7` (`ba5d8e1`) is analyzed below:

| Commit | Author Date | Category | Commit Message / Summary | Impact on Q4 Rule |
| :--- | :--- | :--- | :--- | :--- |
| `23ab37e` | 2026-09-08 | Merge | Merge pull request #26 from rasatpetabit/masterplan/intent-to-completion | Merge commit |
| `3cc6bc7` | 2026-09-08 | Merge | Merge pull request #27 from rasatpetabit/masterplan/intent-to-completion | Merge commit |
| `f488e96` | 2026-09-08 | Bundle | masterplan(intent-to-completion): bootstrap gate armed | Bundle ledger event |
| `e96d39f` | 2026-09-08 | Docs | masterplan(intent-to-completion): SKILL.md names the G5 observability verbs | Docs-only update |
| `442eb59` | 2026-09-08 | Bundle | masterplan(intent-to-completion): finish dirty-commit (task scope) | Bundle finish commit |
| `173016a` | 2026-09-08 | Bundle | masterplan(intent-to-completion): branch_finish resolved (keep) | Bundle ledger event |
| `67ee0c5` | 2026-09-08 | Bundle | masterplan(intent-to-completion): archive run (finish complete) | Run archiving |
| `851db7f` | 2026-09-08 | Docs | masterplan(intent-to-completion): land the finish docs fix (SKILL.md observability verbs) | Docs-only landing |
| `84acd49` | 2026-09-08 | Bundle | masterplan(intent-to-completion): record a structurally valid goal_check | Checkpoint receipt |
| `7357b46` | 2026-09-08 | Bundle | masterplan(v10-validation): seed the required successor of intent-to-completion | Run seed commit |
| `ef8bf23` | 2026-09-08 | Core | masterplan(§2d): point the COMPLETE stop-set at the fleet turn-end contract | Sequencer text update |
| **`192e6b9`** | 2026-09-08 | **Defect Fix** | **fix: schema-backed goals-amend must hash under the durable pin (deadlock with set-phase)** | **SHIPPED SURFACE DEFECT** |
| `389cfc6` | 2026-09-08 | Docs | worklog: schema-backed goals-amend/set-phase deadlock fixed (192e6b9) | Worklog record |
| **`ba5d8e1`** | 2026-09-08 | **Release** | **release: v10.0.7 — schema-backed goals-amend/set-phase deadlock** | **v10.0.7 Release Tag** |

### Analysis of the Shipped-Surface Defect (`192e6b9`)
In release `v10.0.6`, when `goals-amend` executed on a schema-backed bundle, the hash computation did not evaluate strictly under the durable format pin (`format_pin: schema_backed`). As a result, subsequent invocations of `set-phase` detected a hash mismatch between the state metadata and the goal definitions, causing an unresolvable execution deadlock where the bundle could neither proceed nor re-amend without manual database intervention.

Because `192e6b9` altered executable production logic in `lib/goals.mjs` and `bin/masterplan.mjs`, this constituted an unambiguous shipped-surface defect under decision **Q4**.

---

## 4. Chronology of Subsequent Releases (v10.0.7 – v10.0.14)

Following `v10.0.7`, the repository underwent continuous deployment as additional platform and harness enhancements landed:

| Version | Release Commit | Key Changes & Delivered Features |
| :--- | :--- | :--- |
| **v10.0.7** | `ba5d8e1` | Hotfix for schema-backed `goals-amend` and `set-phase` deadlock (`192e6b9`). |
| **v10.0.8** | `958f623` | Host lane overrides in `bin/register-pi-agents.mjs`; wiring §6.3 `reconcile-intent` CLI verb. |
| **v10.0.9** | `b1c5f6c` | Adversary review fallback logic in `finish-gate`. |
| **v10.0.10** | `16725c3` | Pi agent model hint compatibility fix; release retention enforcement (keep 3 releases). |
| **v10.0.11** | `cbe2a95` | Fleet routing policy consumption (`policy/workflow-map.json`); Pi fallback reviewer integration. |
| **v10.0.12** | `51bffa1` | CLI argument parsing fix accepting `--repo-root <dir>` space syntax in addition to equals form. |
| **v10.0.13** | `05f6337` | Strict validation for valueless `--repo-root` flags; archive-push example correction. |
| **v10.0.14** | `7cdb335` | Simplified fallback policy resolution for chain-only routing models. |

---

## 5. Formal Disposition Conclusion

1. **Tag v10.0.6 Surfaces**: Validated and verified. Tag `v10.0.6` successfully shipped the v10 clean-core architecture and passed all G6 surface, CI, and recovery invariant checks.
2. **Defect Disposition**: A code-level defect in schema-backed goal amendments was discovered and fixed in commit `192e6b9`.
3. **Release Obligation**: Under operator decision Q4, the defect necessitated a new release. Release **v10.0.7** was promptly tagged and published at `ba5d8e1`.
4. **Historical Status**: As specified by operator decision Q5, `v10.0.7` through `v10.0.14` have already been released and are actively operating across the fleet. The validation of `v10.0.6` is complete, and its disposition is recorded as a fully satisfied historical release milestone.
