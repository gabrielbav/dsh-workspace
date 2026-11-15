#!/usr/bin/env bash
# Sync the fork with upstream using the "topic branches + integration branch" model (see ../CLAUDE.md):
#   master       fast-forwarded to upstream/master (never committed to)
#   feat/*       each rebased onto BASE, then pushed with --force-with-lease
#   local/daily  recreated as BASE + every feat/* branch cherry-picked on top
#
# This script lives outside the fork on purpose: it must never add files to the fork.
#
# Environment:
#   BASE=<ref>   what feat/* and local/daily sit on (default upstream/master; e.g. BASE=dsh-v0.2.2 for a release tag)
#   PUSH=0       skip pushing master and feat/* to origin
#
# On a conflict the script stops and leaves the rebase or cherry-pick in progress. Resolve it, run
# `git rebase --continue` (or `git cherry-pick --continue`), then rerun this script. rerere remembers
# the resolution, so the same conflict resolves itself next time.
set -euo pipefail
# Pushes skip the fork's pre-push hook: it typechecks the checked-out tree, not the rebased branch being pushed.

FORK="$(cd "$(dirname "$0")/deepseek-harness" && pwd)"
BASE="${BASE:-upstream/master}"
PUSH="${PUSH:-1}"
INTEGRATION="local/daily"

say() { printf '\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

cd "$FORK"

[ -z "$(git status --porcelain --untracked-files=no)" ] || die "uncommitted changes in $FORK; commit or discard them first"
[ ! -d "$(git rev-parse --git-dir)/rebase-merge" ] && [ ! -d "$(git rev-parse --git-dir)/rebase-apply" ] \
  || die "a rebase is in progress; finish it with 'git rebase --continue' or '--abort'"
git rev-parse -q --verify CHERRY_PICK_HEAD >/dev/null && die "a cherry-pick is in progress; finish it with 'git cherry-pick --continue' or '--abort'"

# A fresh `make bootstrap` clone only has origin (the fork).
git remote get-url upstream >/dev/null 2>&1 || { say "Adding upstream remote"; git remote add upstream https://github.com/deepseek-ai/deepseek-harness.git; }

git config rerere.enabled true
git config rerere.autoupdate true

say "Fetching upstream and origin"
git fetch --prune --tags upstream
git fetch --prune origin

# Every hook PR must come from a feat/* branch, or it silently stays out of the integration branch.
origin_repo="$(git remote get-url origin | sed -E 's#^(https://github\.com/|git@github\.com:)##; s#\.git$##')"
# Push and query GitHub as the fork's owner for this run only; the active gh account may be another one.
owner="${origin_repo%%/*}"
if token="$(gh auth token --user "$owner" 2>/dev/null)"; then export GH_TOKEN="$token"
elif [ "$PUSH" = 1 ]; then printf '\033[33mwarning:\033[0m gh has no login for %s; pushing with the active gh account (contributors: PUSH=0)\n' "$owner" >&2; fi

say "Checking open PRs on $origin_repo"
if prs="$(gh pr list -R "$origin_repo" --state open --json number,headRefName --jq '.[] | "#\(.number) \(.headRefName)"' 2>/dev/null)"; then
  stray="$(grep -v ' feat/' <<<"$prs" || true)"
  [ -z "$stray" ] || die "open PR(s) on $origin_repo from branches outside feat/*, so $INTEGRATION would leave them out:
$stray
Move each one to feat/<hook> (see ../CLAUDE.md, fork branch model), then rerun."
else
  printf '\033[33mwarning:\033[0m could not list PRs with gh; skipping the stray-branch check\n' >&2
fi

# A feat/* branch that exists only on origin (pushed from elsewhere) still belongs in the integration branch.
while IFS= read -r remote; do
  branch="${remote#origin/}"
  git rev-parse -q --verify "refs/heads/$branch" >/dev/null || { say "Tracking $branch from origin"; git branch -q --track "$branch" "$remote"; }
done < <(git for-each-ref --format='%(refname:short)' 'refs/remotes/origin/feat/')

say "Fast-forwarding master to upstream/master"
git merge-base --is-ancestor master upstream/master || die "master has commits that are not in upstream/master; it must stay a pure mirror"
if [ "$(git branch --show-current)" = master ]; then git merge --ff-only upstream/master; else git branch -f --no-track master upstream/master; fi
[ "$PUSH" = 1 ] && git push --no-verify origin master

base_commit="$(git rev-parse --verify "$BASE^{commit}")" || die "unknown BASE $BASE"
features=()
while IFS= read -r branch; do features+=("$branch"); done < <(git for-each-ref --format='%(refname:short)' 'refs/heads/feat/')
[ "${#features[@]}" -gt 0 ] || die "no feat/* branches found"

# A branch checked out in another worktree cannot be rebased from here.
checked_out="$(git worktree list --porcelain | sed -n 's|^branch refs/heads/||p')"
for branch in "${features[@]}"; do
  if grep -qx "$branch" <<<"$checked_out" && [ "$(git branch --show-current)" != "$branch" ]; then
    die "$branch is checked out in another worktree; remove it with 'git worktree remove <path>' first"
  fi
done

merged=()
for branch in "${features[@]}"; do
  if git merge-base --is-ancestor "$base_commit" "$branch"; then
    say "$branch already sits on $BASE"
  else
    say "Rebasing $branch onto $BASE"
    git rebase "$base_commit" "$branch" || die "conflict while rebasing $branch; resolve, 'git rebase --continue', then rerun"
  fi
  if [ "$(git rev-parse "$branch")" = "$base_commit" ]; then
    merged+=("$branch")
  elif [ "$PUSH" = 1 ]; then
    git push --no-verify --force-with-lease origin "$branch"
  fi
done

# Keep the existing integration branch (and its commit ids) when it already is BASE + exactly the feat/* patches.
up_to_date=0
if git rev-parse -q --verify "refs/heads/$INTEGRATION" >/dev/null && git merge-base --is-ancestor "$base_commit" "$INTEGRATION"; then
  expected=0; up_to_date=1
  for branch in "${features[@]}"; do
    expected=$((expected + $(git rev-list --count "$base_commit..$branch")))
    git cherry "$INTEGRATION" "$branch" "$base_commit" | grep -q '^+' && up_to_date=0
  done
  [ "$(git rev-list --count "$base_commit..$INTEGRATION")" = "$expected" ] || up_to_date=0
fi

if [ "$up_to_date" = 1 ]; then
  say "$INTEGRATION is already $BASE + every feat/* branch"
  git checkout -q "$INTEGRATION"
else
  say "Recreating $INTEGRATION from $BASE"
  git checkout -q -B "$INTEGRATION" "$base_commit"
  for branch in "${features[@]}"; do
    [ "$(git rev-parse "$branch")" = "$base_commit" ] && continue
    say "Stacking $branch"
    git cherry-pick "$base_commit..$branch" \
      || die "conflict stacking $branch on $INTEGRATION (two hooks overlap); resolve, 'git cherry-pick --continue', then rerun"
  done
fi

say "Done: $INTEGRATION = $BASE + ${#features[@]} feat branch(es)"
git log --oneline "$base_commit..$INTEGRATION"
for branch in ${merged[@]+"${merged[@]}"}; do
  printf '\033[33mnote:\033[0m %s has no commits left on top of %s; upstream likely has it. Delete it and update the plugin.\n' "$branch" "$BASE"
done
echo "Next: make build (reinstall and rebuild the harness), then restart dsh."
