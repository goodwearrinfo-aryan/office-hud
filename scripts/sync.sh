#!/bin/zsh
# Keep the office-hud repository in step with origin/main.
#
# WHY THIS EXISTS
# office-hud is a nested repo (github.com/goodwearrinfo-aryan/office-hud) with its
# own remote, and it had NO sync job. bin/agent-autocommit.sh snapshots untracked
# work every 30 minutes but deliberately never pushes (see its own comment), and
# scripts/github_sync.sh in the fleet repo points at the SUPERREPO, not at this
# one. So commits accumulated locally and `main` drifted away from origin with
# nobody noticing, which is exactly the failure that makes two agents' work
# invisible to each other.
#
# It is deliberately NOT the fleet's scripts/github_sync.sh. That script requires
# a `public` remote (office-hud has only `origin`) and refuses to push a branch
# that is currently checked out — a guard that is right for the mini's deployment
# clone and wrong for a dev surface where `main` is always checked out.
#
# SAFETY PROPERTIES
#   - fast-forward ONLY. Divergence is reported, never resolved by force.
#   - never force-push, never move a branch backwards, never touch a tag
#   - never touches the working tree, the index, or HEAD — refs only
#   - refuses to run mid-rebase/merge, and takes a lock so two passes cannot race
#   - divergence exits non-zero and says so, because a sync job that fails
#     silently is how 599 unpushed commits went unnoticed once already
#
# Usage: scripts/sync.sh [--check]
#   --check  report what would happen, push nothing
set -euo pipefail

REPO="${OFFICE_HUD_REPO:-$(cd "$(dirname "$0")/.." && pwd)}"
REMOTE="${OFFICE_HUD_REMOTE:-origin}"
BRANCH="${OFFICE_HUD_BRANCH:-main}"
STATUS_ROOT="${STATUS_ROOT:-$HOME/.local/state}"
CHECK_ONLY=0
[[ "${1:-}" == "--check" ]] && CHECK_ONLY=1

info() { print -- "office-hud sync: $1"; }
fail() { print -u2 -- "office-hud sync failed: $1"; exit 1; }

mkdir -p "$STATUS_ROOT"
STATUS_FILE="$STATUS_ROOT/office-hud-sync.status"
STAMP="$(date '+%F %T')"

cd "$REPO"
git rev-parse --git-dir >/dev/null 2>&1 || fail "$REPO is not a git repository"
git remote get-url -- "$REMOTE" >/dev/null 2>&1 || fail "$REMOTE is not a configured remote"

# Never commit or fetch underneath an operation another agent is running.
for busy in index.lock rebase-merge rebase-apply MERGE_HEAD CHERRY_PICK_HEAD; do
  [[ -e ".git/$busy" ]] && fail "git operation in progress ($busy); refusing to touch refs"
done

# One instance at a time.
LOCK="$STATUS_ROOT/office-hud-sync.lock"
mkdir "$LOCK" 2>/dev/null || { info "another pass is running; skipping"; exit 0; }
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

# Read the remote tip into a scratch ref. Never HEAD, never the checked-out branch:
# moving a branch a worktree has checked out would leave that worktree's files
# describing a commit it no longer has.
SCRATCH="refs/sync/office-hud-$BRANCH"
git fetch --no-tags --quiet "$REMOTE" "+refs/heads/$BRANCH:$SCRATCH" \
  || fail "unable to fetch $REMOTE/$BRANCH"
REMOTE_TIP="$(git rev-parse --verify "${SCRATCH}^{commit}")"

LOCAL_TIP="$(git rev-parse --verify "refs/heads/$BRANCH^{commit}" 2>/dev/null || print '')"

result=same
detail="already in step"

if [[ -z "$LOCAL_TIP" ]]; then
  result=absent
  detail="no local $BRANCH branch"
elif [[ "$LOCAL_TIP" == "$REMOTE_TIP" ]]; then
  info "$BRANCH is in step at ${REMOTE_TIP:0:7}"
elif git merge-base --is-ancestor "$REMOTE_TIP" "$LOCAL_TIP"; then
  ahead="$(git rev-list --count "$REMOTE_TIP..$LOCAL_TIP")"
  if [[ $CHECK_ONLY -eq 1 ]]; then
    result=would-push
    detail="local is ahead by $ahead commit(s); check only, nothing pushed"
    info "$detail"
  else
    # The only write path in this script. Fast-forward, never forced.
    git push "$REMOTE" "refs/heads/$BRANCH:refs/heads/$BRANCH" 2>&1 | while IFS= read -r l; do info "$l"; done
    result=pushed
    detail="pushed $ahead commit(s) fast-forward"
    info "pushed $ahead commit(s); remote was ${REMOTE_TIP:0:7}"
  fi
elif git merge-base --is-ancestor "$LOCAL_TIP" "$REMOTE_TIP"; then
  behind="$(git rev-list --count "$LOCAL_TIP..$REMOTE_TIP")"
  result=behind
  detail="origin is ahead by $behind commit(s); fast-forward the local branch"
  info "$detail"
else
  # Diverged. A force push would silently discard one side, so refuse and say so.
  only_local="$(git rev-list --count "$REMOTE_TIP..$LOCAL_TIP")"
  only_remote="$(git rev-list --count "$LOCAL_TIP..$REMOTE_TIP")"
  result=diverged
  detail="diverged: ${only_local} local-only, ${only_remote} remote-only commit(s); needs a human merge (try: git merge origin/$BRANCH)"
  info "$detail"
fi

# Verify against the remote rather than trusting the push's own exit code.
if [[ $CHECK_ONLY -eq 0 && $result == pushed ]]; then
  VERIFIED="$(git ls-remote --exit-code "$REMOTE" "refs/heads/$BRANCH" | cut -f1)" \
    || fail "unable to verify $REMOTE/$BRANCH"
  [[ "$VERIFIED" == "$LOCAL_TIP" ]] || fail "remote is at ${VERIFIED:0:7}, expected ${LOCAL_TIP:0:7}"
  detail="$detail; verified at ${VERIFIED:0:7}"
fi

printf 'status=%s\nchecked_at=%s\nbranch=%s\nremote_tip=%s\nlocal_tip=%s\ndetail=%s\n' \
  "$result" "$STAMP" "$BRANCH" "$REMOTE_TIP" "${LOCAL_TIP:-none}" "$detail" > "$STATUS_FILE"

git update-ref -d "$SCRATCH" 2>/dev/null || true

# Non-zero on anything that needs a human, so a monitoring surface can see it.
case "$result" in
  diverged|behind|absent) exit 1 ;;
  *) exit 0 ;;
esac