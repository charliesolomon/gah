#!/usr/bin/env bash
# kb-search.sh - find articles that bear on a question.
#
#   kb-search.sh "north site wireless" [--tag network] [--status current] [--limit 10]
#
# Prints one block per hit: path, title, status, when it was last verified, and
# the line that matched. Ranked, because the first three results are the only
# ones anyone reads: a word in the title or description outweighs the same word
# in the body, and an article matching every word outweighs one matching some.
#
# Exit 0 with matches, 1 with none (so a caller can branch on "nothing known").
set -uo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/_kb-common.sh"

IFS=$'\n' read -r -d '' -a KB_ARGV < <(kb_normalize_args "$@" && printf '\0')
set -- "${KB_ARGV[@]}"

query=""; want_tag=""; want_status=""; limit=10
while [ $# -gt 0 ]; do
	case "$1" in
		--tag) want_tag="${2:-}"; shift 2 ;;
		--status) want_status="${2:-}"; shift 2 ;;
		--limit) limit="${2:-10}"; shift 2 ;;
		-h|--help) sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'; exit 0 ;;
		--) shift; query="$query $*"; break ;;
		*) query="$query $1"; shift ;;
	esac
done
query="$(printf '%s' "$query" | sed -e 's/^ *//' -e 's/ *$//')"
[ -n "$query" ] || kb_die "nothing to search for. Usage: kb-search.sh \"<question or keywords>\""

# Words worth scoring. Two-letter words and the connectives people type into
# questions match everything and rank nothing.
stop=" the a an and or of for at in on to is are was were how what which who whom where when why do does did with from by our we us it its this that "
words=""
for w in $(printf '%s' "$query" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' ' '); do
	case "$stop" in *" $w "*) continue ;; esac
	[ ${#w} -ge 3 ] || continue
	words="$words $w"
done
[ -n "$words" ] && query_words="$words" || query_words="$(printf '%s' "$query" | tr '[:upper:]' '[:lower:]')"

hits=""
while IFS= read -r f; do
	[ -n "$f" ] || continue
	status="$(kb_field "$f" status)"
	[ -n "$want_status" ] && [ "$status" != "$want_status" ] && continue
	tags="$(kb_field "$f" tags)"
	if [ -n "$want_tag" ]; then
		case " $(printf '%s' "$tags" | tr -d '[]," ' | tr ',' ' ') " in
			*" $want_tag "*) ;;
			*) case " $tags " in *" $want_tag "*) ;; *) continue ;; esac ;;
		esac
	fi
	title="$(kb_field "$f" title)"
	desc="$(kb_field "$f" description)"
	head_text="$(printf '%s %s %s %s' "$title" "$desc" "$tags" "$(basename "$f" .md)" | tr '[:upper:]' '[:lower:]')"
	body_text="$(tr '[:upper:]' '[:lower:]' <"$f")"

	score=0; matched=0; total=0
	for w in $query_words; do
		total=$((total + 1))
		in_head=0; in_body=0
		case "$head_text" in *"$w"*) in_head=1 ;; esac
		case "$body_text" in *"$w"*) in_body=1 ;; esac
		[ $in_head -eq 1 ] && score=$((score + 10))
		[ $in_body -eq 1 ] && score=$((score + 2))
		[ $((in_head + in_body)) -gt 0 ] && matched=$((matched + 1))
	done
	[ $matched -eq 0 ] && continue
	# Every word present beats a partial match on a longer article.
	[ "$matched" -eq "$total" ] && score=$((score + 25))
	# A recorded gap is a real answer to "what do we know" -- surface it, but
	# never above an article that actually answers.
	[ "$status" = "gap" ] && score=$((score - 15))
	hits="$hits$score	$f
"
done <<EOF
$(kb_files)
EOF

[ -n "$hits" ] || { printf 'No article covers that yet.\n'; exit 1; }

printf '%s' "$hits" | LC_ALL=C sort -t'	' -k1,1nr -k2,2 | head -n "$limit" | while IFS=$'\t' read -r score f; do
	[ -n "$f" ] || continue
	rel="${f#$(kb_root)/}"
	status="$(kb_field "$f" status)"
	printf '%s\n' "$rel"
	printf '  title:   %s\n' "$(kb_field "$f" title)"
	printf '  status:  %s   updated: %s' "$status" "$(kb_field "$f" updated)"
	if [ "$status" = "gap" ]; then
		printf '   requests: %s' "$(kb_field "$f" requests)"
	fi
	printf '\n'
	d="$(kb_field "$f" description)"
	[ -n "$d" ] && printf '  %s\n' "$d"
	# The first line of PROSE that mentions a query word, so a reader can judge
	# relevance without opening the file. Frontmatter is skipped: it is already
	# printed above, and every word of a title matches its own article.
	body="$(awk 'NR==1 && $0=="---" { fm=1; next } fm && $0=="---" { fm=0; next } !fm' "$f")"
	for w in $query_words; do
		# Headings are navigation and usually repeat the title; prose is evidence.
		line="$(printf '%s\n' "$body" | grep -i -- "$w" 2>/dev/null | grep -v '^[ \t]*#' \
			| grep -v '^[ \t]*<!--' | head -n1 \
			| sed -e 's/^[ \t>|*-]*//' -e 's/[ \t]*$//' | cut -c1-160)"
		[ -n "$line" ] || continue
		printf '  > %s\n' "$line"
		break
	done
	printf '\n'
done
