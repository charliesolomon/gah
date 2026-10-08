#!/usr/bin/env bash
# gah.sh - packaged GAH launcher for Linux (RHEL 9 and similar). Lives inside the
# installed package directory next to deploy.json, and is started through
# <root>/gah-launch (which reads current.txt, so updates survive) by the `gah`
# command and the desktop entry the installer writes.
#
# The bash twin of gah.ps1, step for step. On every launch: check the GitLab
# package registry for a newer package and switch to it; fetch the skills
# repository as an archive when its branch head moved; run the repository's
# setup/NN-*.sh steps; export the deployment's environment; start the agent. The
# launcher carries no policy of its own -- the policy pack baked into
# gah-policy/ is force-loaded by the binary (patch 0020) and the environment
# below only says what the admin decided in gah-deploy.json.
#
# Needs: bash, node 22+, curl, tar, sha256sum, and unzip or python3 (RHEL 9
# ships python3, so a minimal install without unzip still updates).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # <root>/<package>
ROOT="$(dirname "$HERE")"                               # ~/.local/share/gah
warn() { echo "gah: $*" >&2; }

# The subcommand is not necessarily the first argument: a wrapper commonly
# injects flags ahead of the person's own (`gah() { gah-launch --skill <dir> "$@"; }`),
# so find the first bare token from the list, ignoring one that is the value of
# a preceding flag (`--skill init-kb` names a directory, not a subcommand).
#
# Recognised here only so they can be refused: the templates they copy are not
# shipped in a package. Deliberately NOT published as GAH_SCAFFOLD_COMMANDS --
# that variable tells --help what this launcher can do, and the honest answer
# here is nothing. Cleared rather than left alone, so a value inherited from a
# checkout in the same shell cannot make this package's help advertise commands
# it refuses. Keep this list in step with bin/gah; check-skills.sh asserts it.
SCAFFOLD_COMMANDS="init init-kb update-kb update-skills"
export GAH_SCAFFOLD_COMMANDS=""

subcommand=""
prev=""
for arg in "$@"; do
	for known in $SCAFFOLD_COMMANDS; do
		if [ "$arg" = "$known" ] && [ "${prev#-}" = "$prev" ]; then subcommand="$arg"; break 2; fi
	done
	prev="$arg"
done
if [ -n "$subcommand" ]; then
	cat >&2 <<EOF
gah: '$subcommand' creates or refreshes a repository and is only available in a
gah checkout, not in an installed package. From a checkout:

  bin/gah $subcommand <directory>

Your administrator normally does this once for the organisation and shares the
result; see docs/SKILLS.md and docs/KB.md in the gah repository.
EOF
	exit 2
fi

info_only=0
for arg in "$@"; do
	case "$arg" in --help | -h | --version | -v) info_only=1 ;; esac
done

# --- deploy.json, read once by node (which the agent needs anyway) -------------
# Prints shell assignments with every value single-quoted, so nothing in the
# file is ever evaluated as code.
read_deploy() {
	node - "$1" <<'JS'
const d = JSON.parse(require("fs").readFileSync(process.argv[2], "utf8"));
const q = (v) => `'${String(v ?? "").replaceAll("'", "'\\''")}'`;
const out = {
	D_VERSION: d.version,
	D_PACKAGE_NAME: d.packageName,
	D_GITLAB: String(d.gitlab?.url ?? "").replace(/\/+$/, ""),
	D_PROJECT: d.gitlab?.project,
	D_PACKAGE: d.gitlab?.package,
	D_PROXY: d.gitlab?.proxy,
	D_SKILLS_PROJECT: d.skills?.project,
	D_SKILLS_BRANCH: d.skills?.branch ?? "main",
};
for (const [k, v] of Object.entries(out)) console.log(`${k}=${q(v)}`);
const env = Object.entries(d.env ?? {}).filter(([k]) => /^GAH_[A-Z0-9_]+$/.test(k));
console.log(`D_ENV_KEYS=${q(env.map(([k]) => k).join(" "))}`);
for (const [k, v] of env) console.log(`D_ENV_${k}=${q(v)}`);
JS
}
assignments="$(read_deploy "$HERE/deploy.json")" || { warn "cannot read $HERE/deploy.json"; exit 1; }
eval "$assignments"

