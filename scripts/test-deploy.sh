#!/usr/bin/env bash
# Tests for scripts/deploy.sh — the guarded api-qa deploy wrapper.
#
# Each scenario builds a throwaway git sandbox (bare "origin" + a working
# clone) and runs deploy.sh inside it with a stub `npx` on PATH, so no real
# wrangler, network, or Cloudflare account is ever touched. The stub answers
# `wrangler whoami` / `wrangler deployments list --json` from env vars and
# records `wrangler deploy` args instead of deploying.
#
# Run:  bash scripts/test-deploy.sh
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
DEPLOY_SH="$REPO_ROOT/scripts/deploy.sh"

WORK=$(mktemp -d "${TMPDIR:-/tmp}/deploy-test.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0

ok()   { PASS=$((PASS + 1)); echo "  ok   - $1"; }
bad()  { FAIL=$((FAIL + 1)); echo "  FAIL - $1"; }

# assert_contains <file> <needle> <desc>
assert_contains() {
  if grep -qF -- "$2" "$1"; then ok "$3"; else bad "$3 (missing: $2)"; fi
}
assert_exit_nonzero() { # <code> <desc>
  if [ "$1" -ne 0 ]; then ok "$2"; else bad "$2 (exited 0)"; fi
}
assert_exit_zero() { # <code> <desc>
  if [ "$1" -eq 0 ]; then ok "$2"; else bad "$2 (exited $1)"; fi
}
assert_no_deploy() { # <desc>
  if [ ! -s "$STUB_DEPLOY_LOG" ]; then ok "$1"; else bad "$1 (wrangler deploy WAS invoked)"; fi
}
assert_deployed() { # <desc>
  if [ -s "$STUB_DEPLOY_LOG" ]; then ok "$1"; else bad "$1 (wrangler deploy was never invoked)"; fi
}

# ---------------------------------------------------------------------------
# Stub npx: intercepts `npx wrangler ...` via PATH.
STUBBIN="$WORK/bin"
mkdir -p "$STUBBIN"
cat > "$STUBBIN/npx" <<'STUB'
#!/usr/bin/env bash
set -u
if [ "${1-}" != "wrangler" ]; then echo "stub npx: unexpected: $*" >&2; exit 39; fi
shift
cmd="${1-}"; shift || true
case "$cmd" in
  whoami)
    [ "${STUB_WHOAMI_FAIL-0}" = 1 ] && exit 1
    printf 'Getting User settings...\n'
    printf 'You are logged in with an OAuth Token, associated with the email %s.\n' "$STUB_EMAIL"
    ;;
  deployments)
    [ "${STUB_LIST_FAIL-0}" = 1 ] && { echo "stub: APIError" >&2; exit 1; }
    cat "$STUB_DEPLOYMENTS_JSON"
    ;;
  deploy)
    printf '%s\n' "$@" > "$STUB_DEPLOY_LOG"
    echo "stub: Deployed api-qa"
    ;;
  *)
    echo "stub npx: unexpected wrangler cmd: $cmd $*" >&2; exit 39
    ;;
esac
STUB
chmod +x "$STUBBIN/npx"

# write_deployments <latest-author>  — newest entry FIRST, to prove deploy.sh
# picks latest by created_on rather than by array position.
write_deployments() {
  cat > "$STUB_DEPLOYMENTS_JSON" <<JSON
[
  {
    "id": "b2", "source": "wrangler", "strategy": "percentage",
    "author_email": "$1",
    "annotations": { "workers/triggered_by": "deployment" },
    "versions": [{ "version_id": "v2", "percentage": 100 }],
    "created_on": "2026-08-01T13:34:50.495634Z"
  },
  {
    "id": "a1", "source": "wrangler", "strategy": "percentage",
    "author_email": "me@example.com",
    "annotations": {},
    "versions": [{ "version_id": "v1", "percentage": 100 }],
    "created_on": "2026-07-25T22:07:46.591000Z"
  }
]
JSON
}

# ---------------------------------------------------------------------------
# Sandbox: bare origin + clone with deploy.sh copied in (uncommitted).
make_sandbox() {
  SANDBOX="$WORK/sandbox-$1"
  ORIGIN="$SANDBOX/origin.git"
  CLONE="$SANDBOX/clone"
  mkdir -p "$SANDBOX"
  git init -q --bare "$ORIGIN"
  git -C "$ORIGIN" symbolic-ref HEAD refs/heads/main
  git init -q "$CLONE"
  git -C "$CLONE" symbolic-ref HEAD refs/heads/main
  git -C "$CLONE" config user.email dev@example.com
  git -C "$CLONE" config user.name "Deploy Test"
  git -C "$CLONE" remote add origin "$ORIGIN"
  echo "export default {}" > "$CLONE/worker.js"
  git -C "$CLONE" add worker.js
  git -C "$CLONE" commit -qm "initial"
  git -C "$CLONE" push -q -u origin main 2>/dev/null
  mkdir -p "$CLONE/scripts"
  cp "$DEPLOY_SH" "$CLONE/scripts/deploy.sh"

  STUB_DEPLOY_LOG="$SANDBOX/deploy.log"
  STUB_DEPLOYMENTS_JSON="$SANDBOX/deployments.json"
  : > "$STUB_DEPLOY_LOG"
  write_deployments "me@example.com"
}

