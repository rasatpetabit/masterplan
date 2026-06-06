#!/usr/bin/env bash
# test/owner-stress.sh — Guard D real-filesystem concurrency acceptance gate.
#
# Spawns N genuinely-concurrent OS processes racing `mp acquire-owner` against ONE bundle and asserts the
# core mutual-exclusion invariant: EXACTLY ONE winner. Exercises the real link()/stat(nlink) atomic-create
# against the live filesystem (here ZFS; the NFS link()-misreport path is covered by the nlink===2 unit
# test in test/owner-fs.test.mjs). Also checks stale-break (one winner), heartbeat-freshness (no steal),
# and force takeover.
#
# Usage: bash test/owner-stress.sh [N]   (N concurrent acquirers, default 30)
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MP="node $ROOT/bin/masterplan.mjs"
N="${1:-30}"
WORK="$(mktemp -d)"
BUNDLE="$WORK/docs/masterplan/stress"
mkdir -p "$BUNDLE"
printf 'schema_version: "8.0"\nslug: stress\n' > "$BUNDLE/state.yml"
STATE="$BUNDLE/state.yml"
fail=0

note() { printf '%s\n' "$*"; }
win_of() { grep -oE '"outcome":"[a-z-]+"' "$1" | head -1 | sed 's/.*:"//;s/"//'; }

# ---- Scenario 1: N concurrent acquirers on a FRESH lock → exactly one winner -------------------------
note "== Scenario 1: $N concurrent acquirers on a fresh lock =="
OUT="$WORK/s1"; mkdir -p "$OUT"
for i in $(seq 1 "$N"); do
  ( $MP acquire-owner --state="$STATE" --session="sess-$i" --host="epyc1" --now=1000 --ttl-ms=600000 \
      > "$OUT/$i.json" 2>&1 ) &
done
wait
winners=0; blocked=0; other=0
for i in $(seq 1 "$N"); do
  o="$(win_of "$OUT/$i.json")"
  case "$o" in
    acquire|steal|force|held-by-self) winners=$((winners+1)) ;;
    blocked) blocked=$((blocked+1)) ;;
    *) other=$((other+1)); note "  unexpected outcome from #$i: $(cat "$OUT/$i.json")" ;;
  esac
