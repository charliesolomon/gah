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
for want in articles/README.md templates/article.md bin/kb-search.sh bin/kb-search.ps1 bin/kb-sync.sh bin/kb-sync.ps1 \
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
# The description is the trigger, so it is where a negative clause does the most
# work: kb-search must say out loud that general technology questions are not
# its business, or a working session records a gap on every miss.
desc="$(awk -F': *' '/^description: /{print substr($0, 14); exit}' "$KB/skills/kb-search/SKILL.md")"
check "kb-search's description rules out general technology questions" \
	"$(printf '%s' "$desc" | grep -qi 'not for general\|NOT for general' && echo 1 || echo 0)"
check "kb-search gates on the cross-organization test before searching" \
	"$(grep -q 'different organization give the' "$KB/skills/kb-search/SKILL.md" && echo 1 || echo 0)"
check "kb-curate can prune gaps that do not belong" \
	"$(grep -qi 'gaps that should not be there' "$KB/skills/kb-curate/SKILL.md" && echo 1 || echo 0)"

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
echo "-- both flag conventions, because an agent will type either --"
# The .ps1 usage read in a bash session, and the .sh usage read in PowerShell.
# Before this was handled, `--question` on Windows PowerShell 5.1 recorded a gap
# titled "--question" with the real question as its tags: a plausible-looking
# file that answers nothing and never matches the same question twice.
"$KB/bin/kb-gap.sh" -Question "Which switch serves the gym?" >/dev/null 2>&1
check_eq "the bash twin accepts -Question and folds it onto the same stub" "requests: 3" \
	"$(grep '^requests:' "$KB/$gap_path")"
"$KB/bin/kb-gap.sh" "which switch serves the gym" >/dev/null 2>&1
check_eq "and a bare question with no flag at all" "requests: 4" "$(grep '^requests:' "$KB/$gap_path")"
check_eq "still exactly one stub" "1" "$(find "$KB/articles/gaps" -name '*.md' | wc -l | tr -d ' ')"
out="$("$KB/bin/kb-gap.sh" --question --oops 2>&1)"; rc=$?
check_eq "a flag where the question should be is refused, not written" "2" "$rc"
check "and the refusal shows the usage" "$(printf '%s' "$out" | grep -q 'Usage: kb-gap.sh' && echo 1 || echo 0)"
"$KB/bin/kb-new.sh" --title --oops >/dev/null 2>&1
check_eq "the same guard on kb-new.sh" "2" "$?"
"$KB/bin/kb-propose.sh" --message --oops >/dev/null 2>&1
check_eq "and on kb-propose.sh" "2" "$?"

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
check "status lists the gap with its count" "$(printf '%s' "$out" | grep -q '4x  Which switch serves the gym' && echo 1 || echo 0)"
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
echo "-- a date the model guessed rather than read --"
# Nothing in the harness told a model the date until now, so one wrote an
# article stamped a year early; the article then reported as overdue for review
# the day it was written. The prompt now carries the date, and this catches the
# residue.
printf -- '---\ntitle: Guessed date\ndescription: An article whose date was invented.\nstatus: current\nupdated: 2025-01-02\ntags: []\n---\nbody\n' >"$KB/articles/guessed-date.md"
printf -- '---\ntitle: Future date\ndescription: An article dated ahead of today.\nstatus: current\nupdated: 2099-01-01\ntags: []\n---\nbody\n' >"$KB/articles/future-date.md"
git -C "$KB" add -A >/dev/null 2>&1 && git -C "$KB" commit -qm "dates under test" >/dev/null 2>&1
out="$("$KB/bin/kb-status.sh" 2>&1)"
check "a date long before the file existed is flagged as guessed" \
	"$(printf '%s' "$out" | grep -q "guessed-date.md: updated '2025-01-02' predates the file" && echo 1 || echo 0)"
check "a date in the future is flagged" \
	"$(printf '%s' "$out" | grep -q "future-date.md: updated '2099-01-01' is in the future" && echo 1 || echo 0)"
check "the shipped example is not flagged for its invented date" \
	"$(printf '%s' "$out" | grep -q 'example-article.md: updated' && echo 0 || echo 1)"
git -C "$KB" rm -q "articles/guessed-date.md" "articles/future-date.md" >/dev/null 2>&1
git -C "$KB" commit -qm "remove the date fixtures" >/dev/null 2>&1