# --- Stored secrets --------------------------------------------------------------
# The installer keeps the GitLab token, the client-certificate paths and any
# API keys in one 0600 file (Windows keeps them as user environment variables).
# A variable already set in the environment wins. Read as KEY=value lines, never
# sourced. The policy is told to hide the file from the model below.
SECRETS="${XDG_CONFIG_HOME:-$HOME/.config}/gah/secrets.env"
if [ -f "$SECRETS" ]; then
	while IFS= read -r line || [ -n "$line" ]; do
		case "$line" in '' | '#'*) continue ;; esac
		k="${line%%=*}"; v="${line#*=}"
		[[ "$k" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
		[ -n "${!k:-}" ] || export "$k=$v"
	done <"$SECRETS"
fi

# --- GitLab access: curl with the token, proxy and client certificate ------------
# Proxy: gitlab.proxy forces a URL, "none" forces a direct connection, null
# leaves it to curl, which honours HTTPS_PROXY / https_proxy and NO_PROXY.
# Trust: curl uses the system store (/etc/pki on RHEL), where a managed
# machine's corporate CA already is.
CURL=(curl --silent --show-error --fail --location --connect-timeout 20)
[ -n "${GAH_GITLAB_TOKEN:-}" ] && CURL+=(--header "PRIVATE-TOKEN: $GAH_GITLAB_TOKEN")
case "$D_PROXY" in
	"") ;;
	none) CURL+=(--noproxy '*') ;;
	*) CURL+=(--proxy "$D_PROXY") ;;