# other_clone — second checkout to push commits "someone else" made.
other_clone() {
  OTHER="$SANDBOX/other"
  git clone -q "$ORIGIN" "$OTHER"
  git -C "$OTHER" config user.email other@example.com
  git -C "$OTHER" config user.name "Other Dev"
}

# run_deploy [env overrides...] — runs deploy.sh in the clone, stdin closed
# (non-TTY), capturing combined output in $OUT and exit code in $CODE.
run_deploy() {
  OUT="$SANDBOX/out.txt"
  set +e
  (
    cd "$CLONE" &&
    env PATH="$STUBBIN:$PATH" \
      STUB_EMAIL="${STUB_EMAIL:-me@example.com}" \
      STUB_DEPLOY_LOG="$STUB_DEPLOY_LOG" \
      STUB_DEPLOYMENTS_JSON="$STUB_DEPLOYMENTS_JSON" \
      "$@" \
      bash scripts/deploy.sh
  ) > "$OUT" 2>&1 < /dev/null
  CODE=$?
  set -e
}

# ---------------------------------------------------------------------------
echo "1. refuses to deploy from a non-main branch"
make_sandbox 1
git -C "$CLONE" checkout -qb content/stale-branch
run_deploy
assert_exit_nonzero "$CODE" "exits nonzero"
assert_contains "$OUT" "main" "explains the main-only rule"
assert_no_deploy "does not deploy"

echo "2. refuses to deploy from a detached HEAD"
make_sandbox 2
git -C "$CLONE" checkout -q --detach
run_deploy
assert_exit_nonzero "$CODE" "exits nonzero"
assert_no_deploy "does not deploy"

echo "3. refuses when main is behind origin/main"
make_sandbox 3
other_clone
echo "newer" > "$OTHER/newer.txt"
git -C "$OTHER" add newer.txt && git -C "$OTHER" commit -qm "newer on origin" && git -C "$OTHER" push -q
run_deploy
assert_exit_nonzero "$CODE" "exits nonzero"
assert_contains "$OUT" "pull" "tells the deployer to pull"
assert_no_deploy "does not deploy"

echo "4. refuses when main has unpushed commits (ahead of origin/main)"
make_sandbox 4
echo "local" > "$CLONE/local.txt"
git -C "$CLONE" add local.txt && git -C "$CLONE" commit -qm "unpushed"
run_deploy
assert_exit_nonzero "$CODE" "exits nonzero"
assert_contains "$OUT" "push" "tells the deployer to push"
assert_no_deploy "does not deploy"

echo "5. refuses when tracked files have uncommitted changes"
make_sandbox 5
echo "dirty" >> "$CLONE/worker.js"
run_deploy
assert_exit_nonzero "$CODE" "exits nonzero"
assert_no_deploy "does not deploy"

echo "6. deploys when on fresh, clean main and the last deploy was ours"
make_sandbox 6
echo "scratch" > "$CLONE/untracked-scratch.txt"   # untracked files must NOT block
run_deploy
assert_exit_zero "$CODE" "exits zero"
assert_deployed "invokes wrangler deploy"
SHORT_SHA=$(git -C "$CLONE" rev-parse --short HEAD)
assert_contains "$STUB_DEPLOY_LOG" "--message" "passes --message"
assert_contains "$STUB_DEPLOY_LOG" "$SHORT_SHA main" "message is '<short-sha> <branch>'"

echo "7. warns and refuses (non-TTY) when the latest deploy is by someone else"
make_sandbox 7
write_deployments "other@example.com"
run_deploy
assert_exit_nonzero "$CODE" "exits nonzero"
assert_contains "$OUT" "other@example.com" "warning names the other deployer"
assert_no_deploy "does not deploy"

echo "8. DEPLOY_YES=1 acknowledges the other-author warning and deploys"
make_sandbox 8
write_deployments "other@example.com"
run_deploy DEPLOY_YES=1
assert_exit_zero "$CODE" "exits zero"
assert_contains "$OUT" "other@example.com" "still shows the warning"
assert_deployed "invokes wrangler deploy"

echo "9. refuses (non-TTY) when deployment history cannot be checked"
make_sandbox 9
run_deploy STUB_LIST_FAIL=1
assert_exit_nonzero "$CODE" "exits nonzero"
assert_no_deploy "does not deploy"

echo "10. DEPLOY_YES=1 never bypasses the git guards"
make_sandbox 10
git -C "$CLONE" checkout -qb content/stale-branch
run_deploy DEPLOY_YES=1
assert_exit_nonzero "$CODE" "exits nonzero"
assert_no_deploy "does not deploy"

# ---------------------------------------------------------------------------
echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