echo
echo "-- bringing the copy up to date after a merge --"
# The last mile: until somebody pulls, the author is still searching the stale
# copy they just improved, and so is every later session on that machine.
git -C "$WORK/origin.git" symbolic-ref HEAD refs/heads/main
git -C "$KB" checkout -q main
"$KB/bin/kb-sync.sh" >"$WORK/sync1.out" 2>&1
check_eq "sync on an unchanged clone succeeds" "0" "$?"
check "and says it is already up to date" "$(grep -qi 'already up to date' "$WORK/sync1.out" && echo 1 || echo 0)"

# Someone merges the proposal on the remote, as a reviewer would.
git clone -q "$WORK/origin.git" "$WORK/reviewer"
git -C "$WORK/reviewer" config user.name "Reviewer"
git -C "$WORK/reviewer" config user.email "rev@example.com"
git -C "$WORK/reviewer" merge -q --no-ff origin/kb/document-the-gym-switch -m "Merge the gym switch article"
git -C "$WORK/reviewer" push -q origin main

git -C "$KB" checkout -q kb/document-the-gym-switch
"$KB/bin/kb-sync.sh" >"$WORK/sync2.out" 2>&1
check_eq "sync succeeds from a merged branch" "0" "$?"
check_eq "it leaves the clone on the default branch" "main" "$(git -C "$KB" rev-parse --abbrev-ref HEAD)"
check "it names what arrived" "$(grep -q 'Document the gym switch' "$WORK/sync2.out" && echo 1 || echo 0)"
check "it clears the merged branch, so the next article is not written on top of it" \
	"$(git -C "$KB" rev-parse --verify -q kb/document-the-gym-switch >/dev/null && echo 0 || echo 1)"
check "and says so" "$(grep -qi 'cleared the merged branch' "$WORK/sync2.out" && echo 1 || echo 0)"

printf 'Uncommitted.\n' >>"$KB/$new_path"
"$KB/bin/kb-sync.sh" >"$WORK/sync3.out" 2>&1
check_eq "sync refuses to touch uncommitted work" "3" "$?"
check "and says to propose it first" "$(grep -q 'kb-propose' "$WORK/sync3.out" && echo 1 || echo 0)"
git -C "$KB" checkout -q -- articles

echo
echo "-- direct publishing, for teams that choose it --"
git -C "$KB" checkout -q main
# Relative, not absolute: earlier sections legitimately move main along, and an
# absolute count turns every new test above this one into a failure here.
main_before="$(git -C "$WORK/origin.git" rev-list --count main)"
printf 'A third fact.\n' >>"$KB/$new_path"
KB_PUBLISH=direct "$KB/bin/kb-propose.sh" --message "Add a third fact" >/dev/null 2>&1
check_eq "KB_PUBLISH=direct succeeds" "0" "$?"
check_eq "and lands on main" "main" "$(git -C "$KB" rev-parse --abbrev-ref HEAD)"
check_eq "which the remote now has" "$((main_before + 1))" "$(git -C "$WORK/origin.git" rev-list --count main)"

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
echo "-- a wrapper that injects flags before the subcommand (bash) --"
rm -rf "$WORK/kb-flags"
./bin/gah --skill "$WORK/nowhere" --prompt-template "$WORK/nowhere" init-kb "$WORK/kb-flags" >/dev/null 2>&1
check "bin/gah finds the subcommand after injected flags" "$([ -d "$WORK/kb-flags/articles" ] && echo 1 || echo 0)"

echo
echo "-- no secrets, no organisation, in the shipped scaffold --"
# The scaffold must be organisation-neutral (#20) and must not teach by example
# that credentials belong in a knowledge base.
hits="$(grep -rniE 'password[[:space:]]*[:=]|api[_-]?key[[:space:]]*[:=]|BEGIN [A-Z ]*PRIVATE KEY' \
	templates/kb-repo --include='*.md' --include='*.sh' --include='*.ps1' | grep -viE 'never|not|no |credential|secret|do not' || true)"
check "no credential-shaped strings" "$([ -z "$hits" ] && echo 1 || echo 0)"
[ -n "$hits" ] && printf '%s\n' "$hits" | sed 's/^/    /'

