#!/usr/bin/env bash
# release-check.sh — Quick sanity checks before publishing daeva
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; NC='\033[0m'
PASS=0; FAIL=0

check() {
  local label="$1"; shift
  if "$@" >/dev/null 2>&1; then
    echo -e "${GREEN}PASS${NC}  $label"
    PASS=$((PASS + 1))
  else
    echo -e "${RED}FAIL${NC}  $label"
    FAIL=$((FAIL + 1))
  fi
}

cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "Running release checks for daeva..."
echo

check "LICENSE exists"        test -f LICENSE
check "README.md exists"      test -f README.md
check "package.json exists"   test -f package.json
check "npm install"           npm install --ignore-scripts
check "typecheck"             npm run typecheck
check "build"                 npm run build
check "test"                  npm test
check "npm pack (dry-run)"    npm pack --dry-run

echo
echo "---"
echo -e "${GREEN}${PASS} passed${NC}, ${RED}${FAIL} failed${NC}"

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi

echo
echo "Ready to publish."
