# INTENT.md — masterplan

## Purpose

masterplan exists for engineering work that is too large to finish in one
sitting. Such work has two ways to fail. It can be interrupted — by a
crash, a context compaction, a cleared session, a change of model or host
— and afterwards continue in some direction other than the one the owner
set, or simply not continue at all. Or it can be complex enough that no
single pass of thinking gets the design right and no single author catches
their own mistakes. masterplan is the answer to both: it keeps the work on
the owner's course across any interruption, and it puts enough
brainstorming and independent review in front of and behind the code that
the result is correct. Reaching shipped code is the baseline any such tool
must meet, not what distinguishes this one.

## Top invariant

Work the owner set out to do is never silently lost or abandoned. An
interrupted run resumes from its last durable step. Decisions already made
with the owner — gate answers, approved amendments, rejected options —
stay made; a resumed session does not re-ask or reverse them. And a run
does not trail off: the work is not left unfinished, unmerged, undeployed,
or stranded in a forgotten worktree. The spec and plan may change along
the way, but only through review and the owner's approval; what may not
change is whether the work gets done.

What ships is what was asked for. The delivered result is neither
whittled down by successive review rounds nor padded with scope the owner
never requested.

Nothing is declared done without evidence. A claim that a task, wave, or
run is complete always carries fresh proof of the kind the result is
consumed in; an assertion is not a completion.

## Non-goals

masterplan is not a general-purpose agent framework. It runs one
lifecycle on top of the harnesses and skill suites that already exist,
and it does not try to become a library for building arbitrary agents.

It is not a tool for small tasks. A one-line fix or a quick edit belongs
in an ordinary session; the ceremony here is justified only by work that
needs it.

It is not an unattended pipeline. The owner's decisions at the gates are
part of the design, not friction to be automated away.

It is not a project tracker. A run bundle holds the state of one piece of
work; it is not a backlog, a roadmap, or a substitute for an issue
tracker.

## Audience

The primary user is a single engineer driving multi-hour agent work
across many sessions. The same design must also serve a small team that
collaborates through GitHub, with lead and follower sessions projected
onto issues and pull requests, and it must work for anyone who installs
the plugin from a marketplace with default harness settings and none of
the author's fleet policy or house skills.

## Core bet

State kept on disk is more trustworthy than anything a model remembers,
and that stays true however large context windows become. A bundle the
orchestrator re-reads is the memory; the session is not.

Understanding the owner's intent up front is worth as much as the spec
and the plan. The spec and plan say how the work will be done; intent
says why it is wanted. A model that carries the why can settle questions
the spec never anticipated in the direction the owner would have chosen,
which a model holding only the how cannot.

Design effort before code pays for itself. Time spent brainstorming and
specifying is cheaper than the rework that skipping it produces.

Independent review catches what an author cannot see. Fresh-context
reviewers, drawn from a different vendor than the author where possible,
are worth their cost at every gate. An author reviewing its own work is
not review.

## Direction

Intent becomes a first-class artifact: interviewed before the spec, held
in the run bundle alongside it, consulted during execution, and used as
the standard the finished work is judged against. This is the committed
path, not an experiment.

The definition of done moves from merged to deployed and confirmed. A run
finishes when the change is live where it is consumed and shown to work
there.

masterplan stays harness-native and multi-harness. Claude Code and Codex
are both first-class hosts, and dispatch rides each harness's own
subagent mechanism rather than an engine of masterplan's own.

Runs in the same repository become aware of one another, so that
concurrent masterplan work neither conflicts over the same files nor
duplicates effort.

## Posture

Correctness outranks speed and cost. When a gate, a review, or a
verification step costs tokens or time, the cost is paid; a fast wrong
result is the expensive one.

masterplan fails closed. A reviewer that cannot be reached, a model that
is unavailable, or evidence that is missing stops the run visibly. It
never degrades quietly, substitutes a weaker step, or fabricates the
missing piece.

The owner is asked at genuine forks and not about details. Where the
spec is silent, the model chooses the option that serves the intent and
continues. Where the model is unsure what the owner intends, or meets
something — in the code, the spec, a review finding — that seems to
contradict its current understanding of that intent, it asks rather than
guessing in either direction. Minutiae the model can settle from the
repo, the tests, or convention are settled without a question.
