#!/usr/bin/env bash
#
# check-skills.sh — the skills scaffold and its update path.
#
# `gah init` writes a repository an organisation then owns. Two things in it are
# gah's rather than theirs — the skill-authoring guidance and the onboarding
# skill — and `gah update-skills` exists so a fix to those reaches deployments
# that already ran init. The line between "ours" and "theirs" is the whole
# design, so most of what follows asserts what the update does NOT touch.
#
# Also checks the content of the two starter skills, because skill-authoring is
# what every organisation reads before writing its third skill: if it stops
# telling people to keep facts in the knowledge base, new skills quietly go back
# to embedding them and the improvement loop stops.
#
# Needs git and bash. The PowerShell twin runs only when `pwsh` is on PATH.
#
# Usage: scripts/check-skills.sh      KEEP=1 leaves the work directory behind.
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
check_eq() {
	if [ "$2" = "$3" ]; then echo "✓ $1"; else echo "✗ $1 (expected '$2', got '$3')" >&2; fail=1; fi
}

mkdir -p "$WORK/fakebin"
cat >"$WORK/fakebin/node" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@"
EOF
chmod +x "$WORK/fakebin/node"

SK="$WORK/skills-repo"

echo "-- gah init --"
./bin/gah init "$SK" >/dev/null 2>&1
check_eq "init succeeds" "0" "$?"
for want in skills/onboarding/SKILL.md skills/skill-authoring/SKILL.md setup prompts context/README.md README.md; do
	check "scaffold has $want" "$([ -e "$SK/$want" ] && echo 1 || echo 0)"
done
check "it records which scaffold it came from" "$([ -s "$SK/.skills-scaffold" ] && echo 1 || echo 0)"
./bin/gah init "$SK" >/dev/null 2>&1
check_eq "init refuses a non-empty directory" "1" "$?"

