#!/usr/bin/env bash
# Shared helpers for the kb-* scripts. Sourced, never run directly.
#
# The knowledge base root is found from this script's own location (bin/ lives
# at the root), so nothing needs configuring: a clone works wherever it sits.
# KB_DIR (or GAH_KB_DIR) overrides, for the case where the scripts are copied
# elsewhere.

kb_root() {
	if [ -n "${KB_DIR:-}" ]; then printf '%s\n' "${KB_DIR%/}"; return; fi
	if [ -n "${GAH_KB_DIR:-}" ]; then printf '%s\n' "${GAH_KB_DIR%/}"; return; fi
	( cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd )
}

kb_articles() { printf '%s/articles\n' "$(kb_root)"; }

kb_die() { printf 'kb: %s\n' "$*" >&2; exit 2; }

# A file name (and gap identity) from a title or question: lowercase, words
# joined by hyphens, nothing else, capped so a long question stays a usable name.
kb_slug() {
	printf '%s' "$1" \
		| tr '[:upper:]' '[:lower:]' \
		| sed -e 's/[^a-z0-9]\+/-/g' -e 's/^-\+//' -e 's/-\+$//' \
		| cut -c1-60 \
		| sed -e 's/-\+$//'
}

kb_today() { date +%Y-%m-%d; }

# One frontmatter field of one article. Values may be quoted or bare; lists are
# returned as written. Empty when absent -- callers decide whether that matters.
kb_field() {
	awk -v key="$2" '
		NR == 1 && $0 != "---" { exit }
		NR > 1 && $0 == "---" { exit }
		NR > 1 {
			line = $0
			pos = index(line, ":")
			if (pos == 0) next
			k = substr(line, 1, pos - 1)
			gsub(/^[ \t]+|[ \t]+$/, "", k)
			if (k != key) next
			v = substr(line, pos + 1)
			gsub(/^[ \t]+|[ \t]+$/, "", v)
			gsub(/^"|"$/, "", v)
			gsub(/^'\''|'\''$/, "", v)
			print v
			exit
		}
	' "$1" 2>/dev/null
}

# Every article, one path per line, deterministic order.
kb_files() {
	local dir
	dir="$(kb_articles)"
	[ -d "$dir" ] || return 0
	find "$dir" -type f -name '*.md' ! -name 'README.md' 2>/dev/null | LC_ALL=C sort
}

# Days between an ISO date and today; empty when the date is unusable.
kb_age_days() {
	local then now
	then=$(date -d "$1" +%s 2>/dev/null) || return 0
	now=$(date +%s)
	printf '%s\n' $(( (now - then) / 86400 ))
}
