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
#   bin/masterplan-routing-stats.sh --models               # show only the model breakdown section (skips routing table)
#   bin/masterplan-routing-stats.sh --parent               # split model attribution into parent/subagent sections
#   bin/masterplan-routing-stats.sh --file <jsonl>         # read telemetry records from one JSONL file
#
# Data sources per plan:
#   - docs/masterplan/<slug>/state.yml + events.jsonl (v3+)
#   - docs/masterplan/<slug>/subagents.jsonl + eligibility-cache.json (v3+)
#   - legacy <slug>-status.md activity log / notes (pre-v3)
#   - legacy <slug>-subagents.jsonl + <slug>-eligibility-cache.json (pre-v3)
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
models_only=0
parent_mode=0
input_file=""

usage() {
  sed -n '2,15p' "$0" | sed 's|^# \?||'
  exit "${1:-0}"
}

while (($#)); do
  arg="$1"
  shift
  case "$arg" in
    --plan=*)     plan_filter="${arg#--plan=}" ;;
    --format=*)   format="${arg#--format=}" ;;
    --all-repos)  all_repos=1 ;;
    --since=*)    since="${arg#--since=}" ;;
    --models)     models_only=1 ;;
    --parent)     parent_mode=1 ;;
    --file=*)     input_file="${arg#--file=}" ;;
    --file)
      if (($# == 0)); then
        echo "error: --file requires a path" >&2
        usage 2
      fi
      input_file="$1"
      shift
      ;;
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
  [[ -d "$root/docs/masterplan" ]] && plans_dirs+=("new:$root/docs/masterplan")
  [[ -d "$root/docs/superpowers/plans" ]] && plans_dirs+=("old:$root/docs/superpowers/plans")
  if [[ -d "$root/.worktrees" ]]; then
    while IFS= read -r wt; do
      [[ -e "$wt/.git" ]] || continue
      [[ -d "$wt/docs/masterplan" ]] && plans_dirs+=("new:$wt/docs/masterplan")
      [[ -d "$wt/docs/superpowers/plans" ]] && plans_dirs+=("old:$wt/docs/superpowers/plans")
    done < <(find "$root/.worktrees" -mindepth 1 -maxdepth 1 -type d 2>/dev/null)
  fi
}

if [[ -n "$input_file" ]]; then
  [[ -f "$input_file" ]] || { echo "error: --file path not found: $input_file" >&2; exit 2; }
  plans_dirs=("file:$input_file")
elif (( all_repos )); then
  roots=("${MASTERPLAN_REPO_ROOTS:-$HOME/dev}")
  IFS=':' read -ra root_list <<<"${roots[0]}"
  for root in "${root_list[@]}"; do
    [[ -d "$root" ]] || continue
    while IFS= read -r repo; do
      discover_plans_dirs_in_repo "$repo"
    done < <({ find "$root" -maxdepth 4 -type d -path '*/docs/superpowers/plans' 2>/dev/null \
             | sed 's|/docs/superpowers/plans$||'; \
             find "$root" -maxdepth 4 -type d -path '*/docs/masterplan' 2>/dev/null \
             | sed 's|/docs/masterplan$||'; } \
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
python3 - "$format" "$plan_filter" "$since" "$models_only" "$parent_mode" "${plans_dirs[@]}" <<'PY'
import json, os, re, sys, glob
from datetime import datetime
from collections import defaultdict

format_kind, plan_filter, since_str, models_only_str, parent_mode_str, *plans_dirs = sys.argv[1:]
models_only = models_only_str == '1'
parent_mode = parent_mode_str == '1'
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

def parse_state_yaml(text):
    fm = {}
    in_artifacts = False
    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        if line.startswith('artifacts:'):
            in_artifacts = True
            continue
        if line and not line.startswith(' '):
            in_artifacts = False
        if ':' not in line:
            continue
        k, v = line.split(':', 1)
        key = k.strip()
        val = v.strip().strip('"').strip("'")
        if in_artifacts and line.startswith('  '):
            fm[f'artifacts.{key}'] = val
        elif not line.startswith(' '):
            fm[key] = val
    return fm

def section(text, name):
    m = re.search(rf'^##\s+{re.escape(name)}\s*\n(.*?)(?=\n##\s+|\Z)', text, re.M | re.S)
    return m.group(1) if m else ''

def load_events(run_dir):
    events_path = os.path.join(run_dir, 'events.jsonl')
    lines = []
    notes = []
    if not os.path.isfile(events_path):
        return '', ''
    with open(events_path) as f:
        for line in f:
            try:
                rec = json.loads(line)
            except Exception:
                continue
            ts = rec.get('ts') or rec.get('timestamp') or rec.get('at') or ''
            msg = rec.get('message') or rec.get('event') or rec.get('type') or ''
            if msg:
                lines.append(f"- {ts} {msg}".rstrip())
            if rec.get('type') in ('note', 'blocker') or rec.get('source') == 'legacy-activity-log':
                notes.append(msg)
    return '\n'.join(lines), '\n'.join(notes)

def _num(v):
    try: return int(v or 0)
    except Exception: return 0

def token_counts(rec):
    usage = rec.get('usage') if isinstance(rec.get('usage'), dict) else {}
    input_tokens = _num(rec.get('input_tokens', usage.get('input_tokens')))
    output_tokens = _num(rec.get('output_tokens', usage.get('output_tokens')))
    cache_read = _num(rec.get('cache_read_input_tokens', usage.get('cache_read_input_tokens')))
    cache_creation = _num(rec.get('cache_creation_input_tokens', usage.get('cache_creation_input_tokens')))
    total_tokens = _num(rec.get('total_tokens', usage.get('total_tokens')))
    if total_tokens == 0:
        total_tokens = input_tokens + output_tokens + cache_read + cache_creation
    return input_tokens, output_tokens, total_tokens

def rollup_records(records, record_type=None):
    tokens_by_class = defaultdict(lambda: {'total_tokens':0,'duration_ms':0,'count':0,'input':0,'output':0})
    tokens_by_model = defaultdict(int)
    dispatches_by_model = defaultdict(int)
    count = 0
    for rec in records:
        if record_type and rec.get('type') != record_type:
            continue
        if since_dt and rec.get('ts'):
            rt = parse_ts(rec['ts'])
            if rt and rt < since_dt: continue
        count += 1
        input_tokens, output_tokens, total_tokens = token_counts(rec)
        rc = rec.get('routing_class') or rec.get('type') or 'unknown'
        tokens_by_class[rc]['total_tokens'] += total_tokens
        tokens_by_class[rc]['duration_ms'] += rec.get('duration_ms',0) or 0
        tokens_by_class[rc]['count']        += 1
        tokens_by_class[rc]['input']        += input_tokens
        tokens_by_class[rc]['output']       += output_tokens
        m = (rec.get('model') or 'unknown').lower()
        tokens_by_model[m] += total_tokens
        dispatches_by_model[m] += 1
    return {
        'tokens_by_class': dict(tokens_by_class),
        'tokens_by_model': dict(tokens_by_model),
        'dispatches_by_model': dict(dispatches_by_model),
        'subagents_records': count,
    }

def load_jsonl_records(path):
    records = []
    if os.path.isfile(path) and os.path.getsize(path) > 0:
        with open(path) as f:
            for line in f:
                try: records.append(json.loads(line))
                except Exception: continue
    return records

def empty_routing():
    return {'codex':0, 'inline':0, 'untagged_completions':0, 'predispatch_codex':0, 'predispatch_inline':0, 'review_codex':0, 'review_skip':0, 'cache_evidence_entries':0}

def empty_health():
    return {'degraded': False, 'cache_missing': False, 'cache_evidence_missing': False, 'silent_skip_count': 0, 'silent_skip_tasks': []}

def attribution_stats(records):
    return {
        'parent_turn': rollup_records(records, 'parent_turn'),
        'subagent_turn': rollup_records(records, 'subagent_turn'),
    }

def is_opus_model(model):
    return model == 'opus' or model.startswith('opus-')

def result_with_record_stats(base, stats):
    out = dict(base)
    out['tokens_by_class'] = stats['tokens_by_class']
    out['tokens_by_model'] = stats['tokens_by_model']
    out['dispatches_by_model'] = stats['dispatches_by_model']
    out['subagents_records'] = stats['subagents_records']
    return out

def analyze_plan(status_path):
    is_new = os.path.basename(status_path) == 'state.yml'
    if is_new:
        run_dir = os.path.dirname(status_path)
        slug = os.path.basename(run_dir)
        plans_dir = run_dir
        with open(status_path) as f: text = f.read()
        fm = parse_state_yaml(text)
        activity, notes = load_events(run_dir)
        plan_path = os.path.join(run_dir, 'plan.md')
    else:
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
    sub_path = os.path.join(plans_dir, 'subagents.jsonl' if is_new else slug + '-subagents.jsonl')
    subagent_records = load_jsonl_records(sub_path)
    record_stats = rollup_records(subagent_records)

    # eligibility-cache decision_source breakdown
    cache_path = os.path.join(plans_dir, 'eligibility-cache.json' if is_new else slug + '-eligibility-cache.json')
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
        'state_format': 'bundle' if is_new else 'legacy-status',
        'frontmatter': {k:fm.get(k) for k in ('status','codex_routing','codex_review','autonomy','branch')},
        'routing': dict(routing),
        'codex_share_pct': round(100*routing['codex']/total_tagged, 1) if total_tagged else None,
        'inline_models': dict(inline_models),
        'durations_min': {k: round(v/60,1) for k,v in durations.items()},
        'tokens_by_class': record_stats['tokens_by_class'],
        'tokens_by_model': record_stats['tokens_by_model'],
        'dispatches_by_model': record_stats['dispatches_by_model'],
        'subagents_records': record_stats['subagents_records'],
        'decision_sources': dict(decisions),
        'health': health,
        'attribution': attribution_stats(subagent_records),
    }

def analyze_file_records(path):
    records = load_jsonl_records(path)
    grouped = defaultdict(list)
    for rec in records:
        slug = str(rec.get('plan') or os.path.basename(path))
        grouped[slug].append(rec)
    results = []
    for slug, recs in sorted(grouped.items()):
        if plan_filter and slug != plan_filter:
            bare = re.sub(r'^\d{4}-\d{2}-\d{2}-', '', slug)
            if bare != plan_filter: continue
        stats = rollup_records(recs)
        results.append({
            'plan': slug,
            'plans_dir': os.path.dirname(path) or '.',
            'state_format': 'jsonl-file',
            'frontmatter': {},
            'routing': empty_routing(),
            'codex_share_pct': None,
            'inline_models': {},
            'durations_min': {},
            'tokens_by_class': stats['tokens_by_class'],
            'tokens_by_model': stats['tokens_by_model'],
            'dispatches_by_model': stats['dispatches_by_model'],
            'subagents_records': stats['subagents_records'],
            'decision_sources': {},
            'health': empty_health(),
            'attribution': attribution_stats(recs),
        })
    return results

# Discover all state/status files across the requested dirs.
# Dedup by slug — linked worktrees check out the same files at different
# absolute paths, but each plan-slug must be counted once. Prefer the v3 bundle
# layout over legacy status when both exist; otherwise keep the most-recently-
# modified copy per slug (likely the active worktree).
slug_to_path = {}
slug_to_kind = {}
file_inputs = []
for entry in plans_dirs:
    if ':' in entry:
        kind, d = entry.split(':', 1)
    else:
        kind, d = 'old', entry
    if kind == 'file':
        file_inputs.append(d)
        continue
    pattern = os.path.join(d, '*', 'state.yml') if kind == 'new' else os.path.join(d, '*-status.md')
    for pf in glob.glob(pattern):
        slug = os.path.basename(os.path.dirname(pf)) if kind == 'new' else os.path.basename(pf).removesuffix('-status.md')
        try: pf_mtime = os.path.getmtime(pf)
        except OSError: continue
        existing = slug_to_path.get(slug)
        existing_kind = slug_to_kind.get(slug)
        if existing is None or (kind == 'new' and existing_kind != 'new') or (kind == existing_kind and pf_mtime > os.path.getmtime(existing)):
            slug_to_path[slug] = pf
            slug_to_kind[slug] = kind
plan_files = sorted(slug_to_path.values())

results = []
for path in file_inputs:
    try:
        results.extend(analyze_file_records(path))
    except Exception as e:
        results.append({'plan': os.path.basename(path), 'error': str(e)})
for pf in plan_files:
    slug = os.path.basename(os.path.dirname(pf)) if os.path.basename(pf) == 'state.yml' else os.path.basename(pf).removesuffix('-status.md')
    if plan_filter and slug != plan_filter:
        # Also accept a bare slug that matches the date-stripped suffix
        # (e.g. "phase-5-southbound-ipc" matching "2026-05-06-phase-5-southbound-ipc").
        bare = re.sub(r'^\d{4}-\d{2}-\d{2}-', '', slug)
        if bare != plan_filter: continue
    try:
        results.append(analyze_plan(pf))
    except Exception as e:
        results.append({'plan': slug, 'error': str(e)})

# Aggregate
def build_aggregate(result_set):
    def agg(field, sub=None):
        if sub:
            return sum((r.get(field,{}).get(sub,0) or 0) for r in result_set if 'error' not in r)
        return sum((r.get(field,0) or 0) for r in result_set if 'error' not in r)

    aggregate = {
        'plans_count': len([r for r in result_set if 'error' not in r]),
        'codex_total': agg('routing','codex'),
        'inline_total': agg('routing','inline'),
        'untagged_total': agg('routing','untagged_completions'),
        'subagents_records_total': agg('subagents_records'),
    }
    total_tagged = aggregate['codex_total'] + aggregate['inline_total']
    aggregate['codex_share_pct'] = round(100*aggregate['codex_total']/total_tagged, 1) if total_tagged else None
    inline_model_totals = defaultdict(int)
    class_token_totals  = defaultdict(int)
    for r in result_set:
        if 'error' in r: continue
        for m,c in (r.get('inline_models') or {}).items(): inline_model_totals[m] += c
        for c,d in (r.get('tokens_by_class') or {}).items(): class_token_totals[c] += d.get('total_tokens',0)
    aggregate['inline_models_total'] = dict(inline_model_totals)
    aggregate['tokens_by_class_total'] = dict(class_token_totals)
    # opus_share — defined per docs/design/telemetry-signals.md
    opus_token_sum = 0
    all_token_sum = 0
    dispatches_by_model_total = defaultdict(int)
    for r in result_set:
        if 'error' in r: continue
        for m, t in (r.get('tokens_by_model') or {}).items():
            all_token_sum += t
            if is_opus_model(m): opus_token_sum += t
        for m, c in (r.get('dispatches_by_model') or {}).items():
            dispatches_by_model_total[m] += c
    aggregate['opus_share'] = round(opus_token_sum / all_token_sum, 3) if all_token_sum else None
    aggregate['attributed_tokens_total'] = all_token_sum
    aggregate['dispatches_by_model_total'] = dict(dispatches_by_model_total)
    aggregate['opus_share_health'] = (
        'healthy' if aggregate['opus_share'] is not None and aggregate['opus_share'] < 0.10 else
        'regression' if aggregate['opus_share'] is not None and aggregate['opus_share'] > 0.30 else
        'watch' if aggregate['opus_share'] is not None else 'no-data'
    )
    return aggregate

aggregate = build_aggregate(results)

# ------------------------------------------------------------------
# Output rendering
# ------------------------------------------------------------------
def _note_no_subagents():
    print("\nNote: zero subagents.jsonl records found. Token data unavailable.")
    print("v2.4.0's agent_id dedup populates subagents.jsonl on the next /masterplan turn — re-run after to see token breakdowns.")

def render_models(a=None, result_set=None):
    a = aggregate if a is None else a
    result_set = results if result_set is None else result_set
    n = a['plans_count']
    since_label = f", since {since_str}" if since_str else ''
    print(f"\nModel breakdown ({n} plan{'s' if n != 1 else ''}{since_label}):")
    dbt = a.get('dispatches_by_model_total') or {}
    tbt_total = a.get('attributed_tokens_total') or 0
    codex_calls = a.get('codex_total', 0)
    # Known model ordering: haiku, sonnet, opus, then remaining sorted, then codex, then unknown
    known_order = ['haiku', 'sonnet', 'opus']
    all_dispatch_models = set(dbt.keys()) - {'unknown'}
    extra_models = sorted(all_dispatch_models - set(known_order))
    model_order = known_order + extra_models
    for m in model_order:
        dispatches = dbt.get(m, 0)
        tokens = 0
        for r in result_set:
            if 'error' in r: continue
            tokens += (r.get('tokens_by_model') or {}).get(m, 0)
        pct_str = f"({round(100*tokens/tbt_total)}% of attributed tokens)" if tbt_total else ''
        print(f"  {m:<8} {dispatches:>4} dispatches  {tokens:>10,} tokens   {pct_str}")
    # codex is out-of-process — no token attribution
    print(f"  {'codex':<8} {codex_calls:>4} calls         (out-of-process, no token attribution)")
    # unknown — records with missing model field
    unknown_dispatches = dbt.get('unknown', 0)
    unknown_tokens = sum(
        (r.get('tokens_by_model') or {}).get('unknown', 0)
        for r in result_set if 'error' not in r
    )
    pct_str = f"({round(100*unknown_tokens/tbt_total)}% of attributed tokens)" if tbt_total and unknown_tokens else ''
    print(f"  {'unknown':<8} {unknown_dispatches:>4} dispatches  {unknown_tokens:>10,} tokens   {pct_str}")
    # opus_share summary line
    opus_share = a.get('opus_share')
    health = a.get('opus_share_health', 'no-data')
    health_label = ' (regression — target < 0.10)' if health == 'regression' else f' ({health})'
    opus_share_str = f"{opus_share:.3f}" if opus_share is not None else 'n/a'
    print(f"\n  opus_share: {opus_share_str}{health_label}")
    if a.get('subagents_records_total', 0) == 0:
        _note_no_subagents()

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
    render_models()
    if a['untagged_total']:
        print(f"\nNote: {a['untagged_total']} untagged completion entries across all plans (no [codex]/[inline] tag).")
        print("These predate v2.4.0's mandatory routing tags OR were skipped via the silent-fallthrough bug Fixes 1-5+P1-P5 prevent.")

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

def results_for_attribution(record_type):
    section_results = []
    for r in results:
        if 'error' in r:
            section_results.append(r)
            continue
        stats = (r.get('attribution') or {}).get(record_type) or rollup_records([], record_type)
        section_results.append(result_with_record_stats(r, stats))
    return section_results

def attribution_payload(record_type):
    section_results = results_for_attribution(record_type)
    return {'plans': section_results, 'aggregate': build_aggregate(section_results)}

def render_parent_attribution():
    parent = attribution_payload('parent_turn')
    subagent = attribution_payload('subagent_turn')
    print("## Parent attribution")
    render_models(parent['aggregate'], parent['plans'])
    print("\n## Subagent attribution")
    render_models(subagent['aggregate'], subagent['plans'])

if parent_mode and format_kind == 'json':
    parent = attribution_payload('parent_turn')
    subagent = attribution_payload('subagent_turn')
    json.dump({'parent_attribution': parent, 'subagent_attribution': subagent, 'plan_filter': plan_filter or None, 'since': since_str or None}, sys.stdout, indent=2)
    print()
elif format_kind == 'json':
    json.dump({'plans': results, 'aggregate': aggregate, 'plan_filter': plan_filter or None, 'since': since_str or None}, sys.stdout, indent=2)
    print()
elif parent_mode:
    render_parent_attribution()
elif format_kind == 'md':
    render_md()
else:
    if models_only:
        render_models()
    else:
        render_table()
PY
