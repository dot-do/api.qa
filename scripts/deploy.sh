#!/usr/bin/env bash
# Deploy api.qa to Cloudflare Workers — with guardrails.
#
# Why this wrapper exists (the 2026-08-01 incident): Workers deploys are
# whole-bundle and last-write-wins. A `wrangler deploy` from the stale
# `content/agent-first-storybrand` branch silently replaced main's deployed
# UI redesign, because nothing forced deploys to come from fresh main and
# every deployment had an empty Message (no provenance). This script:
#   - refuses to deploy unless HEAD is main, in sync with origin/main, with
#     no uncommitted changes to tracked files (wrangler bundles the working
#     tree, not HEAD);
#   - warns when the latest Cloudflare deployment was made by someone else
#     (they may have shipped work this checkout has never seen) and asks
#     before overwriting it;
#   - stamps every deployment with --message "<short-sha> <branch>" so
#     `npx wrangler deployments list` history is attributable.
#
# Usage:            bash scripts/deploy.sh
# Non-interactive:  DEPLOY_YES=1 acknowledges the provenance warning only —
#                   the git guards can never be bypassed.
# Preferred path:   .github/workflows/deploy.yml (deploy-on-main from CI).
# Tests:            bash scripts/test-deploy.sh
set -euo pipefail

cd "$(dirname "$0")/.."

fail() { echo "ERROR: $*" >&2; exit 1; }

echo "== api-qa deploy preflight =="

# 1. Branch: only main deploys. (The Aug 1 clobber came from a stale branch.)
BRANCH=$(git branch --show-current)
if [ "$BRANCH" != "main" ]; then
  fail "deploys only run from main (currently: ${BRANCH:-detached HEAD}). Switch to main first."
fi

# 2. Clean tree: wrangler bundles the WORKING TREE, not HEAD, so the deploy
#    message "<sha> main" is only honest when tracked files match HEAD.
DIRTY=$(git status --porcelain --untracked-files=no)
if [ -n "$DIRTY" ]; then
  fail "uncommitted changes to tracked files — commit or stash first:
$DIRTY"
fi

# 3. Freshness: HEAD must BE origin/main. Behind risks clobbering newer work;
#    ahead would deploy commits nobody else can see yet.
git fetch --quiet origin main || fail "could not fetch origin/main to verify freshness — check network/remote."
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
  if git merge-base --is-ancestor HEAD origin/main; then
    fail "main is behind origin/main — pull first (git pull --ff-only origin main)."
  elif git merge-base --is-ancestor origin/main HEAD; then
    fail "main has unpushed commits — push first so the deploy message references a commit everyone can see."
  else
    fail "main has diverged from origin/main — reconcile (merge, don't clobber) before deploying."
  fi
fi

# 4. Provenance: if the latest deployment was made by someone else, they may
#    have shipped work this checkout has never seen — deploying replaces the
#    whole bundle. Show it and ask before continuing.
ME=$(npx wrangler whoami 2>/dev/null | grep -oE '[[:alnum:]._%+-]+@[[:alnum:].-]+\.[[:alpha:]]+' | head -n1 || true)
LATEST=$(npx wrangler deployments list --json 2>/dev/null | node -e '
  let s = "";
  process.stdin.on("data", (c) => (s += c)).on("end", () => {
    const list = JSON.parse(s);
    if (!Array.isArray(list) || list.length === 0) process.exit(3);
    const last = list
      .slice()
      .sort((a, b) => String(a.created_on).localeCompare(String(b.created_on)))
      .pop();
    console.log(last.author_email || "unknown");
    console.log(last.created_on || "unknown");
    console.log((last.annotations || {})["workers/message"] || "-");
  });
' 2>/dev/null || true)

# confirm_or_die <non-interactive reason> — the only prompt in this script,
# and DEPLOY_YES only ever answers THIS prompt (never the git guards above).
confirm_or_die() {
  if [ "${DEPLOY_YES-}" = "1" ]; then
    echo "DEPLOY_YES=1 — warning acknowledged, proceeding."
  elif [ -t 0 ]; then
    printf 'Deploy anyway? [y/N] '
    read -r REPLY || REPLY=""
    case "$REPLY" in
      y | Y | yes | YES) ;;
      *) fail "aborted by deployer." ;;
    esac
  else
    fail "$1 Re-run in a terminal to confirm, or set DEPLOY_YES=1 to acknowledge the warning."
  fi
}

if [ -z "$LATEST" ]; then
  echo "WARNING: could not read deployment history (npx wrangler deployments list failed)," >&2
  echo "         so nobody-deployed-over-you cannot be verified." >&2
  confirm_or_die "deployment history is unavailable and this is not a terminal."
else
  LAST_AUTHOR=$(printf '%s\n' "$LATEST" | sed -n 1p)
  LAST_CREATED=$(printf '%s\n' "$LATEST" | sed -n 2p)
  LAST_MESSAGE=$(printf '%s\n' "$LATEST" | sed -n 3p)
  echo "latest deployment: $LAST_CREATED by $LAST_AUTHOR (message: $LAST_MESSAGE)"
  if [ -n "$ME" ] && [ "$LAST_AUTHOR" = "$ME" ]; then
    echo "latest deployment is yours ($ME)."
  else
    echo "WARNING: the latest deployment was made by $LAST_AUTHOR, not you (${ME:-identity unknown})." >&2
    echo "         If their work is not in origin/main yet, deploying now will silently" >&2
    echo "         replace it — whole-bundle, last-write-wins (see 2026-08-01 incident)." >&2
    echo "         Check with them before continuing." >&2
    confirm_or_die "the latest deployment is by $LAST_AUTHOR and this is not a terminal."
  fi
fi

# 5. Deploy, stamped so Cloudflare history says exactly what shipped.
MESSAGE="$(git rev-parse --short HEAD) $(git branch --show-current)"
echo "== deploying api-qa (--message \"$MESSAGE\") =="
npx wrangler deploy --message "$MESSAGE"

echo "== deployed: $MESSAGE (${ME:-author unknown}) =="