echo
echo "-- the starter skills are loadable --"
for s in "$SK"/skills/*/SKILL.md; do
	rel="skills/$(basename "$(dirname "$s")")"
	name="$(awk -F': *' '/^name: /{print $2; exit}' "$s")"
	desc="$(awk '/^description: /{print substr($0, 14); exit}' "$s")"
	check "$rel has a spec-valid name ($name)" \
		"$(printf '%s' "$name" | grep -qE '^[a-z0-9-]+$' && echo 1 || echo 0)"
	check_eq "$rel name matches its directory" "$(basename "$(dirname "$s")")" "$name"
	check "$rel description says when to use it" \
		"$(printf '%s' "$desc" | grep -qi 'use when' && echo 1 || echo 0)"
done

echo
echo "-- skill-authoring teaches the split that keeps the loop running --"
# Every organisation reads this before writing its third skill. If it stops
# saying that facts belong in the knowledge base, new skills embed them again,
# and an embedded fact cannot be corrected by the person who found it wrong.
SA="$SK/skills/skill-authoring/SKILL.md"
check "it names the knowledge base at all" "$(grep -qi 'knowledge base' "$SA" && echo 1 || echo 0)"
check "it states the split: skill is procedure, knowledge base is fact" \
	"$(grep -qi 'skill is the procedure' "$SA" && echo 1 || echo 0)"
check "it offers the choice between a skill, an article and a prompt template" \
	"$(grep -qi 'is it a skill at all' "$SA" && echo 1 || echo 0)"
check "it teaches consulting rather than embedding" \
	"$(grep -qi 'consult, do not embed' "$SA" && echo 1 || echo 0)"
check "it says what to do when a fact is undocumented" \
	"$(grep -qi 'record a gap\|recording a gap\|records a gap' "$SA" && echo 1 || echo 0)"
check "it resolves context/ against the knowledge base" \
	"$(grep -q 'context/' "$SA" && echo 1 || echo 0)"
# allowed-tools does not gate anything in GAH: upstream reads name, description
# and disable-model-invocation, and the policy allowlist is what stops a call.
# Saying otherwise invites an author to believe a skill is fenced when it is not.
check "it does not call allowed-tools a hard boundary" \
	"$(grep -qi 'allowed-tools.*hard boundary\|hard boundary.*allowed-tools' "$SA" && echo 0 || echo 1)"
check "it names the policy allowlist as what actually stops a call" \
	"$(grep -qi 'allowlist' "$SA" && echo 1 || echo 0)"
check "it keeps the description guidance, which is what gets a skill chosen" \
	"$(grep -qi 'request someone would make' "$SA" && echo 1 || echo 0)"
check "it can review existing skills, not only write new ones" \
	"$(grep -qi 'reviewing skills that already exist' "$SA" && echo 1 || echo 0)"
check "the review half is reachable from the description" \
	"$(awk '/^description: /{print; exit}' "$SA" | grep -qi 'review\|assess\|audit' && echo 1 || echo 0)"
# The four below came from running the review procedure against this repo's own
# skills. Each caught something the other checks missed, so each is pinned here.
check "the review checks that paths are anchored, not bare" \
	"$(grep -qi 'anchored to it' "$SA" && echo 1 || echo 0)"
check "it checks the no-shell fallback does the same job as the wrapper" \
	"$(grep -qi 'degraded path' "$SA" && echo 1 || echo 0)"
check "it follows handovers between skills, not just collisions" \
	"$(grep -qi 'follow every skill a skill names' "$SA" && echo 1 || echo 0)"
check "it says the checking order is not the reporting order" \
	"$(grep -qi "not a finding's severity" "$SA" && echo 1 || echo 0)"
check "it allows one finding to span the whole set" \
	"$(grep -qi 'span the whole set' "$SA" && echo 1 || echo 0)"

echo
echo "-- update-skills: what it refreshes --"
git -C "$SK" init -q -b main .
git -C "$SK" config user.name "Tech"; git -C "$SK" config user.email "t@example.com"
git -C "$SK" add -A >/dev/null 2>&1; git -C "$SK" commit -qm "their skills repo" >/dev/null 2>&1

./bin/gah update-skills "$SK" >"$WORK/u0.out" 2>&1
check_eq "an update with nothing to do succeeds" "0" "$?"
check "and says it is already current" "$(grep -qi 'already current' "$WORK/u0.out" && echo 1 || echo 0)"

# Now a repository that has diverged the way a real one does.
mkdir -p "$SK/skills/their-own"
printf -- '---\nname: their-own\ndescription: Theirs. Use when testing.\n---\ntheirs\n' >"$SK/skills/their-own/SKILL.md"
printf 'their prompt\n' >"$SK/prompts/theirs.md"
printf 'their context\n' >"$SK/context/sites.md"
printf '# their readme\n' >"$SK/README.md"
sed -i '2i # a local edit to a starter skill' "$SK/skills/onboarding/SKILL.md"
printf 'scaffold 0000000\n' >"$SK/.skills-scaffold"
git -C "$SK" add -A >/dev/null 2>&1; git -C "$SK" commit -qm "diverged" >/dev/null 2>&1

./bin/gah update-skills "$SK" >"$WORK/u1.out" 2>&1
check_eq "update-skills succeeds on a diverged repository" "0" "$?"
check "it refreshes the starter skills" "$(grep -q 'skills/onboarding' "$WORK/u1.out" && echo 1 || echo 0)"
check "the local edit to a starter is replaced" \
	"$(grep -q 'a local edit to a starter skill' "$SK/skills/onboarding/SKILL.md" && echo 0 || echo 1)"
check "their own skill is untouched" "$([ -f "$SK/skills/their-own/SKILL.md" ] && echo 1 || echo 0)"
check "their prompt is untouched" "$([ -f "$SK/prompts/theirs.md" ] && echo 1 || echo 0)"
check "their context file is untouched" "$([ -f "$SK/context/sites.md" ] && echo 1 || echo 0)"
check_eq "their README is untouched" "# their readme" "$(cat "$SK/README.md")"
check "it says their own material was left alone" \
	"$(grep -q 'were not touched' "$WORK/u1.out" && echo 1 || echo 0)"
check "the marker moves forward" "$(grep -q '^scaffold 0000000$' "$SK/.skills-scaffold" && echo 0 || echo 1)"

echo
echo "-- what it refuses, and what it will not undo --"
# A starter someone deleted was a decision; putting it back would reverse it.
git -C "$SK" add -A >/dev/null 2>&1; git -C "$SK" commit -qm "took the update" >/dev/null 2>&1
git -C "$SK" rm -rq skills/onboarding >/dev/null 2>&1
printf 'scaffold 0000000\n' >"$SK/.skills-scaffold"
git -C "$SK" add -A >/dev/null 2>&1; git -C "$SK" commit -qm "removed a starter" >/dev/null 2>&1
./bin/gah update-skills "$SK" >"$WORK/u2.out" 2>&1
check "a deleted starter is not resurrected" "$([ -e "$SK/skills/onboarding" ] && echo 0 || echo 1)"
check "and the report says it was left out" "$(grep -q 'removed here' "$WORK/u2.out" && echo 1 || echo 0)"

git -C "$SK" add -A >/dev/null 2>&1; git -C "$SK" commit -qm "settled" >/dev/null 2>&1
printf 'scaffold 0000000\n' >"$SK/.skills-scaffold"
printf 'uncommitted\n' >>"$SK/skills/their-own/SKILL.md"
./bin/gah update-skills "$SK" >/dev/null 2>&1
check_eq "it refuses a dirty tree, so the diff stays readable" "3" "$?"
./bin/gah update-skills "$SK" --force >/dev/null 2>&1
check_eq "--force goes ahead anyway" "0" "$?"
git -C "$SK" checkout -q -- . 2>/dev/null

./bin/gah update-skills "$WORK/fakebin" >"$WORK/u4.out" 2>&1
check_eq "it refuses a directory that is not a skills repository" "1" "$?"
check "and says why, rather than failing silently" \
	"$(grep -q 'does not look like a skills repository' "$WORK/u4.out" && echo 1 || echo 0)"
./bin/gah update-skills >/dev/null 2>&1
check_eq "and refuses with no directory at all" "2" "$?"

# A folder someone copied rather than cloned. No undo, so it says so and goes on
# rather than refusing: refusing would leave the copy permanently behind.
PLAIN="$WORK/not-a-repo"
./bin/gah init "$PLAIN" >/dev/null 2>&1
printf 'scaffold 0000000\n' >"$PLAIN/.skills-scaffold"
./bin/gah update-skills "$PLAIN" >"$WORK/u5.out" 2>&1
check_eq "it still updates a skills folder that is not a git repository" "0" "$?"
check "and warns that there is no undo" \
	"$(grep -q 'not a git repository' "$WORK/u5.out" && echo 1 || echo 0)"

# GAH_SKILLS_DIR holds skills/, not the repository root, so that is the path
# someone has to hand and the one they will paste.
printf 'scaffold 0000000\n' >"$SK/.skills-scaffold"
git -C "$SK" commit -qam "stale again" >/dev/null 2>&1
./bin/gah update-skills "$SK/skills" >"$WORK/u3.out" 2>&1
check_eq "it accepts the skills/ directory, which is what GAH_SKILLS_DIR holds" "0" "$?"
check "and resolves it up to the repository root" \
	"$(grep -q "in $SK\$" "$WORK/u3.out" && echo 1 || echo 0)"

echo
echo "-- a session says when the starters are behind --"
printf 'scaffold 0000000\n' >"$SK/.skills-scaffold"
out="$(PATH="$WORK/fakebin:$PATH" GAH_SKILLS_DIR="$SK/skills" GAH_SKIP_SETUP=1 ./bin/gah 2>&1 >/dev/null)"
check "it says so" "$(printf '%s' "$out" | grep -q 'behind this checkout' && echo 1 || echo 0)"
check "and names the command that fixes it" "$(printf '%s' "$out" | grep -q 'update-skills' && echo 1 || echo 0)"
./bin/gah update-skills "$SK" --force >/dev/null 2>&1
out="$(PATH="$WORK/fakebin:$PATH" GAH_SKILLS_DIR="$SK/skills" GAH_SKIP_SETUP=1 ./bin/gah 2>&1 >/dev/null)"
check "and says nothing once it is current" \
	"$(printf '%s' "$out" | grep -q 'behind this checkout' && echo 0 || echo 1)"

# A deployment that removed both starters has decided, and is not nagged forever.
NONE="$WORK/no-starters"
./bin/gah init "$NONE" >/dev/null 2>&1
rm -rf "$NONE/skills/onboarding" "$NONE/skills/skill-authoring" "$NONE/setup"
printf 'scaffold 0000000\n' >"$NONE/.skills-scaffold"
mkdir -p "$NONE/skills/only-theirs"
printf -- '---\nname: only-theirs\ndescription: Theirs. Use when testing.\n---\nx\n' >"$NONE/skills/only-theirs/SKILL.md"
out="$(PATH="$WORK/fakebin:$PATH" GAH_SKILLS_DIR="$NONE/skills" GAH_SKIP_SETUP=1 ./bin/gah 2>&1 >/dev/null)"
check "a repository that kept none of the starters is never nagged" \
	"$(printf '%s' "$out" | grep -q 'behind this checkout' && echo 0 || echo 1)"

if command -v pwsh >/dev/null 2>&1; then
	echo
	echo "-- PowerShell twin (pwsh present) --"
	PS_SK="$WORK/skills-ps"
	pwsh -NoProfile -File ./bin/gah.ps1 init "$PS_SK" >/dev/null 2>&1
	check "init writes the same marker as its twin" \
		"$([ "$(cat "$PS_SK/.skills-scaffold")" = "$(cat "$SK/.skills-scaffold")" ] && echo 1 || echo 0)"
	git -C "$PS_SK" init -q -b main .
	git -C "$PS_SK" config user.name "Tech"; git -C "$PS_SK" config user.email "t@example.com"
	mkdir -p "$PS_SK/skills/their-own"
	printf -- '---\nname: their-own\ndescription: Theirs. Use when testing.\n---\ntheirs\n' >"$PS_SK/skills/their-own/SKILL.md"
	git -C "$PS_SK" add -A >/dev/null 2>&1; git -C "$PS_SK" commit -qm init >/dev/null 2>&1
	printf 'scaffold 0000000\n' >"$PS_SK/.skills-scaffold"
	git -C "$PS_SK" add -A >/dev/null 2>&1; git -C "$PS_SK" commit -qm stale >/dev/null 2>&1
	pwsh -NoProfile -File ./bin/gah.ps1 update-skills "$PS_SK" >"$WORK/ps-u.out" 2>&1
	check_eq "update-skills.ps1 succeeds" "0" "$?"
	check "it refreshes the starters" "$(grep -q 'skills/skill-authoring' "$WORK/ps-u.out" && echo 1 || echo 0)"
	check "their own skill survives" "$([ -f "$PS_SK/skills/their-own/SKILL.md" ] && echo 1 || echo 0)"
	pwsh -NoProfile -File ./bin/gah.ps1 update-skills "$PS_SK" >"$WORK/ps-u2.out" 2>&1
	check "a second run says it is already current" "$(grep -qi 'already current' "$WORK/ps-u2.out" && echo 1 || echo 0)"
	printf 'uncommitted\n' >>"$PS_SK/skills/their-own/SKILL.md"
	printf 'scaffold 0000000\n' >"$PS_SK/.skills-scaffold"
	pwsh -NoProfile -File ./bin/gah.ps1 update-skills "$PS_SK" >/dev/null 2>&1
	check_eq "and refuses a dirty tree" "3" "$?"
else
	echo
	echo "-- PowerShell twin: SKIPPED (no pwsh on PATH) --"
fi

echo
if [ "$fail" -eq 0 ]; then echo "skills scaffold: OK"; else echo "skills scaffold: FAILED" >&2; fi
exit "$fail"
