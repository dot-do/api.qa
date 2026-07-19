#!/usr/bin/env bash
# Publish api.qa to npm with web auth (TouchID / WebAuthn).
#
# Mirrors the primitives.org.ai publish pattern (scripts/publish.ts there):
#   - preflight: login check, name-collision check, build, test, pack summary
#   - publish with --auth-type=web so npm opens the browser for the human gate
#   - non-TTY callers (agents, CI) get an `expect` PTY wrapper so npm's
#     "Press ENTER to open in the browser" prompt is auto-answered; the human
#     still authorizes in the browser.
set -euo pipefail

cd "$(dirname "$0")/.."

NAME=$(node -p "require('./package.json').name")
VERSION=$(node -p "require('./package.json').version")

echo "== api.qa publish preflight =="

# 1. Auth: make sure we're logged in before doing any work.
if WHOAMI=$(npm whoami 2>/dev/null); then
  echo "npm logged in as: $WHOAMI"
else
  echo "npm not logged in — opening browser for web auth..."
  npm login --auth-type=web --registry=https://registry.npmjs.org/
fi

# 2. Name check: bail early if this exact version is already published.
if npm view "$NAME@$VERSION" version >/dev/null 2>&1; then
  echo "ERROR: $NAME@$VERSION is already published." >&2
  exit 1
fi
if npm view "$NAME" version >/dev/null 2>&1; then
  echo "note: $NAME exists on the registry (publishing a new version)."
else
  echo "note: $NAME is unclaimed on the registry (first publish)."
  # Similarity risk: npm rejects new names that differ from an existing
  # package only by punctuation (that block is what renamed api.qa -> autonomous-qa).
  bare=$(echo "$NAME" | tr -d '.-_')
  for variant in "$bare" "${NAME//-/.}" "${NAME//-/_}"; do
    [ "$variant" = "$NAME" ] && continue
    if npm view "$variant" version >/dev/null 2>&1; then
      echo "WARNING: '$variant' exists — npm may reject '$NAME' as too similar." >&2
    fi
  done
fi

# 3. Build + test.
npm run build
npm test

# 4. Tarball summary — last look before the auth step.
echo
echo "== tarball contents =="
npm pack --dry-run
echo

# 5. Publish with web auth. In a real terminal npm prompts directly; from a
#    non-TTY caller we wrap in `expect` (ships with macOS) to provide a PTY
#    and auto-press Enter on the browser prompt. The browser then opens for
#    TouchID/WebAuthn approval; we wait up to 10 minutes.
PUBLISH_ARGS=(publish --access public --auth-type=web)

if [ -t 0 ] && [ -t 1 ]; then
  echo "== publishing $NAME@$VERSION (interactive) =="
  npm "${PUBLISH_ARGS[@]}"
elif command -v expect >/dev/null 2>&1; then
  echo "== publishing $NAME@$VERSION (non-TTY: expect-wrapped web auth) =="
  expect -c '
    set timeout 600
    log_user 1
    spawn npm publish --access public --auth-type=web
    expect {
      -re {Press .?Enter.? to open in the browser} { send "\r"; exp_continue }
      -re {to open in the browser}                 { send "\r"; exp_continue }
      timeout { puts stderr "*** timed out waiting for web auth ***"; exit 2 }
      eof
    }
    catch wait result
    exit [lindex $result 3]
  '
else
  echo "WARNING: non-TTY and no expect on PATH — npm prompts may fail." >&2
  npm "${PUBLISH_ARGS[@]}"
fi

echo
echo "== verifying publish =="
npm view "$NAME@$VERSION" name version dist.tarball
echo "Published $NAME@$VERSION"
