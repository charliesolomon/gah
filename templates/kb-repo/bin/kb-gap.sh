#!/usr/bin/env bash
# kb-gap.sh - record that the knowledge base could not answer something.
#
#   kb-gap.sh --question "which switch serves the gym?" [--tags network]
#
# Creates a stub article with `status: gap`, or -- if that question has been
# asked before -- bumps its `requests` count and the date. The count is the
# point: it turns "our documentation is patchy" into a list ordered by what
# people actually needed while working, which is a better guide to what to
# write next than any documentation plan drawn up in advance.
#
# A gap is an ordinary article, so the next person asking the same question
# finds it in search and learns that the team knows it is missing.
set -uo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/_kb-common.sh"

# Fold -Question/-Tags into --question/--tags before parsing (see _kb-common.sh).
IFS=$'\n' read -r -d '' -a KB_ARGV < <(kb_normalize_args "$@" && printf '\0')
set -- "${KB_ARGV[@]}"

question=""; tags=""
while [ $# -gt 0 ]; do
	case "$1" in
		--question|-q) question="${2:-}"; shift 2 ;;
		--tags) tags="${2:-}"; shift 2 ;;
		-h|--help) sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'; exit 0 ;;
		*) question="$question $1"; shift ;;
	esac
done
question="$(printf '%s' "$question" | sed -e 's/^ *//' -e 's/ *$//')"
usage='Usage: kb-gap.sh --question "<the question nobody could answer>" [--tags a,b]'
[ -n "$question" ] || kb_die "a question is required.
  $usage"
kb_assert_text "$question" "the question" "$usage"

root="$(kb_root)"
slug="$(kb_slug "$question")"
[ -n "$slug" ] || kb_die "that question has no usable words for a file name"
path="articles/gaps/$slug.md"
full="$root/$path"

if [ -f "$full" ]; then
	# Seen before: bump the count in place rather than writing a second stub.
	n="$(kb_field "$full" requests)"
	case "$n" in ''|*[!0-9]*) n=1 ;; esac
	n=$((n + 1))
	tmp="$full.tmp.$$"
	awk -v n="$n" -v today="$(kb_today)" '
		NR == 1 && $0 == "---" { print; fm = 1; next }
		fm && $0 == "---" { if (!seen_req) print "requests: " n; if (!seen_last) print "last_requested: " today; print; fm = 0; next }
		fm && $0 ~ /^requests:/ { print "requests: " n; seen_req = 1; next }
		fm && $0 ~ /^last_requested:/ { print "last_requested: " today; seen_last = 1; next }
		{ print }
	' "$full" >"$tmp" && mv "$tmp" "$full" || { rm -f "$tmp"; kb_die "cannot update $path"; }
	printf '%s\n' "$path"
	printf 'Asked %s times now. That makes it a strong candidate for the next article written.\n' "$n" >&2
	exit 0
fi

tag_list="[]"
if [ -n "$tags" ]; then
	joined=""
	for t in $(printf '%s' "$tags" | tr ',' ' '); do
		t="$(kb_slug "$t")"
		[ -n "$t" ] || continue
		[ -n "$joined" ] && joined="$joined, $t" || joined="$t"
	done
	[ -n "$joined" ] && tag_list="[$joined]"
fi

mkdir -p "$(dirname "$full")" || kb_die "cannot create $(dirname "$path")"
{
	printf -- '---\n'
	printf 'title: %s\n' "$question"
	printf 'description: Nobody has written this down yet.\n'
	printf 'status: gap\n'
	printf 'updated: %s\n' "$(kb_today)"
	printf 'requests: 1\n'
	printf 'last_requested: %s\n' "$(kb_today)"
	printf 'tags: %s\n' "$tag_list"
	printf -- '---\n\n'
	printf '# %s\n\n' "$question"
	printf 'Asked, and not answered by anything in this knowledge base.\n\n'
	printf '## What we would need to write\n\n'
	printf -- '- <the facts that would answer it>\n'
	printf -- '- <where those facts live, or who knows them>\n\n'
	printf 'When someone answers this, replace the body with the article, set `status`\n'
	printf 'to `current`, and move the file out of `articles/gaps/` into the area it\n'
	printf 'belongs to. The gap becoming an article is the whole point.\n'
} >"$full" || kb_die "cannot write $path"

printf '%s\n' "$path"
printf 'Gap recorded. It will show up in searches for this subject until someone answers it.\n' >&2
