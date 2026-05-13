# p4-suppression-smoke — Implementation Plan (3 no-op tasks)

> **For agentic workers:** these tasks are deliberately trivial. The objective is NOT the work itself — it's the per-turn `smoke_observation` event evidence. See `spec.md` for the mandatory observation contract.

**Goal:** exercise the Step C wave-dispatch path with 3 minimal tasks while logging the per-turn reminder-firing evidence.

**Architecture:** 3 sequential no-op tasks. Each task appends a single event to `events.jsonl` and returns a minimal digest.

---

## Task 1: No-op A

**Files:**
- Modify: `docs/masterplan/p4-suppression-smoke/events.jsonl`

- [ ] **Step 1: Append the smoke_task event**

```bash
printf '{"ts":"%s","event":"smoke_task_1_done","note":"noop"}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  >> docs/masterplan/p4-suppression-smoke/events.jsonl
```

- [ ] **Step 2: Return digest**

```json
{"status": "done", "note": "noop", "task": 1}
```

---

## Task 2: No-op B

**Files:**
- Modify: `docs/masterplan/p4-suppression-smoke/events.jsonl`

- [ ] **Step 1: Append the smoke_task event**

```bash
printf '{"ts":"%s","event":"smoke_task_2_done","note":"noop"}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  >> docs/masterplan/p4-suppression-smoke/events.jsonl
```

- [ ] **Step 2: Return digest**

```json
{"status": "done", "note": "noop", "task": 2}
```

---

## Task 3: No-op C

**Files:**
- Modify: `docs/masterplan/p4-suppression-smoke/events.jsonl`

- [ ] **Step 1: Append the smoke_task event**

```bash
printf '{"ts":"%s","event":"smoke_task_3_done","note":"noop"}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  >> docs/masterplan/p4-suppression-smoke/events.jsonl
```

- [ ] **Step 2: Return digest**

```json
{"status": "done", "note": "noop", "task": 3}
```

---

## Reminder: observation contract

For EVERY turn of Step C, BEFORE any other event in this file, the orchestrator MUST append a `smoke_observation` event. See `spec.md` for the schema. The 3 task events above are appended AFTER each task's `smoke_observation` event for that turn.
