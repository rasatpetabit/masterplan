VERDICT: refuted

## F2 — Gate Re-Entrance Audit: Session 335b66e4

### Raw Count Reconciliation

The prior audit reported "30 gate=fire events" from a raw grep. Actual breakdown:

| Source | Count | Notes |
|--------|-------|-------|
| User messages (orchestrator prompt text in context) | 24 | Lines 41, 81, 469, 477 — skill body loaded as context, not real fires |
| Real assistant-emitted gate fires | **6** | Lines 93, 169, 589, 633, 637, 659 |
| **Total raw matches** | **30** | Matches the original audit |

The 68 `spec_approval` mentions vs 30 `gate=fire` raw events gap is explained the same way: the orchestrator prompt body appears as user-role messages containing all template references (multiple per line), inflating both counts identically.

---

### Fire-Event Sequence (6 real assistant-emitted fires)

| # | JSONL Line | Gate ID | Slug | Phase at Fire | Phase Write on Same Line |
|---|-----------|---------|------|---------------|--------------------------|
| 1 | 93 | `b0-worktree-choice` | (none / kickoff) | step-b0 | none |
| 2 | 169 | `spec_approval` | `srv-dev-desync-audit` | step-b1 phase=out | none |
| 3 | 589 | `problem_interview_r1` | `git-history-reconciliation` | (breadcrumb: step-entry-brainstorming) | none |
| 4 | 633 | `spec_approval` | `git-history-reconciliation` | — | `phase: brainstorming → spec_gate` |
| 5 | 637 | `spec_approval` | `git-history-reconciliation` | — | none |
| 6 | 659 | `spec_approval` | `git-history-reconciliation` | — | none |

---

### Distinct-Gate Accounting

**Fires 1, 2, 3 — clearly distinct legitimate gates:**

- Fire 1 (L93, `b0-worktree-choice`): First and only fire of this gate id. Legitimate kickoff choice.
- Fire 2 (L169, `spec_approval`, slug `srv-dev-desync-audit`): First and only fire of spec_approval for this slug. Different slug from fires 4/5/6.
- Fire 3 (L589, `problem_interview_r1`, slug `git-history-reconciliation`): Different gate id (`problem_interview_r1`) from fires 4/5/6. Legitimate interview gate.

**Fires 4, 5, 6 — same gate (`spec_approval`) + same slug (`git-history-reconciliation`), analyzed for re-entrance:**

**Fire 4 (L633) → Fire 5 (L637):**

- Fire 4 (L633): gate fires with `state-write field=phase from=brainstorming to=spec_gate`. AUQ rendered (L634): "Spec written... Ready for writing-plans?"
- User response (L635): Free text — "Early on I hit a 'local is authoritative' by accident but it already advanced past the ability to change it". Does NOT match any named option.
- Per step-b.md line 221–222 and step-0.md line 174: free-text response → treat as "hold the gate and chat" → keep `pending_gate: spec_approval`, CLOSE-TURN.
- Fire 5 (L637): Resume controller re-renders the gate on next invocation per step-0.md line 174 ("If `pending_gate` is non-null, re-render that exact gate"). The assistant then asks a clarifying AUQ (L638): "Which part of the spec would you like to change?"

**Verdict on 4→5**: DESIGNED re-fire. The pending_gate was kept intentionally; the resume controller correctly re-renders it. No phase cleared between them. No idempotency bug.

**Fire 5 (L637) → Fire 6 (L659):**

- Fire 5 (L637): AUQ (L638): "Which part of the spec would you like to change?" — clarifying gate.
- User response (L639): "Change end-state strategy" — matches a named option.
- Per step-b.md line 222: "Request changes" → keep `pending_gate: spec_approval`, CLOSE-TURN.
- Lines 640–658: New bridge-session boundary (L644, L658). Assistant updates the spec (Write call L651). User makes a follow-up prompt (L654: "Use more intelligence...").
- Fire 6 (L659): Resume controller finds `pending_gate: spec_approval` still set (never cleared). Re-renders gate. AUQ (L660): "Spec updated: merge commit strategy... Ready for writing-plans?" — correctly reflects the updated spec.

**Verdict on 5→6**: DESIGNED re-fire. The user selected "Change end-state strategy" (a "Request changes" path). Per the spec, `pending_gate` is kept and the gate re-fires on next invocation after the update. No bug.

**Verification — no pending_gate clear between any of the three fires:**

Scanning lines 633–659 for `gate_closed`, `pending_gate_cleared`, `pending_gate: null`, or any phase transition that would indicate the gate advanced: **none found**. The only phase write in that range is on L633 itself (`brainstorming → spec_gate`), which is the initial gate-fire transition, not a clear.

---

### Reasoning

The F2 suspicion rested on: (a) the 68 vs 30 raw count suggesting many mentions weren't real fires, and (b) "no idempotency guard in code." Both observations are correct, but they do not establish re-entrance as a bug. The 30 raw "gate=fire" matches collapse to 6 real assistant-emitted fires once user-role lines (which carry the orchestrator prompt body verbatim) are excluded. Of those 6 fires, none is a genuine re-entrance: fires 1/2/3 are distinct gate ids or distinct slugs; fires 4/5/6 are three fires of `spec_approval` for `git-history-reconciliation` that are all intentional re-renders by the resume controller (step-0.md line 174) after the user responded with either free text or a "request changes" selection, both of which explicitly preserve `pending_gate` and close the turn. The gate re-fires on the next invocation because the pending_gate flag is still set — that is the designed mechanism, not a bug. An idempotency guard is absent because re-fire is correct behavior here; the guard needed to prevent a bug would instead block the legitimate resume-controller path. F2 is **refuted**: no genuine same-gate re-fire with no intervening design-prescribed re-set was observed in this session.

## RESOLUTION (Task 4, refuted branch)

Per the repro-first posture, Task 4's source fix is **contingent on F2 being confirmed**. F2 is refuted, so the planned idempotency guard near `parts/step-b.md:218`/`:303` is **not applied** — and would be actively harmful if it were. The three observed `spec_approval` re-fires for `git-history-reconciliation` are produced by the resume controller's designed re-render path (`parts/step-0.md:174`: "if `pending_gate` is non-null, re-render that exact gate"). That path is the mechanism that lets a user respond to a gate with free text ("hold and chat") or "Request changes" without losing the gate. An idempotency guard that short-circuits a same-`id`/same-slug re-fire would block exactly this legitimate resume re-render — it would convert a working feature into a bug, silently dropping the re-rendered gate after a free-text or request-changes response. No source change is made. The distinction that matters operationally: re-fire **with** an intervening `pending_gate` clear→advance would be a bug; re-fire **with** `pending_gate` still set is the contract. This session contained only the latter.

RESOLUTION: docs-only-refuted