# Control characters in shipped text. A backspace written into a command line by
# a careless generator turns `.\bin\gah.ps1` into `.in\gah.ps1` on screen: the
# instruction still looks right in a diff and cannot work. It has happened twice.
ctrl="$(grep -rlP '[\x00-\x08\x0b\x0c\x0e-\x1f]' templates/kb-repo templates/deploy docs/KB.md docs/SKILLS.md bin scripts \
	--include='*.md' --include='*.sh' --include='*.ps1' --include='*.json' 2>/dev/null || true)"
check "no stray control characters in shipped text" "$([ -z "$ctrl" ] && echo 1 || echo 0)"
[ -n "$ctrl" ] && printf '%s\n' "$ctrl" | sed 's/^/    /'

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
	# GNU style on PowerShell: 7 binds --question to -Question, 5.1 does not, so
	# the same call wrote a gap titled "--question" on the target machine only.
	pwsh -NoProfile -File "$PS_KB/bin/kb-gap.ps1" --question "which switch serves the gym?" >/dev/null 2>&1
	check_eq "kb-gap.ps1 accepts --question too, onto the same stub" "requests: 3" "$(grep '^requests:' "$PS_KB/$g")"
	pwsh -NoProfile -File "$PS_KB/bin/kb-gap.ps1" "which switch serves the gym" >/dev/null 2>&1
	check_eq "and a bare question with no flag" "requests: 4" "$(grep '^requests:' "$PS_KB/$g")"
	check_eq "still exactly one stub" "1" "$(find "$PS_KB/articles/gaps" -name '*.md' | wc -l | tr -d ' ')"
	out="$(pwsh -NoProfile -File "$PS_KB/bin/kb-gap.ps1" --question --oops 2>&1)"; rc=$?
	check_eq "kb-gap.ps1 refuses a flag where the question should be" "2" "$rc"
	check "and shows the PowerShell usage" "$(printf '%s' "$out" | grep -q 'kb-gap.ps1 -Question' && echo 1 || echo 0)"
	p2="$(pwsh -NoProfile -File "$PS_KB/bin/kb-new.ps1" --title "Addressing plan" --area network 2>/dev/null | tr -d '\r')"
	check_eq "kb-new.ps1 accepts GNU-style flags" "articles/network/addressing-plan.md" "$p2"
	pwsh -NoProfile -File "$PS_KB/bin/kb-status.ps1" --stale-days 9999 >/dev/null 2>&1
	check_eq "kb-status.ps1 accepts --stale-days" "0" "$?"
	out="$(pwsh -NoProfile -File "$PS_KB/bin/kb-status.ps1" 2>&1)"
	check "kb-status.ps1 reports the backlog" "$(printf '%s' "$out" | grep -q '4x  Which switch serves the gym' && echo 1 || echo 0)"

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

	# However a person wired up their `gah` alias, a subcommand must behave.
	# Three shapes exist in the wild and the difference is invisible until it
	# bites: @args (correct), $args (one nested array), "$args" (one string).
	# The 'flags' form is the one that actually bit: a wrapper that injects
	# --skill/--prompt-template ahead of the person's arguments, so the
	# subcommand is not argument one.
	cat >"$WORK/alias.ps1" <<'PSEOF'
