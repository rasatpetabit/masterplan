#!/usr/bin/env bash
# Doctor-fixture runner.
#
# For each check whose body in parts/doctor.md contains an extractable ```bash
# block (currently #32, #33, #34, #35, #36, #38, #39, #40, #41), the runner:
#   1. extracts the bash block from parts/doctor.md (between ## Check #NN and
#      the next ## Check / ## ## / EOF);
#   2. for each fixture directory under tests/doctor-fixtures/check-NN/:
#      - sets HOME=<fixture>/home (so $HOME/.codex/auth.json + $HOME/.claude
#        resolve to fixture-controlled stubs);
#      - cds into the fixture root so the bash block's relative paths
#        (`docs/masterplan/*/state.yml`) resolve under the fixture;
#      - executes the bash block in a clean subshell;
#      - reads the fixture's `expected.txt` and asserts each line appears as a
#        substring in the actual output (order doesn't matter).
#
# Fixture naming convention: <verdict>-<short-description>/
#   pass-...      → expected verdict line is "Check #NN: PASS"
#   fail-...      → expected verdict line is "Check #NN: WARN" or "Check #NN: ERROR"
#   info-...      → expected verdict line includes "INFO"
# (The convention is documentary; the actual assertion is by expected.txt.)
#
# Exit 0 if all fixtures pass; non-zero if any fail.

set -u
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
[ -n "$REPO_ROOT" ] || { echo "FAIL: not in a git repo"; exit 2; }
cd "$REPO_ROOT" || exit 2

DOCTOR_MD="$REPO_ROOT/parts/doctor.md"
[ -f "$DOCTOR_MD" ] || { echo "FAIL: $DOCTOR_MD missing"; exit 2; }

# extract_check_bash <NN> — print the first ```bash block under ## Check #NN
extract_check_bash() {
  local nn="$1"
  awk -v want="$nn" '
    # Match either "## Check #N —" or "## Check #N:" header forms.
    /^## Check #[0-9]+([[:space:]]|[—:])/ {
      n=$0
      sub(/^## Check #/,"",n); sub(/[^0-9].*/,"",n)
      if (n == want) { in_check=1; in_bash=0; next }
      if (in_check)  { exit }  # next check started — stop
    }
    in_check && /^```bash[[:space:]]*$/ { in_bash=1; next }
    in_check && in_bash && /^```[[:space:]]*$/ { exit }
    in_check && in_bash { print }
  ' "$DOCTOR_MD"
}

# Pretty-print: indent lines with "  | "
indent() { sed 's/^/  | /'; }

total_fixtures=0
passed_fixtures=0
failed_fixtures=0
missing_blocks=0

for check_dir in "$REPO_ROOT"/tests/doctor-fixtures/check-*/; do
  [ -d "$check_dir" ] || continue
  nn="$(basename "$check_dir" | sed 's/^check-//')"

  block="$(extract_check_bash "$nn")"
  if [ -z "$block" ]; then
    echo "SKIP check-$nn: no extractable bash block in parts/doctor.md"
    missing_blocks=$((missing_blocks + 1))
    continue
  fi

  for fixture in "$check_dir"*/; do
    [ -d "$fixture" ] || continue
    fname="$(basename "$fixture")"
    total_fixtures=$((total_fixtures + 1))

    expected_file="$fixture/expected.txt"
    if [ ! -f "$expected_file" ]; then
      echo "FAIL check-$nn/$fname: missing expected.txt"
      failed_fixtures=$((failed_fixtures + 1))
      continue
    fi

    # Per-fixture HOME isolates the check from the runner's real home.
    fixture_home="$fixture/home"
    [ -d "$fixture_home" ] || fixture_home="$fixture"

    # Execute in a fresh subshell with controlled HOME + cwd.
    actual="$(cd "$fixture" && HOME="$fixture_home" bash -c "$block" 2>&1)"

    # Assert: every non-empty line in expected.txt must appear as substring
    # in actual output. Empty lines in expected.txt are ignored.
    missing_lines=()
    while IFS= read -r exp_line; do
      [ -z "$exp_line" ] && continue
      if ! printf '%s\n' "$actual" | grep -qF -- "$exp_line"; then
        missing_lines+=("$exp_line")
      fi
    done < "$expected_file"

    if [ ${#missing_lines[@]} -eq 0 ]; then
      echo "PASS check-$nn/$fname"
      passed_fixtures=$((passed_fixtures + 1))
    else
      echo "FAIL check-$nn/$fname"
      echo "  expected lines not found in output:"
      for ml in "${missing_lines[@]}"; do
        printf '    - %s\n' "$ml"
      done
      echo "  actual output:"
      printf '%s\n' "$actual" | indent
      failed_fixtures=$((failed_fixtures + 1))
    fi
  done
done

echo ""
echo "=== doctor-fixtures: $passed_fixtures passed, $failed_fixtures failed (of $total_fixtures fixtures); $missing_blocks check-dir(s) had no extractable block ==="
[ "$failed_fixtures" -eq 0 ]