esac
[ -n "${GAH_GITLAB_CLIENT_CERT:-}" ] && CURL+=(--cert "$GAH_GITLAB_CLIENT_CERT")
[ -n "${GAH_GITLAB_CLIENT_KEY:-}" ] && CURL+=(--key "$GAH_GITLAB_CLIENT_KEY")
enc() { node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$1"; }
# curl's one-line reason for the last failure, for the warning that follows it.
ERR_FILE="$(mktemp)"
trap 'rm -f "$ERR_FILE"' EXIT
why() { tr '\n' ' ' <"$ERR_FILE" | sed 's/ *$//'; }
api() { "${CURL[@]}" --max-time 20 "$D_GITLAB/api/v4/$1" 2>"$ERR_FILE"; }
fetch() { "${CURL[@]}" --max-time 300 --output "$2" "$1" 2>"$ERR_FILE"; }
# Evaluates a JS expression over the JSON in $1, bound to d; prints the result.
# A body that is not JSON (a proxy's error page) is a failure with a reason.
json() {
	node -e '
try { const v = new Function("d", `return (${process.argv[2]})`)(JSON.parse(process.argv[1])); if (v != null) process.stdout.write(String(v)); }
catch { process.stderr.write("GitLab answered with something that is not JSON"); process.exit(1); }' "$1" "$2" 2>"$ERR_FILE"
}
# Version order as PowerShell's [version] sees it, so both launchers agree on
# what "newer" means: digits and dots, two to four parts, a missing part below
# zero (1.0 < 1.0.0). Anything else is not a version and never wins.
newer() {
	node -e '
const p = (s) => (/^\d+(\.\d+){1,3}$/.test(s) ? s.split(".").map(Number) : null);
const [a, b] = [p(process.argv[1]), p(process.argv[2])];
if (!a || !b) process.exit(1);
for (let i = 0; i < 4; i++) { const x = a[i] ?? -1, y = b[i] ?? -1; if (x !== y) process.exit(x > y ? 0 : 1); }
process.exit(1);' "$1" "$2"
}
unpack_zip() {
	mkdir -p "$2"
	if command -v unzip >/dev/null 2>&1; then unzip -q -o "$1" -d "$2"
	else python3 -m zipfile -e "$1" "$2"; fi
}

# --- 1. Self-update --------------------------------------------------------------
# Newest published version of this package; switch to it and re-launch from it.
# Any failure here is a warning: the installed version keeps working.
self_update() {
	local proj body latest slug new dl zip base want got stage
	proj="$(enc "$D_PROJECT")"
	# The newest 100 by publication date, and the highest of those in the order
	# newer() uses, rather than trusting the registry's own version sort (the
	# same rule as gah.ps1). Versions that do not parse are skipped.
	body="$(api "projects/$proj/packages?package_name=$(enc "$D_PACKAGE")&order_by=created_at&sort=desc&per_page=100")" || return 1
	latest="$(json "$body" "(() => {
		const name = $(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$D_PACKAGE");
		const parse = (s) => (/^\\d+(\\.\\d+){1,3}\$/.test(s) ? s.split('.').map(Number) : null);
		const gt = (a, b) => { for (let i = 0; i < 4; i++) { const x = a[i] ?? -1, y = b[i] ?? -1; if (x !== y) return x > y; } return false; };
		let best = null;
		for (const p of d) { const v = p.name === name ? parse(String(p.version)) : null; if (v && (!best || gt(v, best.v))) best = { v, s: p.version }; }
		return best?.s;
	})()")" || return 1
	[ -n "$latest" ] && newer "$latest" "$D_VERSION" || return 0
	slug="${D_PACKAGE_NAME%-"$D_VERSION"}"
	new="$slug-$latest"
	dl="$ROOT/downloads"; mkdir -p "$dl"
	zip="$dl/$new.zip"
	base="$D_GITLAB/api/v4/projects/$proj/packages/generic/$D_PACKAGE/$latest"
	echo "gah: updating to $latest ..."
	fetch "$base/$new.zip" "$zip" && fetch "$base/$new.zip.sha256" "$zip.sha256" || return 1
	want="$(awk '{print tolower($1); exit}' "$zip.sha256")"
	got="$(sha256sum "$zip" | awk '{print $1}')"
	[ "$want" = "$got" ] || { echo "checksum mismatch for $new.zip" >"$ERR_FILE"; return 1; }
	stage="$dl/stage-$latest"
	rm -rf "$stage"
	unpack_zip "$zip" "$stage" 2>"$ERR_FILE" || return 1
	[ -f "$stage/$new/gah.sh" ] || { echo "package $new has no launcher" >"$ERR_FILE"; return 1; }
	rm -rf "${ROOT:?}/$new"
	mv "$stage/$new" "$ROOT/$new" || return 1
	rm -rf "$stage" "$zip" "$zip.sha256"
	# The new package's installer unpacks its own tools and rewrites current.txt.
	bash "$ROOT/$new/install.sh" --update || { echo "the new package's installer failed" >"$ERR_FILE"; return 1; }
	UPDATED_TO="$ROOT/$new"
}
UPDATED_TO=""
if [ "$info_only" -eq 0 ] && [ -z "${GAH_NO_UPDATE:-}" ]; then
	self_update || warn "update check failed - continuing with $D_VERSION ($(why))"
	if [ -n "$UPDATED_TO" ]; then
		export GAH_NO_UPDATE=1
		rm -f "$ERR_FILE"
		exec bash "$UPDATED_TO/gah.sh" "$@"
	fi
fi

# --- 2. Skills: the repository as an archive at its branch head --------------------
SKILLS_ROOT="$ROOT/skills"
CURRENT_FILE="$SKILLS_ROOT/current.txt"
CURRENT="$(cat "$CURRENT_FILE" 2>/dev/null | tr -d '[:space:]')"
sync_skills() {
	local sproj body head tmp top
	sproj="$(enc "$D_SKILLS_PROJECT")"
	body="$(api "projects/$sproj/repository/branches/$(enc "$D_SKILLS_BRANCH")")" || return 1
	head="$(json "$body" 'd.commit?.id')" || return 1
	[ -n "$head" ] && [ "$head" != "$CURRENT" ] || return 0
	tmp="$SKILLS_ROOT/tmp-$head"
	rm -rf "$tmp"; mkdir -p "$tmp/x"
	fetch "$D_GITLAB/api/v4/projects/$sproj/repository/archive.tar.gz?sha=$head" "$tmp/repo.tar.gz" || return 1
	tar -xzf "$tmp/repo.tar.gz" -C "$tmp/x" 2>"$ERR_FILE" || return 1
	top="$(find "$tmp/x" -mindepth 1 -maxdepth 1 -type d)"
	[ "$(printf '%s\n' "$top" | grep -c .)" -eq 1 ] || { echo "unexpected archive layout" >"$ERR_FILE"; return 1; }
	rm -rf "${SKILLS_ROOT:?}/$head"
	mv "$top" "$SKILLS_ROOT/$head" || return 1
	rm -rf "$tmp"
	printf '%s' "$head" >"$CURRENT_FILE"
	[ -n "$CURRENT" ] && [ -d "$SKILLS_ROOT/$CURRENT" ] && rm -rf "${SKILLS_ROOT:?}/$CURRENT"
	CURRENT="$head"
	echo "gah: skills updated to ${head:0:8}"
}
if [ "$info_only" -eq 0 ]; then
	mkdir -p "$SKILLS_ROOT"
	sync_skills || warn "skills update failed - continuing with the local copy ($(why))"
fi
SKILLS=""
[ -n "$CURRENT" ] && SKILLS="$SKILLS_ROOT/$CURRENT"
if [ "$info_only" -eq 0 ] && ! { [ -n "$SKILLS" ] && [ -d "$SKILLS/skills" ]; } && [ -z "${GAH_ALLOW_NO_SKILLS:-}" ]; then
	warn "no skills available (repository $D_SKILLS_PROJECT could not be fetched). Check GAH_GITLAB_TOKEN and try again."
	exit 1
fi

# --- 3. Environment: what the admin decided, nothing else ---------------------------
for k in $D_ENV_KEYS; do v="D_ENV_$k"; export "$k=${!v}"; done
export GAH_BUILTIN_MODELS="${GAH_BUILTIN_MODELS-}"
export GAH_ALLOWED_HOSTS="${GAH_ALLOWED_HOSTS-}"
export GAH_ALLOW_MODELS_JSON=""                         # the endpoint is baked; models.json would route around it
export GAH_PROVIDERS_FILE="$HERE/gah-policy/providers.json"
export PATH="$HERE/bin:$PATH"                           # fd, rg
# The secrets file is readable by this user, and so by the agent's read tool;
# name it as a secret store so the policy refuses it and redacts its values.
[ -f "$SECRETS" ] && export GAH_SECRET_FILES="${GAH_SECRET_FILES:+$GAH_SECRET_FILES:}$SECRETS"
# Node carries its own CA list, not the system's: behind a TLS-inspecting proxy
# or with an internal CA on the inference endpoint, it would refuse what curl
# accepts. Add the system bundle unless the machine already chose something.
if [ -z "${NODE_EXTRA_CA_CERTS:-}" ] && [ -f /etc/pki/tls/certs/ca-bundle.crt ]; then
	export NODE_EXTRA_CA_CERTS=/etc/pki/tls/certs/ca-bundle.crt
fi

# --- 4. Setup steps from the skills repository ------------------------------------
if [ "$info_only" -eq 0 ] && [ -n "$SKILLS" ] && [ -z "${GAH_SKIP_SETUP:-}" ] && [ -d "$SKILLS/setup" ]; then
	for step in "$SKILLS/setup"/[0-9]*.sh; do
		[ -e "$step" ] || continue
		bash "$step" || warn "setup step $(basename "$step") failed - continuing"
	done
fi

# --- 5. Start -------------------------------------------------------------------
skill_args=()
if [ -n "$SKILLS" ]; then
	skill_args+=(--no-skills --skill "$SKILLS/skills")
	[ -d "$SKILLS/prompts" ] && skill_args+=(--prompt-template "$SKILLS/prompts")
fi
# The knowledge base (optional, docs/KB.md). Unlike the skills repository it is
# NOT fetched as an archive: it is the one thing the agent writes to, so it has
# to be a real git clone the person owns, named by GAH_KB_DIR. Loaded after the
# organisation's skills, so a shared skill of the same name wins.
if [ -n "${GAH_KB_DIR:-}" ]; then
	if [ -d "$GAH_KB_DIR/skills" ]; then
		skill_args+=(--skill "$GAH_KB_DIR/skills")
		[ -d "$GAH_KB_DIR/prompts" ] && skill_args+=(--prompt-template "$GAH_KB_DIR/prompts")
	elif [ "$info_only" -eq 0 ]; then
		warn "GAH_KB_DIR=$GAH_KB_DIR has no skills/ - knowledge base not loaded"
	fi
fi
rm -f "$ERR_FILE"
exec node "$HERE/bundle/cli.js" --no-extensions "${skill_args[@]}" "$@"
