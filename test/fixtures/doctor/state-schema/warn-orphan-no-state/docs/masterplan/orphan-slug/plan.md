# Plan (orphan bundle fixture)

This bundle directory intentionally has NO state.yml — it models an orphan /
incomplete bundle dir under docs/masterplan. state-schema must emit WARN for it
(Codex #4 regression), not silently skip it. The plan.md file exists only so git
tracks the directory (empty dirs are not committable).
