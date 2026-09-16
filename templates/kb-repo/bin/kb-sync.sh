#!/usr/bin/env bash
# kb-sync.sh - bring this copy of the knowledge base up to date.
#
#   kb-sync.sh [--branch main]
#
# The last mile of the loop. A change is proposed, someone merges it, and until
# somebody pulls, the person who wrote it is still searching their own stale
# copy -- and so is every session on that machine. On a shared host the launcher
# fast-forwards at every start; on a workstation nothing does, which is where
# this is for.
#
# Refuses to touch uncommitted work, says what arrived, and clears away a
# branch whose change is already merged, because a knowledge base clone left on
# a merged branch is how the next article gets written on top of the last one.
set -uo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/_kb-common.sh"

IFS=$'\n' read -r -d '' -a KB_ARGV < <(kb_normalize_args "$@" && printf '\0')
set -- "${KB_ARGV[@]}"

branch=""
while [ $# -gt 0 ]; do
	case "$1" in
		--branch) branch="${2:-}"; shift 2 ;;
		-h|--help) sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'; exit 0 ;;
		*) kb_die "unknown argument: $1" ;;
	esac
done

root="$(kb_root)"
git -C "$root" rev-parse --git-dir >/dev/null 2>&1 || kb_die "$root is not a git repository"
git -C "$root" remote get-url origin >/dev/null 2>&1 || {
	printf 'No remote configured, so there is nothing to sync from.\n'
	exit 0
}

if [ -n "$branch" ]; then
	default_branch="$branch"
else
	default_branch="$(git -C "$root" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##')"
	[ -n "$default_branch" ] || default_branch="main"
fi

if [ -n "$(git -C "$root" status --porcelain -- articles 2>/dev/null)" ]; then
	printf 'You have uncommitted changes under articles/. Propose them first:\n'
	printf '  bin/kb-propose.sh --message "<what changed and why>"\n'
	exit 3
fi

current="$(git -C "$root" rev-parse --abbrev-ref HEAD 2>/dev/null)"
before="$(git -C "$root" rev-parse "$default_branch" 2>/dev/null || echo "")"

timeout 60 git -C "$root" fetch --quiet --prune origin "$default_branch" 2>/dev/null \
	|| kb_die "could not reach the remote. Check the network, then try again."

if [ "$current" != "$default_branch" ]; then
	git -C "$root" checkout --quiet "$default_branch" 2>/dev/null \
		|| kb_die "could not switch to $default_branch (finish what is on $current first)"
fi
git -C "$root" merge --ff-only --quiet "origin/$default_branch" 2>/dev/null \
	|| kb_die "$default_branch could not fast-forward. Someone has rewritten history, or this copy has local commits."

after="$(git -C "$root" rev-parse "$default_branch" 2>/dev/null || echo "")"

if [ -n "$before" ] && [ "$before" = "$after" ]; then
	printf 'Already up to date.\n'
else
	arrived="$(git -C "$root" log --no-merges --format='%s' "${before:+$before..}$after" -- articles 2>/dev/null | head -n 10)"
	if [ -n "$arrived" ]; then
		printf 'Up to date. New since your last sync:\n'
		printf '%s\n' "$arrived" | sed 's/^/  - /'
	else
		printf 'Up to date.\n'
	fi
fi

# A branch whose change is already on the default branch is finished. Leaving it
# behind is how the next article ends up written on top of the last one.
if [ "$current" != "$default_branch" ]; then
	case "$current" in
		kb/*)
			if git -C "$root" branch --merged "$default_branch" 2>/dev/null | grep -qx "[* ]*$current"; then
				git -C "$root" branch -q -d "$current" 2>/dev/null \
					&& printf 'Cleared the merged branch %s.\n' "$current"
			else
				printf 'Left %s alone: it is not merged yet.\n' "$current"
			fi
			;;
		*) printf 'Switched from %s to %s.\n' "$current" "$default_branch" ;;
	esac
fi
