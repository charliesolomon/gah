#!/usr/bin/env bash
# kb-new.sh - start an article from the template, with the frontmatter filled in.
#
#   kb-new.sh --title "Wireless at the North site" [--area network] [--tags network,wireless]
#             [--path articles/network/north-wireless.md] [--status draft] [--force]
#
# Prints the path it created. Refuses to overwrite an existing article: an
# accidental clobber of documentation is the one failure this tool must not have
# (--force is there for the deliberate case, and rewrites only the body).
#
# Writing the article itself is the agent's job, or yours. This only guarantees
# that every article starts with a valid header, because a missing `updated` is
# invisible until the staleness report quietly stops mentioning the file.
set -uo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/_kb-common.sh"

IFS=$'\n' read -r -d '' -a KB_ARGV < <(kb_normalize_args "$@" && printf '\0')
set -- "${KB_ARGV[@]}"

title=""; area=""; tags=""; path=""; status="draft"; force=0
while [ $# -gt 0 ]; do
	case "$1" in
		--title) title="${2:-}"; shift 2 ;;
		--area) area="${2:-}"; shift 2 ;;
		--tags) tags="${2:-}"; shift 2 ;;
		--path) path="${2:-}"; shift 2 ;;
		--status) status="${2:-}"; shift 2 ;;
		--force) force=1; shift ;;
		-h|--help) sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'; exit 0 ;;
		*) kb_die "unknown argument: $1" ;;
	esac
done
usage='Usage: kb-new.sh --title "<article title>" [--area <area>] [--tags a,b]'
[ -n "$title" ] || kb_die "a title is required.
  $usage"
kb_assert_text "$title" "the title" "$usage"
case "$status" in current|draft|gap) ;; *) kb_die "--status must be current, draft or gap" ;; esac

root="$(kb_root)"
if [ -z "$path" ]; then
	slug="$(kb_slug "$title")"
	[ -n "$slug" ] || kb_die "the title has no usable words for a file name; pass --path"
	if [ -n "$area" ]; then path="articles/$(kb_slug "$area")/$slug.md"; else path="articles/$slug.md"; fi
fi
case "$path" in
	/*) kb_die "--path must be relative to the knowledge base root" ;;
	articles/*) ;;
	*) path="articles/$path" ;;
esac
case "$path" in *..*) kb_die "--path may not contain .." ;; esac
case "$path" in *.md) ;; *) path="$path.md" ;; esac

full="$root/$path"
if [ -e "$full" ] && [ $force -eq 0 ]; then
	printf 'kb: %s already exists. Edit it, or pass --force to replace the body.\n' "$path" >&2
	exit 3
fi
mkdir -p "$(dirname "$full")" || kb_die "cannot create $(dirname "$path")"

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

# The body comes from templates/article.md with its own frontmatter stripped:
# one template, and the header is written here where the values are known.
tpl="$root/templates/article.md"
if [ -f "$tpl" ]; then
	body="$(awk 'NR==1 && $0=="---" { fm=1; next } fm && $0=="---" { fm=0; next } !fm' "$tpl")"
else
	body="$(printf '\n# %s\n\n<!-- Lead with the answer. -->\n' "$title")"
fi
body="$(printf '%s' "$body" | sed -e "s/<Title>/$(printf '%s' "$title" | sed 's/[&/\]/\\&/g')/g")"

{
	printf -- '---\n'
	printf 'title: %s\n' "$title"
	printf 'description: \n'
	printf 'status: %s\n' "$status"
	printf 'updated: %s\n' "$(kb_today)"
	printf 'tags: %s\n' "$tag_list"
	printf -- '---\n'
	printf '%s\n' "$body"
} >"$full" || kb_die "cannot write $path"

printf '%s\n' "$path"
printf 'Created. Fill in `description` before proposing it: that one line is what search matches on.\n' >&2
