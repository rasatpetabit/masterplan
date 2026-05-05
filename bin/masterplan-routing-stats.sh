#!/usr/bin/env bash
# masterplan-routing-stats.sh — Report codex-vs-inline routing distribution
# across /masterplan plans, including inline model breakdown when subagents.jsonl
# data is available.
#
# Usage:
#   bin/masterplan-routing-stats.sh                        # current repo + worktrees, table format
#   bin/masterplan-routing-stats.sh --plan=<slug>          # single plan
#   bin/masterplan-routing-stats.sh --format=table|json|md # output format (default: table)
#   bin/masterplan-routing-stats.sh --all-repos            # scan every repo under $MASTERPLAN_REPO_ROOTS (default: $HOME/dev)
#   bin/masterplan-routing-stats.sh --since=YYYY-MM-DD     # only count log entries on/after this date
#
# Data sources per plan:
#   - <slug>-status.md activity log (routing tags, inline model hints, timestamps)
#   - <slug>-subagents.jsonl (token totals, exact model, routing_class — v2.4.0+)
#   - <slug>-eligibility-cache.json (decision_source, dispatched_to runtime audit)
#   - <slug>-status.md `## Notes` (degradation markers, silent-skip footprint)
#
# Required: bash, jq, awk, python3, git.
# License: MIT (matches parent plugin).

set -u

# ------------------------------------------------------------------
# Arg parsing
# ------------------------------------------------------------------
plan_filter=""
format="table"
all_repos=0
since=""

usage() {
  sed -n '2,15p' "$0" | sed 's|^# \?||'
  exit "${1:-0}"
}

for arg in "$@"; do
  case "$arg" in
    --plan=*)     plan_filter="${arg#--plan=}" ;;
    --format=*)   format="${arg#--format=}" ;;
    --all-repos)  all_repos=1 ;;
    --since=*)    since="${arg#--since=}" ;;
    -h|--help)    usage 0 ;;
    *)            echo "unknown arg: $arg" >&2; usage 2 ;;
  esac
done

case "$format" in
  table|json|md) ;;
  *) echo "unknown --format: $format (expected: table|json|md)" >&2; exit 2 ;;
esac

# ------------------------------------------------------------------
# Plans-directory discovery
# ------------------------------------------------------------------
plans_dirs=()

discover_plans_dirs_in_repo() {
  local root="$1"
  [[ -d "$root/docs/superpowers/plans" ]] && plans_dirs+=("$root/docs/superpowers/plans")
  if [[ -d "$root/.worktrees" ]]; then
    while IFS= read -r wt; do
      [[ -e "$wt/.git" ]] || continue
      [[ -d "$wt/docs/superpowers/plans" ]] && plans_dirs+=("$wt/docs/superpowers/plans")
    done < <(find "$root/.worktrees" -mindepth 1 -maxdepth 1 -type d 2>/dev/null)
  fi
}

if (( all_repos )); then
  roots=("${MASTERPLAN_REPO_ROOTS:-$HOME/dev}")
  IFS=':' read -ra root_list <<<"${roots[0]}"
  for root in "${root_list[@]}"; do
    [[ -d "$root" ]] || continue
    while IFS= read -r repo; do
      discover_plans_dirs_in_repo "$repo"
    done < <(find "$root" -maxdepth 4 -type d -name plans -path '*/docs/superpowers/plans' 2>/dev/null \
             | sed 's|/docs/superpowers/plans$||' \
             | sort -u)
  done
else
  worktree=$(git rev-parse --show-toplevel 2>/dev/null) || {
    echo "error: not in a git repo (use --all-repos to scan known repos)" >&2; exit 2; }
  discover_plans_dirs_in_repo "$worktree"
fi