done
note "  winners=$winners blocked=$blocked other=$other (expect winners=1 blocked=$((N-1)) other=0)"
[ "$winners" -eq 1 ] && [ "$other" -eq 0 ] || { note "  FAIL: not exactly one winner"; fail=1; }
# The on-disk lock must be a single, parseable owner.
lockowner="$($MP heartbeat-owner --state="$STATE" --session="$(grep -l '"outcome":"acquire"' "$OUT"/*.json | head -1 | xargs -I{} sh -c 'grep -oE "\"session\":\"[^\"]+\"" {} | head -1 | sed "s/.*:\"//;s/\"//"')" --host=epyc1 --now=1001 2>&1 | win_of /dev/stdin 2>/dev/null)"
note "  winner re-heartbeat outcome=$lockowner (expect held-by-self)"

# ---- Scenario 2: stale-break — N concurrent breakers → >=1 PROVISIONAL acquire-winner, but EXACTLY ONE
# session resolves to held-by-self at the heartbeat-before-write boundary. Acquire is optimistic: stale-lock
# removal is a path-based rename (no atomic remove-by-inode on NFS), so a break storm can transiently produce
# >1 winner — harmless churn, RESOLVED into a single proceeding writer by the heartbeat re-check asserted
# below. (Live contention is perfect by construction — see lib/owner.mjs header; the residual is only the
# documented >TTL-abandoned-owner-resurrects case, which this stress harness does not reproduce.)
note "== Scenario 2: $N concurrent stale-breakers =="
rm -f "$BUNDLE"/.owner.lock "$BUNDLE"/.owner.hb.* "$BUNDLE"/.owner.lock.dead.*
$MP acquire-owner --state="$STATE" --session="old" --host="epyc1" --now=0 --ttl-ms=1000 >/dev/null 2>&1
OUT2="$WORK/s2"; mkdir -p "$OUT2"
for i in $(seq 1 "$N"); do
  ( $MP acquire-owner --state="$STATE" --session="break-$i" --host="epyc2" --now=999999 --ttl-ms=1000 \
      > "$OUT2/$i.json" 2>&1 ) &
done
wait
w2=0; b2=0; o2=0
for i in $(seq 1 "$N"); do
  o="$(win_of "$OUT2/$i.json")"
  case "$o" in
    acquire|steal|force) w2=$((w2+1)) ;;
    blocked) b2=$((b2+1)) ;;
    held-by-self) w2=$((w2+1)) ;;
    *) o2=$((o2+1)); note "  unexpected: $(cat "$OUT2/$i.json")" ;;
  esac
done
note "  break-winners=$w2 blocked=$b2 other=$o2 (provisional steal → expect winners>=1 other=0; the heartbeat re-check below resolves churn to one writer)"
[ "$o2" -eq 0 ] || { note "  FAIL: an unexpected outcome appeared"; fail=1; }
[ "$w2" -ge 1 ] || { note "  FAIL: stale-break yielded no acquire-winner at all (got $w2)"; fail=1; }
# The on-disk lock resolves to a SINGLE owner...
final="$(grep -oE '"session":"[^"]+"' "$BUNDLE/.owner.lock" | head -1 | sed 's/.*:"//;s/"//')"
note "  final on-disk owner session=$final"
[ -n "$final" ] || { note "  FAIL: no single owner on disk after the break race"; fail=1; }
# ...and the SAFETY-CRITICAL masterplan invariant (the heartbeat-before-write boundary): EXACTLY ONE of
# the break sessions gets held-by-self on a heartbeat; every other gets lost-to-other and must STOP.
hbs=0; lost=0
for i in $(seq 1 "$N"); do
  o="$($MP heartbeat-owner --state="$STATE" --session="break-$i" --host="epyc2" --now=1000000 2>&1 | win_of /dev/stdin)"
  case "$o" in held-by-self) hbs=$((hbs+1)) ;; lost-to-other) lost=$((lost+1)) ;; esac
done
note "  heartbeat re-check: held-by-self=$hbs lost-to-other=$lost (expect 1 / $((N-1)) — true mutual exclusion)"
{ [ "$hbs" -eq 1 ] && [ "$lost" -eq $((N-1)) ]; } || { note "  FAIL: mutual exclusion not exactly-one at the heartbeat boundary"; fail=1; }

# ---- Scenario 3: heartbeat keeps a lock fresh → a within-TTL competitor is blocked ------------------
note "== Scenario 3: heartbeat-freshness blocks a competitor =="
rm -f "$BUNDLE"/.owner.lock "$BUNDLE"/.owner.hb.*
$MP acquire-owner --state="$STATE" --session="holder" --host="epyc1" --now=0 --ttl-ms=1000 >/dev/null 2>&1
$MP heartbeat-owner --state="$STATE" --session="holder" --host="epyc1" --now=900 >/dev/null 2>&1
comp="$($MP acquire-owner --state="$STATE" --session="rival" --host="epyc2" --now=1500 --ttl-ms=1000 2>&1 | win_of /dev/stdin)"
note "  competitor outcome=$comp (expect blocked — age 1500-900=600 <= ttl 1000)"
[ "$comp" = "blocked" ] || { note "  FAIL: a fresh heartbeated lock was not respected"; fail=1; }

# ---- Scenario 4: --force takeover wins regardless of a live incumbent -------------------------------
note "== Scenario 4: --force takeover =="
forced="$($MP acquire-owner --state="$STATE" --session="operator" --host="epyc2" --now=1600 --ttl-ms=1000 --force 2>&1 | win_of /dev/stdin)"
owner4="$(grep -oE '"session":"[^"]+"' "$BUNDLE/.owner.lock" | head -1 | sed 's/.*:"//;s/"//')"
note "  force outcome=$forced; on-disk owner=$owner4 (expect force / operator)"
{ [ "$forced" = "force" ] && [ "$owner4" = "operator" ]; } || { note "  FAIL: force takeover did not win"; fail=1; }

rm -rf "$WORK"
if [ "$fail" -eq 0 ]; then note "== ALL SCENARIOS PASS =="; exit 0; else note "== STRESS FAILURES ABOVE =="; exit 1; fi
