#!/usr/bin/env bash
#
# check-kb.sh — exercise the knowledge base scaffold end to end.
#
# `gah init-kb` into a temp directory, then drive the loop the concept rests on:
# ask (search), miss (record a gap), ask again (the count rises), write the
# article, propose it, see it land on a branch of a real remote. Every assertion
# is on observable behaviour — a file that exists, an exit code, a commit on a
# bare repo — because the failure this guards against is the scaffold rotting
# quietly while still looking right.
#
# The argv check is the other half: it runs bin/gah with a fake `node` on PATH
# that prints its arguments, so "the knowledge base's skills are actually passed
# to the harness" is verified rather than assumed.
#
# Needs git and bash. The PowerShell twins are checked only when `pwsh` is on
# PATH (it is on GitHub's ubuntu runners, absent on most dev boxes); the check
# says which it did.
#
# Usage: scripts/check-kb.sh      KEEP=1 leaves the work directory behind.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

WORK="$(mktemp -d)"
cleanup() { if [ -n "${KEEP:-}" ]; then echo "work dir kept: $WORK"; else rm -rf "$WORK"; fi; }
trap cleanup EXIT

fail=0
check() {
	local label="$1" ok="$2"
	if [ "$ok" = "1" ]; then echo "✓ $label"; else echo "✗ $label" >&2; fail=1; fi
}
# check_eq <label> <expected> <actual>
check_eq() {
	if [ "$2" = "$3" ]; then echo "✓ $1"; else echo "✗ $1 (expected '$2', got '$3')" >&2; fail=1; fi
}

KB="$WORK/kb"

echo "-- gah init-kb --"
./bin/gah init-kb "$KB" >"$WORK/init.out" 2>&1
check "init-kb succeeded" "$([ $? -eq 0 ] && echo 1 || echo 0)"
for want in articles/README.md templates/article.md bin/kb-search.sh bin/kb-search.ps1 \
            skills/kb-search/SKILL.md skills/kb-article/SKILL.md skills/kb-propose/SKILL.md \
            skills/kb-curate/SKILL.md prompts/kb.md README.md; do
	check "scaffold has $want" "$([ -e "$KB/$want" ] && echo 1 || echo 0)"
done
check "the .sh scripts are executable" "$([ -x "$KB/bin/kb-search.sh" ] && echo 1 || echo 0)"
./bin/gah init-kb "$KB" >/dev/null 2>&1
check_eq "init-kb refuses a non-empty directory" "1" "$?"