if [[ ${#plans_dirs[@]} -eq 0 ]]; then
  case "$format" in
    json) echo '{"plans":[],"aggregate":{"note":"no plans found"}}' ;;
    *)    echo "(no /masterplan plans found in scope)" ;;
  esac
  exit 0
fi

# ------------------------------------------------------------------
# Per-plan analysis (delegated to python3 — bash + jq + awk would be too gnarly
# for the cross-source aggregation. Python is in the existing tool-guard set.)
# ------------------------------------------------------------------
python3 - "$format" "$plan_filter" "$since" "${plans_dirs[@]}" <<'PY'
import json, os, re, sys, glob
from datetime import datetime
from collections import defaultdict

format_kind, plan_filter, since_str, *plans_dirs = sys.argv[1:]
since_dt = None
if since_str:
    try: since_dt = datetime.fromisoformat(since_str + ('T00:00:00+00:00' if 'T' not in since_str else ''))
    except Exception: print(f"error: --since must be ISO date (got {since_str!r})", file=sys.stderr); sys.exit(2)

ts_re      = re.compile(r'^- (\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)\s+(.*)$')
codex_re   = re.compile(r'\[codex')
inline_re  = re.compile(r'\[inline')
model_re   = re.compile(r'\[(?:inline)?\]?\[subagent[:\s]+(\w+)\]', re.I)  # [inline][subagent: sonnet]
model_re2  = re.compile(r'\bmodel[:\s]+(sonnet|haiku|opus)\b', re.I)
predisp_re = re.compile(r'routing→(CODEX|INLINE)', re.I)
review_re  = re.compile(r'review→(CODEX|SKIP)', re.I)
cache_evidence_re = re.compile(r'eligibility cache:')
codex_ok_re  = re.compile(r'\*\*Codex:\*\*\s*ok', re.I)
plan_task_re = re.compile(r'^#{2,4}\s+Task\s+(\S+):\s*(.+?)$', re.M)

def parse_ts(s):
    s = s.replace('Z','+00:00').replace(' ','T')
    if not re.search(r'[+-]\d{2}:?\d{2}$', s): s += '+00:00'
    s = re.sub(r'([+-]\d{2})(\d{2})$', r'\1:\2', s)
    if re.match(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}[+-]', s):
        s = s[:16] + ':00' + s[16:]
    try: return datetime.fromisoformat(s)
    except Exception: return None

def parse_frontmatter(text):
    m = re.match(r'---\n(.*?)\n---', text, re.S)
    if not m: return {}
    fm = {}
    for line in m.group(1).splitlines():
        if ':' in line:
            k,v = line.split(':',1); fm[k.strip()] = v.strip().strip('"').strip("'")
    return fm

def section(text, name):
    m = re.search(rf'^##\s+{re.escape(name)}\s*\n(.*?)(?=\n##\s+|\Z)', text, re.M | re.S)
    return m.group(1) if m else ''

def analyze_plan(status_path):
    slug = os.path.basename(status_path).removesuffix('-status.md')
    plans_dir = os.path.dirname(status_path)
    with open(status_path) as f: text = f.read()
    fm = parse_frontmatter(text)
    activity = section(text, 'Activity log')
    notes    = section(text, 'Notes')

    plan_path = os.path.join(plans_dir, slug + '.md')
    plan_text = open(plan_path).read() if os.path.isfile(plan_path) else ''
    codex_ok_tasks = set()
    if plan_text:
        for tm in plan_task_re.finditer(plan_text):
            t_idx, t_name = tm.group(1).strip(), tm.group(2).strip()
            tail = plan_text[tm.end():tm.end()+4000]
            next_task = plan_task_re.search(tail)
            block = tail[:next_task.start()] if next_task else tail
            if codex_ok_re.search(block): codex_ok_tasks.add(t_idx)

    routing = {'codex':0, 'inline':0, 'untagged_completions':0, 'predispatch_codex':0, 'predispatch_inline':0, 'review_codex':0, 'review_skip':0, 'cache_evidence_entries':0}
    inline_models = defaultdict(int)
    durations = defaultdict(float)
    last_ts = None
    silent_skip_tasks = []

    for line in activity.splitlines():
        m = ts_re.match(line.rstrip())
        if not m: continue
        ts = parse_ts(m.group(1)); body = m.group(2)
        if since_dt and ts and ts < since_dt: last_ts = ts; continue
        if cache_evidence_re.search(body): routing['cache_evidence_entries'] += 1
        pm = predisp_re.search(body)
        if pm:
            routing['predispatch_codex' if pm.group(1).upper()=='CODEX' else 'predispatch_inline'] += 1
            last_ts = ts; continue
        rm = review_re.search(body)
        if rm:
            routing['review_codex' if rm.group(1).upper()=='CODEX' else 'review_skip'] += 1
            last_ts = ts; continue
        is_codex = bool(codex_re.search(body))
        is_inline = bool(inline_re.search(body))
        # Detect task-completion entries. Three formats observed in the wild:
        #   1. "task \"<name>\" complete, commit <sha> [tag] (verify: ...)"
        #   2. "T<idx> complete, commit <sha> [tag] (verify: ...)"  (petabit-os-mgmt mgmtd style)
        #   3. "Task <idx> (<name>) complete (...)" (optoe-ng project-review style; capital T)
        # Match either: lowercase "task " OR capital "Task " OR starts with "T<digit>".
        is_completion = (
            ('task ' in body or 'Task ' in body or re.match(r'^T\d', body))
            and ('complete' in body or 'COMPLETE' in body)
        )
        if is_completion:
            if is_codex:
                routing['codex'] += 1
                if last_ts and ts:
                    dt = (ts - last_ts).total_seconds()
                    if 0 < dt < 86400: durations['codex'] += dt
            elif is_inline:
                routing['inline'] += 1
                if last_ts and ts:
                    dt = (ts - last_ts).total_seconds()
                    if 0 < dt < 86400: durations['inline'] += dt
                mm = model_re.search(body) or model_re2.search(body)
                if mm:
                    inline_models[mm.group(1).lower()] += 1
                else:
                    inline_models['unspecified'] += 1
                # silent-skip detection: inline task whose plan annotation is **Codex:** ok
                # AND no degraded-no-codex marker in body
                tm = re.search(r'[Tt]ask\s+(?:T|"?)([^"]+?)["\s\(]', body)
                if tm and tm.group(1).strip() in codex_ok_tasks and 'degraded' not in body.lower():
                    silent_skip_tasks.append(tm.group(1).strip())
            else:
                routing['untagged_completions'] += 1
                tm = re.search(r'[Tt]ask\s+(?:T|"?)([^"]+?)["\s\(]', body)
                if tm and tm.group(1).strip() in codex_ok_tasks:
                    silent_skip_tasks.append(tm.group(1).strip())
        if ts: last_ts = ts

    # subagents.jsonl — token totals + routing_class breakdown (v2.4.0+)
    sub_path = os.path.join(plans_dir, slug + '-subagents.jsonl')
    tokens_by_class = defaultdict(lambda: {'total_tokens':0,'duration_ms':0,'count':0,'input':0,'output':0})
    tokens_by_model = defaultdict(int)
    sub_records = 0
    if os.path.isfile(sub_path) and os.path.getsize(sub_path) > 0:
        with open(sub_path) as f:
            for line in f:
                try: rec = json.loads(line)
                except Exception: continue
                if since_dt and rec.get('ts'):
                    rt = parse_ts(rec['ts'])
                    if rt and rt < since_dt: continue
                sub_records += 1
                rc = rec.get('routing_class') or 'unknown'
                tokens_by_class[rc]['total_tokens'] += rec.get('total_tokens',0) or 0
                tokens_by_class[rc]['duration_ms'] += rec.get('duration_ms',0) or 0
                tokens_by_class[rc]['count']        += 1
                tokens_by_class[rc]['input']        += rec.get('input_tokens',0) or 0
                tokens_by_class[rc]['output']       += rec.get('output_tokens',0) or 0
                m = (rec.get('model') or 'unknown').lower()
                tokens_by_model[m] += rec.get('total_tokens',0) or 0

    # eligibility-cache decision_source breakdown
    cache_path = os.path.join(plans_dir, slug + '-eligibility-cache.json')
    decisions = defaultdict(int)
    cache_present = os.path.isfile(cache_path)
    if cache_present:
        try:
            cache = json.load(open(cache_path))
            for t in cache.get('tasks', []):
                ds = t.get('decision_source') or 'unstamped'
                decisions[ds] += 1
        except Exception: pass

    health = {
        'degraded':              bool(re.search(r'⚠ Codex degraded', notes)),
        'cache_missing':         (fm.get('codex_routing','off') != 'off') and not cache_present,
        'cache_evidence_missing':(fm.get('codex_routing','off') != 'off') and routing['cache_evidence_entries']==0 and (routing['codex']+routing['inline']+routing['untagged_completions'])>0,
        'silent_skip_count':     len(silent_skip_tasks),
        'silent_skip_tasks':     sorted(set(silent_skip_tasks))[:10],  # cap
    }

    total_tagged = routing['codex'] + routing['inline']
    return {
        'plan': slug,
        'plans_dir': plans_dir,
        'frontmatter': {k:fm.get(k) for k in ('status','codex_routing','codex_review','autonomy','branch')},
        'routing': dict(routing),
        'codex_share_pct': round(100*routing['codex']/total_tagged, 1) if total_tagged else None,
        'inline_models': dict(inline_models),
        'durations_min': {k: round(v/60,1) for k,v in durations.items()},
        'tokens_by_class': dict(tokens_by_class),
        'tokens_by_model': dict(tokens_by_model),
        'subagents_records': sub_records,
        'decision_sources': dict(decisions),
        'health': health,
    }

# Discover all status files across the requested plans dirs.
# Dedup by slug — linked worktrees check out the same plans/ files at different
# absolute paths, but each plan-slug must be counted once. Keep the most-recently-
# modified copy per slug (likely the active worktree).
slug_to_path = {}
for d in plans_dirs:
    for pf in glob.glob(os.path.join(d, '*-status.md')):
        slug = os.path.basename(pf).removesuffix('-status.md')
        try: pf_mtime = os.path.getmtime(pf)
        except OSError: continue
        existing = slug_to_path.get(slug)
        if existing is None or pf_mtime > os.path.getmtime(existing):
            slug_to_path[slug] = pf
plan_files = sorted(slug_to_path.values())

results = []
for pf in plan_files:
    slug = os.path.basename(pf).removesuffix('-status.md')
    if plan_filter and slug != plan_filter: continue
    try:
        results.append(analyze_plan(pf))
    except Exception as e:
        results.append({'plan': slug, 'error': str(e)})

# Aggregate
def agg(field, sub=None):
    if sub:
        return sum((r.get(field,{}).get(sub,0) or 0) for r in results if 'error' not in r)
    return sum((r.get(field,0) or 0) for r in results if 'error' not in r)

aggregate = {
    'plans_count': len([r for r in results if 'error' not in r]),
    'codex_total': agg('routing','codex'),
    'inline_total': agg('routing','inline'),
    'untagged_total': agg('routing','untagged_completions'),
    'subagents_records_total': agg('subagents_records'),
}
total_tagged = aggregate['codex_total'] + aggregate['inline_total']
aggregate['codex_share_pct'] = round(100*aggregate['codex_total']/total_tagged, 1) if total_tagged else None
inline_model_totals = defaultdict(int)
class_token_totals  = defaultdict(int)
for r in results:
    if 'error' in r: continue
    for m,c in (r.get('inline_models') or {}).items(): inline_model_totals[m] += c
    for c,d in (r.get('tokens_by_class') or {}).items(): class_token_totals[c] += d.get('total_tokens',0)
aggregate['inline_models_total'] = dict(inline_model_totals)
aggregate['tokens_by_class_total'] = dict(class_token_totals)
# opus_share — defined per docs/design/telemetry-signals.md
opus_token_sum = 0
all_token_sum = 0
for r in results:
    if 'error' in r: continue
    for m, t in (r.get('tokens_by_model') or {}).items():
        all_token_sum += t
        if m == 'opus': opus_token_sum += t
aggregate['opus_share'] = round(opus_token_sum / all_token_sum, 3) if all_token_sum else None
aggregate['opus_share_health'] = (
    'healthy' if aggregate['opus_share'] is not None and aggregate['opus_share'] < 0.10 else
    'regression' if aggregate['opus_share'] is not None and aggregate['opus_share'] > 0.30 else
    'watch' if aggregate['opus_share'] is not None else 'no-data'
)

# ------------------------------------------------------------------
# Output rendering
# ------------------------------------------------------------------
def render_table():
    print(f"{'Plan':50} {'codex#':>6} {'inline#':>7} {'%cdx':>4}  {'inline-models':25} {'sub#':>5}  health")
    print('-'*135)
    for r in results:
        if 'error' in r:
            print(f"{r['plan']:50} ERROR: {r['error']}"); continue
        plan = r['plan']
        if len(plan) > 50: plan = plan[:47] + '…'
        rt = r['routing']
        pct = f"{r['codex_share_pct']}%" if r['codex_share_pct'] is not None else '—'
        models = ' '.join(f"{m}:{c}" for m,c in sorted((r['inline_models'] or {}).items())) or '(none)'
        if len(models) > 25: models = models[:22] + '…'
        flags = []
        h = r['health']
        if h['degraded']:               flags.append('DEGRADED')
        if h['cache_missing']:          flags.append('cache-missing')
        if h['cache_evidence_missing']: flags.append('no-cache-evidence')
        if h['silent_skip_count']:      flags.append(f'silent-skips={h["silent_skip_count"]}')
        flag_str = ', '.join(flags) if flags else 'ok'
        print(f"{plan:50} {rt['codex']:>6} {rt['inline']:>7} {pct:>4}  {models:25} {r['subagents_records']:>5}  {flag_str}")
    print('-'*135)
    a = aggregate
    pct = f"{a['codex_share_pct']}%" if a['codex_share_pct'] is not None else '—'
    models = ' '.join(f"{m}:{c}" for m,c in sorted(a['inline_models_total'].items())) or '(none)'
    if len(models) > 25: models = models[:22] + '…'
    print(f"{'AGGREGATE ('+str(a['plans_count'])+' plans)':50} {a['codex_total']:>6} {a['inline_total']:>7} {pct:>4}  {models:25} {a['subagents_records_total']:>5}  opus_share={a['opus_share']} ({a['opus_share_health']})")
    if a['untagged_total']:
        print(f"\nNote: {a['untagged_total']} untagged completion entries across all plans (no [codex]/[inline] tag).")
        print("These predate v2.4.0's mandatory routing tags OR were skipped via the silent-fallthrough bug Fixes 1-5+P1-P5 prevent.")
    if a['subagents_records_total'] == 0:
        print("\nNote: zero subagents.jsonl records found. Token data unavailable.")
        print("v2.4.0's agent_id dedup populates subagents.jsonl on the next /masterplan turn — re-run after to see token breakdowns.")

def render_md():
    print(f"# /masterplan routing stats\n")
    pct_agg = f"{aggregate['codex_share_pct']}%" if aggregate['codex_share_pct'] is not None else '—'
    print(f"**Aggregate**: {aggregate['plans_count']} plans, {aggregate['codex_total']} codex / {aggregate['inline_total']} inline ({pct_agg} codex)\n")
    print(f"| Plan | codex# | inline# | %codex | inline models | subagent recs | health |")
    print(f"|---|---:|---:|---:|---|---:|---|")
    for r in results:
        if 'error' in r: print(f"| `{r['plan']}` | — | — | — | — | — | ERROR: {r['error']} |"); continue
        rt = r['routing']
        pct = f"{r['codex_share_pct']}%" if r['codex_share_pct'] is not None else '—'
        models = ' '.join(f"`{m}`:{c}" for m,c in sorted((r['inline_models'] or {}).items())) or '_(none)_'
        h = r['health']; flags = []
        if h['degraded']:               flags.append('⚠ DEGRADED')
        if h['cache_missing']:          flags.append('cache-missing')
        if h['cache_evidence_missing']: flags.append('no-cache-evidence')
        if h['silent_skip_count']:      flags.append(f'silent-skips={h["silent_skip_count"]}')
        flag_str = ', '.join(flags) if flags else 'ok'
        print(f"| `{r['plan']}` | {rt['codex']} | {rt['inline']} | {pct} | {models} | {r['subagents_records']} | {flag_str} |")
    a = aggregate
    print(f"\n**opus_share**: {a['opus_share']} ({a['opus_share_health']}) — per `docs/design/telemetry-signals.md` (healthy < 0.10, regression > 0.30)")
    if a['subagents_records_total'] == 0:
        print(f"\n> ⚠ Token data unavailable: zero subagents.jsonl records. v2.4.0's agent_id dedup populates this on next /masterplan turn.")

if format_kind == 'json':
    json.dump({'plans': results, 'aggregate': aggregate, 'plan_filter': plan_filter or None, 'since': since_str or None}, sys.stdout, indent=2)
    print()
elif format_kind == 'md':
    render_md()
else:
    render_table()
PY
