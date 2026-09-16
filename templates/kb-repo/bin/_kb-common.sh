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

# An agent that has read the .ps1 twin's usage will type -Question here, and an
# agent that read this one will type --question over there. Both conventions are
# accepted everywhere: a mistyped flag that is silently taken as text produces a
# plausible-looking article, which is worse than an error. Single-dash long
# names are folded to the double-dash form before parsing, case-insensitively.
kb_normalize_args() {
	local a
	for a in "$@"; do
		case "$a" in
			--*) printf '%s\n' "$a" ;;
			-[A-Za-z][A-Za-z]*) printf -- '--%s\n' "$(printf '%s' "${a#-}" | tr '[:upper:]' '[:lower:]')" ;;
			*) printf '%s\n' "$a" ;;
		esac
	done
}

# A title, question or message that begins with a dash is a mistyped flag, not
# text. Refusing beats writing an article called "--title".
kb_assert_text() {
	case "$1" in
		-*) kb_die "$2 looks like a flag, not text: '$1'
  $3" ;;
	esac
}

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

# The branch a change is expected to land on. origin/HEAD when the remote says,
# init.defaultBranch when it does not, main as the last word.
kb_default_branch() {
	local b root
	root="$(kb_root)"
	b="$(git -C "$root" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##')"
	[ -n "$b" ] || b="$(git -C "$root" config init.defaultBranch 2>/dev/null)"
	printf '%s\n' "${b:-main}"
}

# The repository's web address, from the origin remote. Empty when there is no
# remote, which is the ordinary state of a knowledge base for its first hour.
# Handles the ssh forms as well as https, and drops any credentials or port so
# the result is something a person can paste into a browser.
kb_web_base() {
	local remote
	remote="$(git -C "$(kb_root)" remote get-url origin 2>/dev/null)" || return 0
	[ -n "$remote" ] || return 0
	printf '%s' "$remote" | sed \
		-e 's#^ssh://##' \
		-e 's#^git@\([^:/]*\):[0-9][0-9]*/#https://\1/#' \
		-e 's#^git@\([^:/]*\)[:/]#https://\1/#' \
		-e 's#^https\?://[^@/]*@#https://#' \
		-e 's#^\(https\?://[^/]*\):[0-9][0-9]*/#\1/#' \
		-e 's#\.git$##' \
		-e 's#/$##'
}

# A link to one article's page in the forge, so a cited path can be opened
# rather than hunted for. $1 is the path relative to the knowledge base root;
# $2 the ref, defaulting to the branch the article will live on once merged.
#
# The two forges spell it differently and only the host says which is which.
# KB_WEB_STYLE=github|gitlab settles it for anything self-hosted under a name
# that gives nothing away; GitLab's form is the default because a knowledge base
# on a corporate forge is more often there than not.
kb_article_url() {
	local base ref host
	base="$(kb_web_base)"
	[ -n "$base" ] || return 0
	ref="${2:-$(kb_default_branch)}"
	host="$(printf '%s' "$base" | sed -e 's#^https\?://##' -e 's#/.*##')"
	case "${KB_WEB_STYLE:-}" in
		github) printf '%s/blob/%s/%s\n' "$base" "$ref" "$1" ;;
		gitlab) printf '%s/-/blob/%s/%s\n' "$base" "$ref" "$1" ;;
		*)
			case "$host" in
				*github*) printf '%s/blob/%s/%s\n' "$base" "$ref" "$1" ;;
				*) printf '%s/-/blob/%s/%s\n' "$base" "$ref" "$1" ;;
			esac
			;;
	esac
}

# Days between an ISO date and today; empty when the date is unusable.
kb_age_days() {
	local then now
	then=$(date -d "$1" +%s 2>/dev/null) || return 0
	now=$(date +%s)
	printf '%s\n' $(( (now - then) / 86400 ))
}
