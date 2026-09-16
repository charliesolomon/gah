#!/usr/bin/env bash
# kb-status.sh - what this knowledge base holds, and what it owes.
#
#   kb-status.sh [--stale-days 180] [--quiet]
#
# Four questions, in the order they matter:
#   what is here, what was asked and never answered (most-asked first),
#   what has not been verified in a long time, and what is malformed.
#
# The gap list is the backlog. It is ordered by how often people actually
# needed the thing, which is the only prioritisation that has ever survived
# contact with a support queue.
set -uo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/_kb-common.sh"

stale_days=180; quiet=0
while [ $# -gt 0 ]; do
	case "$1" in
		--stale-days) stale_days="${2:-180}"; shift 2 ;;
		--quiet|-q) quiet=1; shift ;;
		-h|--help) sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'; exit 0 ;;
		*) kb_die "unknown argument: $1" ;;
	esac
done

root="$(kb_root)"
n_current=0; n_draft=0; n_gap=0; n_other=0
gaps=""; stale=""; problems=""; example_present=0

while IFS= read -r f; do
	[ -n "$f" ] || continue
	rel="${f#$root/}"
	title="$(kb_field "$f" title)"
	status="$(kb_field "$f" status)"
	updated="$(kb_field "$f" updated)"
	desc="$(kb_field "$f" description)"

	[ -z "$title" ] && problems="$problems  $rel: no title\n"
	[ -z "$desc" ] && [ "$status" != "gap" ] && problems="$problems  $rel: no description (search matches on it)\n"
	case "$status" in
		current) n_current=$((n_current + 1)) ;;
		draft) n_draft=$((n_draft + 1)) ;;
		gap) n_gap=$((n_gap + 1)) ;;
		"") n_other=$((n_other + 1)); problems="$problems  $rel: no status\n" ;;
		*) n_other=$((n_other + 1)); problems="$problems  $rel: status '$status' is not current, draft or gap\n" ;;
	esac
	if [ -z "$updated" ]; then
		problems="$problems  $rel: no updated date\n"
	else
		case "$updated" in
			[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;;
			*) problems="$problems  $rel: updated '$updated' is not YYYY-MM-DD\n" ;;
		esac
	fi

	if [ "$status" = "gap" ]; then
		n="$(kb_field "$f" requests)"; case "$n" in ''|*[!0-9]*) n=1 ;; esac
		gaps="$gaps$n	$rel	$title
"
	elif [ -n "$updated" ]; then
		age="$(kb_age_days "$updated")"
		if [ -n "$age" ] && [ "$age" -gt "$stale_days" ] 2>/dev/null; then
			stale="$stale$age	$rel	$title
"
		fi
	fi
	case "$(kb_field "$f" tags)" in *example*) example_present=1 ;; esac
done <<EOF
$(kb_files)
EOF

total=$((n_current + n_draft + n_gap + n_other))
printf 'Knowledge base: %s\n' "$root"
printf '  %s articles — %s current, %s draft, %s recorded gaps\n' "$total" "$n_current" "$n_draft" "$n_gap"

if [ -n "$gaps" ]; then
	printf '\nAsked and unanswered (most-asked first — this is the backlog):\n'
	printf '%s' "$gaps" | LC_ALL=C sort -t'	' -k1,1nr | head -n 15 | while IFS=$'\t' read -r n rel title; do
		printf '  %sx  %s\n      %s\n' "$n" "$title" "$rel"
	done
fi

if [ -n "$stale" ]; then
	printf '\nNot verified in over %s days:\n' "$stale_days"
	printf '%s' "$stale" | LC_ALL=C sort -t'	' -k1,1nr | head -n 15 | while IFS=$'\t' read -r age rel title; do
		printf '  %s days  %s\n           %s\n' "$age" "$title" "$rel"
	done
fi

if [ -n "$problems" ]; then
	printf '\nHeader problems (these articles will not be found or aged correctly):\n'
	printf "$problems"
fi

if [ "$example_present" -eq 1 ] && [ "$quiet" -eq 0 ]; then
	printf '\nThe example article that shipped with the scaffold is still here.\n'
	printf 'Delete it once you have written one of your own — it is invented, and it\n'
	printf 'will otherwise be quoted back to someone as though it were true.\n'
fi

if [ "$total" -eq 0 ]; then
	printf '\nNothing here yet. That is the normal starting state: ask the agent something,\n'
	printf 'let it record the gap, and write that article first.\n'
fi
