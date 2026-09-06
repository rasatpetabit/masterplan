{
  "head": "1f2741f8136066b1c40dc1008b34c98115064675",
  "verdict": "rework",
  "findings": [
    {
      "severity": "ERROR",
      "location": "scripts/rehearse-v9-finish.sh:287-303",
      "claim": "Pinned finish coverage stops after one successful, nonempty response; it never drives the returned finish operations after the surfaces change. Fix: execute and validate the pinned finish sequence against the post-merge fixture, including its terminal state.",
      "evidence": "The sole finish-step invocation precedes the walk; test/rehearse-v9-finish.test.mjs:180-185 returns an unconditional gate request, which satisfies the row. Later finish merging is handwritten git (880-889)."
    },
    {
      "severity": "WARN",
      "location": "scripts/rehearse-v9-finish.sh:953-966",
      "claim": "The release-refusal row proves only that an extra commit exists, not that the release driver refuses it. Fix: arm/record the invalid release and assert the specific rejection with a valid positive control.",
      "evidence": "release_extra_commit_refused is marked ok solely by rev-list count >1; test:576-613 accepts that row without observing a refusal."
    },
    {
      "severity": "WARN",
      "location": "scripts/rehearse-v9-finish.sh:28,57,998-1000",
      "claim": "Unknown --only values silently skip every optional group and can emit REHEARSAL PASS after fixture setup alone. Fix: validate group names before setup and label selected-group success as partial coverage.",
      "evidence": "ONLY is never validated; selected compares equality; final success checks only FAILED. Argument tests at test:694-707 do not cover unknown group names."
    }
  ],
  "coverage": [
    "scripts/rehearse-v9-finish.sh:1-1004 (entire added file)",
    "test/rehearse-v9-finish.test.mjs:1-753 (entire added file)"
  ],
  "unreviewed": [],
  "notes": [
    "Host-identity guard SKIPPED: brief supplies HEAD but no orchestrator machine-id. Frozen HEAD matched; assigned tracked files and index had no diff. Full diff: 1757 additions. No tests rerun or network/production actions. Prior verdicts unchanged; no whole-release approval."
  ]
}
