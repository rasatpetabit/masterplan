# Goals — dispatch-subagent-reconcile

topic: reconcile legacy masterplan subagent profiles/models with new agent-dispatch system

## G1: Explorer agent body no longer claims haiku
signal: artifact
evidence: agents/mp-explorer.md body matches frontmatter model: fable (or an explicit model_group lane); no "runs on haiku" claim.

## G2: MODEL_MAP is fable-only and live-accurate
signal: test
evidence: bin/register-pi-agents.mjs MODEL_MAP is exactly { fable: 'litellm/fable-5' }; keys match non-skipped agents/mp-*.md model: values.

## G3: Registration unit tests pass under fable-only map
signal: test
evidence: test/register-pi-agents.test.mjs green with fable fixtures; no live opus map assertions.

## G4: Host pi agents have zero drift
signal: command
evidence: node bin/register-pi-agents.mjs --check exits 0 after write-mode resync on the implementer host.

## G5: Diff stays inside debt-cleanup scope
signal: artifact
evidence: Changed surfaces are agents prose, MODEL_MAP, registration tests, and host resync only — no fabric/doctor/policy redesign.
