#!/usr/bin/env bash
#
# check-vendor-clean.sh — assert the invariant the whole two-layer design rests on:
#
#     vendor/pi  ==  upstream at .sync-state's sha  +  the patch series, and nothing else
#
# Why this exists: between 2026-05-18 and 2026-08-28 the scheduled upstream sync
# failed 15 consecutive times and never once succeeded. The cause was edits
# committed to vendor/pi outside the patch flow (lockfile churn from an older
# npm, a shell-quote CVE bump, a bin rename). The sync workflow restores a
# pristine vendor tree by reverse-applying patches/ — which by construction
# cannot undo a change that no patch describes — so every `git subtree pull`
# hit a merge conflict and stopped.
#
# Nothing detected that. This does: it reverse-applies the patch series to the
# committed vendor tree and diffs the result against the recorded upstream
# commit. Run it in CI so drift fails the build that introduces it, rather than
# a sync three months later.
#
# Usage: scripts/check-vendor-clean.sh [--worktree]
#          (default) check the COMMITTED tree — what CI should assert
#          --worktree check the working tree — use before you commit
# Exit:  0 = clean, 1 = drift found, 2 = cannot check
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

MODE="head"
case "${1:-}" in
	--worktree) MODE="worktree" ;;
	"") ;;
	*) echo "usage: check-vendor-clean.sh [--worktree]" >&2; exit 2 ;;
esac

STATE_FILE="$REPO_ROOT/.sync-state"
SUBTREE_PREFIX="vendor/pi"

[ -f "$STATE_FILE" ] || { echo "check-vendor-clean: no .sync-state — run a sync first" >&2; exit 2; }

REF="$(sed -n 's/^ref=//p' "$STATE_FILE")"
SHA="$(sed -n 's/^sha=//p' "$STATE_FILE")"

if [ -z "$SHA" ] || [ "$SHA" = "unknown" ]; then
	echo "check-vendor-clean: .sync-state has no usable upstream sha" >&2
	exit 2
fi

if ! git cat-file -e "${SHA}^{commit}" 2>/dev/null; then
	echo "check-vendor-clean: upstream commit $SHA is not present locally." >&2
	echo "  Fetch it first:  git fetch pi-upstream --tags" >&2
	exit 2
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
OURS="$TMP/ours"        # our committed vendor tree, patches then reversed
THEIRS="$TMP/upstream"  # pristine upstream at $SHA
mkdir -p "$OURS" "$THEIRS"

# Default to the COMMITTED tree: a dirty local build must not read as drift
# (that is what clean-vendor.sh is for). --worktree checks what you have now.
if [ "$MODE" = "worktree" ]; then
	# Only TRACKED files. Copying the raw directory would sweep in build output
	# that upstream gitignores — packages/ai/src/providers/data (hydrated model
	# catalogs), node_modules, dist — and report it as drift. What we are
	# checking is the content git would carry into a subtree merge.
	( cd "$REPO_ROOT" && git ls-files -z -- "$SUBTREE_PREFIX" | tar -c --null -T - -f - ) \
		| tar -x -C "$OURS" --strip-components=2
else
	git archive HEAD "$SUBTREE_PREFIX" | tar -x -C "$OURS" --strip-components=2
fi
git archive "$SHA" | tar -x -C "$THEIRS"

# Reverse-apply the series newest-first, exactly as upstream-sync.yml does.
shopt -s nullglob
patches=(patches/[0-9]*.patch)
shopt -u nullglob

for (( i=${#patches[@]}-1; i>=0; i-- )); do
	p="$REPO_ROOT/${patches[$i]}"
	if ! ( cd "$OURS" && git apply -R -p1 --exclude=.sync-state "$p" ) 2>/dev/null; then
		echo "✗ could not reverse-apply $(basename "$p") from the committed vendor tree." >&2
		echo "  The tree does not match what that patch describes — regenerate it," >&2
		echo "  or find the out-of-band edit that moved the code underneath it." >&2
		exit 1
	fi
done

if diff -r -q -x node_modules -x dist "$THEIRS" "$OURS" >"$TMP/report" 2>&1; then
	echo "✓ vendor/pi == upstream $REF ($SHA) + patch series"
	exit 0
fi

echo "✗ vendor/pi has drifted from upstream $REF + patches/" >&2
echo "" >&2
sed 's/^/  /' "$TMP/report" >&2
echo "" >&2
cat >&2 <<'EOF'
Every difference above is a change to vendor/pi that no patch describes. It will
cause a merge conflict on the next `git subtree pull` and halt the sync.

Fix by either:
  - reverting the change (preferred — see docs/WORKFLOW.md anti-patterns), or
  - expressing it as a patch (make patch-new / make patch-export).

Do NOT edit vendor/pi to satisfy a scanner; exclude the path in ci.yml instead.
That exact mistake caused 15 consecutive silent sync failures.
EOF
exit 1
