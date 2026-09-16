#!/usr/bin/env bash
# kb-propose.sh - put a knowledge base change in front of the team.
#
#   kb-propose.sh --message "Document the gym switch" [--branch kb/gym-switch] [--direct]
#
# Default is to PROPOSE: commit on a branch, push it, and hand back the URL that
# opens the pull or merge request. Nothing reaches main without a person.
#
# KB_PUBLISH=direct (or --direct) commits to the default branch and pushes
# instead. That is a real choice some teams make once their review step has
# become a rubber stamp: git history is then the audit trail and `git revert`
# the rollback. Decide it deliberately rather than drifting into it.
#
# Only `articles/` is staged. Changes to the scripts or the skills are changes
# to the tooling and deserve their own review, not a ride along with an article.
#
# The commit is made with whatever git identity the person running the session
# has, so a change is attributable to them and not to a shared robot account.
set -uo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/_kb-common.sh"

message=""; branch=""; direct=0
[ "${KB_PUBLISH:-}" = "direct" ] && direct=1
while [ $# -gt 0 ]; do
	case "$1" in
		--message|-m) message="${2:-}"; shift 2 ;;
		--branch|-b) branch="${2:-}"; shift 2 ;;
		--direct) direct=1; shift ;;
		--propose) direct=0; shift ;;
		-h|--help) sed -n '2,18p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'; exit 0 ;;
		*) kb_die "unknown argument: $1" ;;
	esac
done
[ -n "$message" ] || kb_die "--message is required: say what changed and why, in one line"

root="$(kb_root)"
git -C "$root" rev-parse --git-dir >/dev/null 2>&1 || kb_die "$root is not a git repository. Run: git -C $root init"

if [ -z "$(git -C "$root" config user.email 2>/dev/null)" ] || [ -z "$(git -C "$root" config user.name 2>/dev/null)" ]; then
	kb_die "git identity is not set, so this change could not be attributed to you.
  git -C $root config user.name  \"Your Name\"
  git -C $root config user.email \"you@example.com\""
fi

git -C "$root" add -A -- articles >/dev/null 2>&1 || kb_die "could not stage articles/"
if git -C "$root" diff --cached --quiet -- articles; then
	printf 'Nothing to propose: no changes under articles/.\n'
	exit 1
fi

printf 'Staged:\n'
git -C "$root" diff --cached --name-status -- articles | sed 's/^/  /'

default_branch="$(git -C "$root" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##')"
[ -n "$default_branch" ] || default_branch="$(git -C "$root" config init.defaultBranch 2>/dev/null)"
[ -n "$default_branch" ] || default_branch="main"

if [ "$direct" -eq 1 ]; then
	git -C "$root" commit -q -m "$message" || kb_die "commit failed"
	printf '\nCommitted to %s.\n' "$(git -C "$root" rev-parse --abbrev-ref HEAD)"
	if git -C "$root" remote get-url origin >/dev/null 2>&1; then
		if push_out="$(git -C "$root" push origin HEAD 2>&1)"; then
			printf 'Pushed. The team has it.\n'
		else
			printf '%s\n' "$push_out" | sed 's/^/  /'
			printf 'Committed locally but NOT pushed — resolve the above and push.\n'
			exit 4
		fi
	else
		printf 'No remote configured, so this is committed locally only.\n'
	fi
	exit 0
fi

if [ -z "$branch" ]; then
	branch="kb/$(kb_slug "$message")"
	[ "$branch" = "kb/" ] && branch="kb/update-$(date +%Y%m%d-%H%M%S)"
fi
current="$(git -C "$root" rev-parse --abbrev-ref HEAD 2>/dev/null)"
if [ "$current" != "$branch" ]; then
	# A staged change survives the switch, so the article can be written before
	# anyone thinks about branches -- which is the order people actually work in.
	git -C "$root" checkout -q -b "$branch" 2>/dev/null || git -C "$root" checkout -q "$branch" || kb_die "could not switch to $branch"
fi
git -C "$root" commit -q -m "$message" || kb_die "commit failed"
printf '\nCommitted on %s.\n' "$branch"

git -C "$root" remote get-url origin >/dev/null 2>&1 || {
	printf 'No remote configured, so there is nothing to open a request against yet.\n'
	exit 0
}
if ! push_out="$(git -C "$root" push -u origin "$branch" 2>&1)"; then
	printf '%s\n' "$push_out" | sed 's/^/  /'
	printf 'Committed on %s but NOT pushed — resolve the above and push.\n' "$branch"
	exit 4
fi
# GitLab prints the merge-request URL in the push output; GitHub prints a
# compare link. Show it verbatim rather than guessing.
printf '%s\n' "$push_out" | grep -iE 'https?://' | sed 's/^[[:space:]]*remote:[[:space:]]*//' | sed 's/^/  /'

remote="$(git -C "$root" remote get-url origin 2>/dev/null)"
web="$(printf '%s' "$remote" | sed -e 's#^git@\([^:]*\):#https://\1/#' -e 's#\.git$##')"
case "$web" in
	https://github.com/*) printf '  Open the pull request: %s/compare/%s...%s?expand=1\n' "$web" "$default_branch" "$branch" ;;
	https://gitlab.*|*/gitlab/*) printf '  (the merge-request link above comes from GitLab)\n' ;;
esac
printf 'Proposed. Someone reviews it, and every later question is answered from the better version.\n'