echo
echo "-- every skill is loadable --"
# name must be lowercase/hyphen per upstream's validator, and a description is
# what makes a skill reachable at all: a skill with a weak one is never used.
for s in "$KB"/skills/*/SKILL.md; do
	rel="skills/$(basename "$(dirname "$s")")"
	name="$(awk -F': *' '/^name: /{print $2; exit}' "$s")"
	desc="$(awk -F': *' '/^description: /{print substr($0, 14); exit}' "$s")"
	check "$rel declares a spec-valid name ($name)" \
		"$(printf '%s' "$name" | grep -qE '^[a-z0-9-]+$' && echo 1 || echo 0)"
	check_eq "$rel name matches its directory" "$(basename "$(dirname "$s")")" "$name"
	check "$rel description is substantial" "$([ "${#desc}" -ge 80 ] && echo 1 || echo 0)"
	check "$rel description names when to use it" \
		"$(printf '%s' "$desc" | grep -qi 'use when\|use whenever' && echo 1 || echo 0)"
done

echo
echo "-- search, on a knowledge base that holds only the example --"
out="$("$KB/bin/kb-search.sh" "wireless north site" 2>&1)"; rc=$?
check_eq "a match exits 0" "0" "$rc"
check "the match names the article path" "$(printf '%s' "$out" | grep -q 'articles/example-article.md' && echo 1 || echo 0)"
check "the match shows status and updated" "$(printf '%s' "$out" | grep -q 'status:.*updated:' && echo 1 || echo 0)"
out="$("$KB/bin/kb-search.sh" "kubernetes ingress" 2>&1)"; rc=$?
check_eq "no match exits 1 (so a caller can branch on it)" "1" "$rc"
check "no match says so in words" "$(printf '%s' "$out" | grep -qi 'no article covers that' && echo 1 || echo 0)"

echo
echo "-- the gap loop --"
gap_path="$("$KB/bin/kb-gap.sh" --question "Which switch serves the gym?" --tags network 2>/dev/null)"
check_eq "recording a gap prints its path" "articles/gaps/which-switch-serves-the-gym.md" "$gap_path"
check "the stub is status: gap" "$(grep -q '^status: gap$' "$KB/$gap_path" && echo 1 || echo 0)"
check_eq "first request counts 1" "requests: 1" "$(grep '^requests:' "$KB/$gap_path")"
# The same question, phrased as people actually retype it.
"$KB/bin/kb-gap.sh" --question "which switch serves the gym" >/dev/null 2>&1
check_eq "asking again bumps the count, not a second stub" "requests: 2" "$(grep '^requests:' "$KB/$gap_path")"
check_eq "and only one stub exists" "1" "$(find "$KB/articles/gaps" -name '*.md' | wc -l | tr -d ' ')"
out="$("$KB/bin/kb-search.sh" "switch gym" 2>&1)"
check "a recorded gap is findable by the next person to ask" \
	"$(printf '%s' "$out" | grep -q 'articles/gaps/which-switch-serves-the-gym.md' && echo 1 || echo 0)"
check "and it is shown with its request count" "$(printf '%s' "$out" | grep -q 'requests: 2' && echo 1 || echo 0)"

echo
echo "-- writing an article --"
new_path="$("$KB/bin/kb-new.sh" --title "Gym switch" --area network --tags network,switching 2>/dev/null)"
check_eq "kb-new prints the path it wrote" "articles/network/gym-switch.md" "$new_path"
check "frontmatter carries the title" "$(grep -q '^title: Gym switch$' "$KB/$new_path" && echo 1 || echo 0)"
check "frontmatter carries today's date" "$(grep -q "^updated: $(date +%Y-%m-%d)\$" "$KB/$new_path" && echo 1 || echo 0)"
check "frontmatter carries the tags" "$(grep -q '^tags: \[network, switching\]$' "$KB/$new_path" && echo 1 || echo 0)"
check "new articles start as drafts" "$(grep -q '^status: draft$' "$KB/$new_path" && echo 1 || echo 0)"
check "the template body came through" "$(grep -q '^## Exceptions' "$KB/$new_path" && echo 1 || echo 0)"
"$KB/bin/kb-new.sh" --title "Gym switch" --area network >/dev/null 2>&1
check_eq "kb-new refuses to clobber an article" "3" "$?"
"$KB/bin/kb-new.sh" --title "Escape" --path "../../etc/passwd" >/dev/null 2>&1
check_eq "kb-new refuses a path that escapes the repository" "2" "$?"

echo
echo "-- status is the backlog --"
out="$("$KB/bin/kb-status.sh" 2>&1)"
check "status counts the articles" "$(printf '%s' "$out" | grep -qE '[0-9]+ articles' && echo 1 || echo 0)"
check "status lists the gap with its count" "$(printf '%s' "$out" | grep -q '2x  Which switch serves the gym' && echo 1 || echo 0)"
check "status flags the missing description" "$(printf '%s' "$out" | grep -q 'no description' && echo 1 || echo 0)"
check "status nags about the example article" "$(printf '%s' "$out" | grep -qi 'example article' && echo 1 || echo 0)"
check "status reports the stale example" "$(printf '%s' "$out" | grep -qi 'not verified in over' && echo 1 || echo 0)"

echo
echo "-- proposing a change --"
# A fresh account has no git identity at all, which is the case the guard is
# for. Isolated from this machine's global config, or the developer's own
# identity answers for it and the check passes vacuously.
NOIDENT="$WORK/kb-noident"
./bin/gah init-kb "$NOIDENT" >/dev/null 2>&1
git -C "$NOIDENT" init -q -b main .
HOME="$WORK/empty-home" GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null \
	"$NOIDENT/bin/kb-propose.sh" --message "no identity yet" >"$WORK/noident.out" 2>&1
check_eq "propose refuses without a git identity (nothing to attribute to)" "2" "$?"
check "and says which two commands to run" \
	"$(grep -q 'config user.name' "$WORK/noident.out" && grep -q 'config user.email' "$WORK/noident.out" && echo 1 || echo 0)"

git init -q --bare "$WORK/origin.git"
git -C "$KB" init -q -b main .
git -C "$KB" remote add origin "$WORK/origin.git"
git -C "$KB" config user.name "Test Tech"
git -C "$KB" config user.email "tech@example.com"
git -C "$KB" add -A
git -C "$KB" commit -qm "Initial knowledge base"
git -C "$KB" push -q -u origin main
check_eq "the scaffold starts on main with one commit" "1" "$(git -C "$WORK/origin.git" rev-list --count main)"

"$KB/bin/kb-propose.sh" --message "nothing changed" >/dev/null 2>&1
check_eq "propose exits 1 when articles/ is unchanged" "1" "$?"

printf 'The gym is served by the switch in the Building B cupboard.\n' >>"$KB/$new_path"
out="$("$KB/bin/kb-propose.sh" --message "Document the gym switch" 2>&1)"; rc=$?
check_eq "propose succeeds" "0" "$rc"
check_eq "it lands on a branch named from the message" "kb/document-the-gym-switch" \
	"$(git -C "$KB" rev-parse --abbrev-ref HEAD)"
check "the branch reached the remote" \
	"$(git -C "$WORK/origin.git" rev-parse --verify -q kb/document-the-gym-switch >/dev/null && echo 1 || echo 0)"
check "main is untouched — nothing published without a person" \
	"$([ "$(git -C "$WORK/origin.git" rev-list --count main)" = "1" ] && echo 1 || echo 0)"
check "the commit is attributed to the person, not a robot" \
	"$([ "$(git -C "$KB" log -1 --format='%an')" = "Test Tech" ] && echo 1 || echo 0)"
check "it says what was staged" "$(printf '%s' "$out" | grep -q 'Staged:' && echo 1 || echo 0)"

# Tooling changes must not ride along with an article.
git -C "$KB" checkout -q main
printf '# touched\n' >>"$KB/bin/kb-search.sh"
printf 'Another fact.\n' >>"$KB/$new_path"
"$KB/bin/kb-propose.sh" --message "Second change" >/dev/null 2>&1
check "a change to bin/ is NOT swept into an article proposal" \
	"$(git -C "$KB" diff --quiet HEAD -- articles && ! git -C "$KB" diff --quiet HEAD -- bin && echo 1 || echo 0)"
git -C "$KB" checkout -q -- bin 2>/dev/null

echo
echo "-- direct publishing, for teams that choose it --"
git -C "$KB" checkout -q main
printf 'A third fact.\n' >>"$KB/$new_path"
KB_PUBLISH=direct "$KB/bin/kb-propose.sh" --message "Add a third fact" >/dev/null 2>&1
check_eq "KB_PUBLISH=direct succeeds" "0" "$?"
check_eq "and lands on main" "main" "$(git -C "$KB" rev-parse --abbrev-ref HEAD)"
check_eq "which the remote now has" "2" "$(git -C "$WORK/origin.git" rev-list --count main)"

echo
echo "-- the launcher actually passes the knowledge base to the harness --"
# A fake `node` that prints argv: the only way to assert on what bin/gah execs
# without starting a session.
mkdir -p "$WORK/fakebin"
cat >"$WORK/fakebin/node" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@"
EOF
chmod +x "$WORK/fakebin/node"
argv="$(PATH="$WORK/fakebin:$PATH" GAH_ALLOW_NO_SKILLS=1 GAH_KB_DIR="$KB" GAH_SKIP_SETUP=1 ./bin/gah 2>/dev/null)"
check "the KB's skills directory is passed with --skill" \
	"$(printf '%s' "$argv" | grep -qF "$KB/skills" && echo 1 || echo 0)"
check "the KB's prompts directory is passed with --prompt-template" \
	"$(printf '%s' "$argv" | grep -qF "$KB/prompts" && echo 1 || echo 0)"
argv="$(PATH="$WORK/fakebin:$PATH" GAH_ALLOW_NO_SKILLS=1 GAH_SKIP_SETUP=1 ./bin/gah 2>/dev/null)"
check "and nothing knowledge-base-shaped is passed when GAH_KB_DIR is unset" \
	"$(printf '%s' "$argv" | grep -qF "$KB" && echo 0 || echo 1)"
out="$(PATH="$WORK/fakebin:$PATH" GAH_ALLOW_NO_SKILLS=1 GAH_KB_DIR="$WORK/not-a-kb" GAH_SKIP_SETUP=1 ./bin/gah 2>&1 >/dev/null)"
check "a GAH_KB_DIR with no skills/ is reported rather than ignored" \
	"$(printf '%s' "$out" | grep -q 'knowledge base not loaded' && echo 1 || echo 0)"

echo
echo "-- no secrets, no organisation, in the shipped scaffold --"
# The scaffold must be organisation-neutral (#20) and must not teach by example
# that credentials belong in a knowledge base.
hits="$(grep -rniE 'password[[:space:]]*[:=]|api[_-]?key[[:space:]]*[:=]|BEGIN [A-Z ]*PRIVATE KEY' \
	templates/kb-repo --include='*.md' --include='*.sh' --include='*.ps1' | grep -viE 'never|not|no |credential|secret|do not' || true)"
check "no credential-shaped strings" "$([ -z "$hits" ] && echo 1 || echo 0)"
[ -n "$hits" ] && printf '%s\n' "$hits" | sed 's/^/    /'

if command -v pwsh >/dev/null 2>&1; then
	echo
	echo "-- PowerShell twins (pwsh present) --"
	PS_KB="$WORK/kb-ps"
	./bin/gah init-kb "$PS_KB" >/dev/null 2>&1
	out="$(pwsh -NoProfile -File "$PS_KB/bin/kb-search.ps1" "wireless north site" 2>&1)"; rc=$?
	check_eq "kb-search.ps1 finds the example (exit 0)" "0" "$rc"
	check "kb-search.ps1 prints the article path" "$(printf '%s' "$out" | grep -q 'articles/example-article.md' && echo 1 || echo 0)"
	pwsh -NoProfile -File "$PS_KB/bin/kb-search.ps1" "kubernetes ingress" >/dev/null 2>&1
	check_eq "kb-search.ps1 exits 1 on no match" "1" "$?"
	p="$(pwsh -NoProfile -File "$PS_KB/bin/kb-new.ps1" -Title "Gym switch" -Area network -Tags network,switching 2>/dev/null)"
	check_eq "kb-new.ps1 writes the same path as its twin" "articles/network/gym-switch.md" "$(printf '%s' "$p" | tr -d '\r')"
	check "kb-new.ps1 writes valid frontmatter" "$(grep -q '^tags: \[network, switching\]$' "$PS_KB/articles/network/gym-switch.md" && echo 1 || echo 0)"
	check "kb-new.ps1 writes UTF-8 without a BOM" \
		"$(head -c3 "$PS_KB/articles/network/gym-switch.md" | grep -q $'\xef\xbb\xbf' && echo 0 || echo 1)"
	pwsh -NoProfile -File "$PS_KB/bin/kb-new.ps1" -Title "Gym switch" -Area network >/dev/null 2>&1
	check_eq "kb-new.ps1 refuses to clobber" "3" "$?"
	g="$(pwsh -NoProfile -File "$PS_KB/bin/kb-gap.ps1" -Question "Which switch serves the gym?" 2>/dev/null | tr -d '\r')"
	check_eq "kb-gap.ps1 records the same slug as its twin" "articles/gaps/which-switch-serves-the-gym.md" "$g"
	pwsh -NoProfile -File "$PS_KB/bin/kb-gap.ps1" -Question "which switch serves the gym" >/dev/null 2>&1
	check_eq "kb-gap.ps1 bumps rather than duplicating" "requests: 2" "$(grep '^requests:' "$PS_KB/$g")"
	out="$(pwsh -NoProfile -File "$PS_KB/bin/kb-status.ps1" 2>&1)"
	check "kb-status.ps1 reports the backlog" "$(printf '%s' "$out" | grep -q '2x  Which switch serves the gym' && echo 1 || echo 0)"

	# Both twins must rank the same way, or an answer depends on which platform
	# the person happens to be on.
	sh_out="$("$PS_KB/bin/kb-search.sh" "wireless north site" 2>/dev/null | head -n1)"
	ps_out="$(pwsh -NoProfile -File "$PS_KB/bin/kb-search.ps1" "wireless north site" 2>/dev/null | head -n1 | tr -d '\r')"
	check_eq "both search twins return the same top hit" "$sh_out" "$ps_out"

	# kb-propose.ps1 is the riskiest twin: it drives git and reads exit codes.
	git init -q --bare "$WORK/ps-origin.git"
	git -C "$PS_KB" init -q -b main .
	git -C "$PS_KB" remote add origin "$WORK/ps-origin.git"
	git -C "$PS_KB" config user.name "PS Tech"
	git -C "$PS_KB" config user.email "ps@example.com"
	git -C "$PS_KB" add -A && git -C "$PS_KB" commit -qm "Initial knowledge base"
	git -C "$PS_KB" push -q -u origin main
	pwsh -NoProfile -File "$PS_KB/bin/kb-propose.ps1" -Message "nothing changed" >/dev/null 2>&1
	check_eq "kb-propose.ps1 exits 1 when articles/ is unchanged" "1" "$?"
	printf 'The gym is served by the Building B switch.\n' >>"$PS_KB/articles/network/gym-switch.md"
	pwsh -NoProfile -File "$PS_KB/bin/kb-propose.ps1" -Message "Document the gym switch" >"$WORK/ps-propose.out" 2>&1
	check_eq "kb-propose.ps1 succeeds" "0" "$?"
	check_eq "and uses the same branch name as its twin" "kb/document-the-gym-switch" \
		"$(git -C "$PS_KB" rev-parse --abbrev-ref HEAD)"
	check "the branch reached the remote" \
		"$(git -C "$WORK/ps-origin.git" rev-parse --verify -q kb/document-the-gym-switch >/dev/null && echo 1 || echo 0)"
	check "main is untouched" "$([ "$(git -C "$WORK/ps-origin.git" rev-list --count main)" = "1" ] && echo 1 || echo 0)"
	check "the commit is attributed to the person" \
		"$([ "$(git -C "$PS_KB" log -1 --format='%an')" = "PS Tech" ] && echo 1 || echo 0)"
	git -C "$PS_KB" checkout -q main
	printf 'A second fact.\n' >>"$PS_KB/articles/network/gym-switch.md"
	KB_PUBLISH=direct pwsh -NoProfile -File "$PS_KB/bin/kb-propose.ps1" -Message "Add a second fact" >/dev/null 2>&1
	check_eq "kb-propose.ps1 honours KB_PUBLISH=direct" "2" "$(git -C "$WORK/ps-origin.git" rev-list --count main)"
else
	echo
	echo "-- PowerShell twins: SKIPPED (no pwsh on PATH) --"
fi

echo
if [ "$fail" -eq 0 ]; then echo "knowledge base: OK"; else echo "knowledge base: FAILED" >&2; fi
exit "$fail"
