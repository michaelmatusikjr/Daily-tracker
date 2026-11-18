#!/usr/bin/env bash
# Runs the Daily Tracker browser test suites (Playwright + Chromium).
# Usage:  tests/run-all.sh            # every suite
#         tests/run-all.sh t21 t25    # only the named suites
# Needs: node, python3, and `require('playwright')` with Chromium available.
# t17 (push client) also needs the push server's dev dependencies: (cd server && npm ci).
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TESTS="$ROOT/tests"
TMP="$(mktemp -d)"
trap 'kill $P1 $P2 2>/dev/null; rm -rf "$TMP"' EXIT

# 8080 serves the app at the site root; 8081 serves it under a sub-path, like GitHub Pages.
ln -s "$ROOT" "$TMP/Daily-tracker-"
(cd "$ROOT" && python3 -m http.server 8080 --bind 127.0.0.1 >/dev/null 2>&1) & P1=$!
(cd "$TMP" && python3 -m http.server 8081 --bind 127.0.0.1 >/dev/null 2>&1) & P2=$!
sleep 1

SUITES=("$@")
if [ ${#SUITES[@]} -eq 0 ]; then
  SUITES=(parse t1 t3 t4 t5 t6 t9 t10 t12 t13 t14 t15 t16 t17 t17-sw t18 t19 t20 t21 t23 t24 t25 t26 t27 t28 t29 t30 t31 t32 t33 t34 nullcheck)
fi

fail=0
for s in "${SUITES[@]}"; do
  case "$s" in
    parse) cmd=(node "$TESTS/parse-test.mjs") ;;
    *)     cmd=(node "$TESTS/$s.js") ;;
  esac
  out="$TMP/$s.out"
  if (cd "$TESTS" && timeout 600 "${cmd[@]}") >"$out" 2>&1 && ! grep -q '^FAIL' "$out"; then
    echo "PASS $s"
  else
    echo "FAIL $s"; grep '^FAIL' "$out" | head -5; tail -3 "$out"; fail=1
  fi
done
exit $fail