$script = $args[0]; $form = $args[1]; $rest = @($args[2..($args.Count-1)])
switch ($form) {
  'splat'  { & $script @rest }
  'bare'   { & $script $rest }
  'joined' { & $script "$rest" }
  'flags'  { & $script --skill 'C:\nowhere\skills' --prompt-template 'C:\nowhere\prompts' @rest }
}
PSEOF
	for form in splat bare flags; do
		rm -rf "$WORK/kb-$form"
		pwsh -NoProfile -File "$WORK/alias.ps1" "$REPO_ROOT/bin/gah.ps1" "$form" init-kb "$WORK/kb-$form" >/dev/null 2>&1
		check "an alias using the $form form still scaffolds" "$([ -d "$WORK/kb-$form/articles" ] && echo 1 || echo 0)"
	done
	out="$(pwsh -NoProfile -File "$WORK/alias.ps1" "$REPO_ROOT/bin/gah.ps1" joined init-kb "$WORK/kb-joined" 2>&1)"
	check "an alias that joins its arguments is diagnosed, not sent to the model" \
		"$(printf '%s' "$out" | grep -q 'as a single argument' && echo 1 || echo 0)"
	check "and the diagnosis names the splat form as the fix" \
		"$(printf '%s' "$out" | grep -qF '@args' && echo 1 || echo 0)"
	argv="$(PATH="$WORK/fakebin:$PATH" GAH_ALLOW_NO_SKILLS=1 pwsh -NoProfile -File "$REPO_ROOT/bin/gah.ps1" "init a new thing for me" 2>/dev/null)"
	check "a genuine prompt beginning with 'init' still reaches the agent" \
		"$(printf '%s' "$argv" | grep -qF 'init a new thing for me' && echo 1 || echo 0)"
	argv="$(PATH="$WORK/fakebin:$PATH" GAH_ALLOW_NO_SKILLS=1 pwsh -NoProfile -File "$REPO_ROOT/bin/gah.ps1" --skill init-kb 2>/dev/null)"
	check "a flag whose value happens to be 'init-kb' is not read as a subcommand" \
		"$(printf '%s' "$argv" | grep -qF -- '--skill' && echo 1 || echo 0)"

	pwsh -NoProfile -File "$PS_KB/bin/kb-sync.ps1" >"$WORK/ps-sync.out" 2>&1
	check_eq "kb-sync.ps1 succeeds" "0" "$?"
	check "and reports the state of the copy" \
		"$(grep -qiE 'up to date|new since' "$WORK/ps-sync.out" && echo 1 || echo 0)"
	printf 'Uncommitted.\n' >>"$PS_KB/articles/network/gym-switch.md"
	pwsh -NoProfile -File "$PS_KB/bin/kb-sync.ps1" >/dev/null 2>&1
	check_eq "kb-sync.ps1 refuses to touch uncommitted work" "3" "$?"
	git -C "$PS_KB" checkout -q -- articles

	# The third launcher: the packaged one an end user actually runs. It fetches
	# skills as a read-only archive, so a knowledge base reaches it only as a
	# local clone named by GAH_KB_DIR -- and a scaffolding subcommand typed at it
	# must not become a question to the model, which is how this was found.
	PKG="$WORK/pkg/gah-1.0"
	mkdir -p "$PKG/bundle"
	printf '{"gitlab":{"url":"https://gitlab.invalid","project":"x","package":"y","proxy":"none"},"skills":{"project":"a/b","branch":"main"},"env":{}}' >"$PKG/deploy.json"
	echo 'console.log("cli")' >"$PKG/bundle/cli.js"
	cp templates/deploy/windows/gah.ps1 "$PKG/gah.ps1"
	out="$(pwsh -NoProfile -File "$PKG/gah.ps1" init-kb "$WORK/whatever" 2>&1)"; rc=$?
	check_eq "the packaged launcher refuses init-kb instead of prompting the model" "2" "$rc"
	check "and says where the subcommand does live" \
		"$(printf '%s' "$out" | grep -qF 'bin\gah.ps1 init-kb' && echo 1 || echo 0)"
	argv="$(PATH="$WORK/fakebin:$PATH" GAH_ALLOW_NO_SKILLS=1 GAH_KB_DIR="$PS_KB" pwsh -NoProfile -File "$PKG/gah.ps1" 2>/dev/null)"
	check "the packaged launcher passes the knowledge base's skills" \
		"$(printf '%s' "$argv" | grep -qF "$PS_KB/skills" && echo 1 || echo 0)"
	check "and its prompts" "$(printf '%s' "$argv" | grep -qF "$PS_KB/prompts" && echo 1 || echo 0)"
	argv="$(PATH="$WORK/fakebin:$PATH" GAH_ALLOW_NO_SKILLS=1 pwsh -NoProfile -File "$PKG/gah.ps1" 2>/dev/null)"
	check "and passes nothing when GAH_KB_DIR is unset" \
		"$(printf '%s' "$argv" | grep -qF "$PS_KB" && echo 0 || echo 1)"
else
	echo
	echo "-- PowerShell twins: SKIPPED (no pwsh on PATH) --"
fi

echo
if [ "$fail" -eq 0 ]; then echo "knowledge base: OK"; else echo "knowledge base: FAILED" >&2; fi
exit "$fail"
