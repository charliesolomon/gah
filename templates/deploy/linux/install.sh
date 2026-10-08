#!/usr/bin/env bash
# install.sh - install (or update) a GAH deployment package for the current
# Linux user. Run it from inside the unpacked package folder:
#
#   ./install.sh [--no-prompt] [--no-desktop]
#
# The twin of Install-Gah.ps1. Copies the package to ~/.local/share/gah/<package>,
# verifies and unpacks the pinned fd/ripgrep archives, stores the GitLab token,
# the client certificate's paths and any API keys the deployment collects in
# ~/.config/gah/secrets.env (0600), writes current.txt and the stable launcher
# stub, puts a `gah` command in ~/.local/bin (replacing the `gg` of older
# packages) and an entry in the applications menu. Idempotent: rerun to repair. --update is what the launcher passes when
# it has already placed a newer package and only needs it finalised.
#
# Non-interactive use: --no-prompt, with GAH_GITLAB_TOKEN and the deployment's
# API-key variables in the environment; whatever is set there is stored.
#
# Needs: bash, node 22+, curl, tar, sha256sum, and unzip or python3.
set -euo pipefail

UPDATE=0 NO_PROMPT=0 NO_DESKTOP=0
for a in "$@"; do
	case "$a" in
		--update) UPDATE=1 ;;
		--no-prompt) NO_PROMPT=1 ;;
		--no-desktop) NO_DESKTOP=1 ;;
		-h | --help) sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
		*) echo "install.sh: unknown argument $a" >&2; exit 2 ;;
	esac
done
[ -t 0 ] || NO_PROMPT=1

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/gah"
SECRETS_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/gah"
SECRETS="$SECRETS_DIR/secrets.env"
BIN_DIR="$HOME/.local/bin"
ok() { echo "  OK: $*"; }
warn() { echo "  ! $*" >&2; }
die() { echo "$*" >&2; exit 1; }

# --- Prerequisites ------------------------------------------------------------
node_version="$(node --version 2>/dev/null || true)"
major="${node_version#v}"; major="${major%%.*}"
if [ -z "$node_version" ] || ! [ "$major" -ge 22 ] 2>/dev/null; then
	die "Node.js 22 or newer is required and was not found on PATH (got '${node_version}').
On RHEL 9:  sudo dnf module enable nodejs:22 && sudo dnf install nodejs   then run this installer again."
fi
for tool in curl tar sha256sum; do command -v "$tool" >/dev/null || die "$tool is required and was not found on PATH."; done
command -v unzip >/dev/null || command -v python3 >/dev/null || die "unzip or python3 is required to apply updates."

# deploy.json, read by node; values single-quoted for the shell.
eval "$(node - "$SRC/deploy.json" <<'JS'
const d = JSON.parse(require("fs").readFileSync(process.argv[2], "utf8"));
const q = (v) => `'${String(v ?? "").replaceAll("'", "'\\''")}'`;
const out = {
	D_NAME: d.packageName, D_SHORTCUT: d.shortcutName, D_GAH: d.gahVersion, D_GITLAB: d.gitlab?.url,
	D_CLIENT_CERT: d.gitlab?.clientCert,
	D_ENV_PROVIDERS: (d.providersEnv ?? []).map((e) => `${e.provider}=${e.variable}`).join(" "),
	D_LOGIN_PROVIDERS: (d.providersLogin ?? []).join(" "),
};
for (const [k, v] of Object.entries(out)) console.log(`${k}=${q(v)}`);
JS
)"
DEST="$ROOT/$D_NAME"

echo
echo "$D_SHORTCUT ($D_NAME, gah $D_GAH)"
echo
ok "node $node_version"

# --- Copy the package -------------------------------------------------------------
if [ "$SRC" != "$(cd "$DEST" 2>/dev/null && pwd || true)" ]; then
	mkdir -p "$ROOT"
	rm -rf "${DEST:?}"
	cp -a "$SRC" "$DEST"
fi
chmod +x "$DEST"/*.sh
ok "installed to $DEST"

# --- Tools: verify against the pinned checksums, then unpack ----------------------------
mkdir -p "$DEST/bin"
case "$(uname -m)" in aarch64 | arm64) arch=aarch64 ;; *) arch=x86_64 ;; esac
found_tools=0
while read -r want asset; do
	[ -n "${want:-}" ] || continue
	case "$asset" in *"$arch"*) ;; *) continue ;; esac
	got="$(sha256sum "$DEST/tools/$asset" | awk '{print $1}')"
	[ "$got" = "$want" ] || die "checksum mismatch for $asset - refusing to install it"
	tmp="$(mktemp -d "$DEST/tools/x-XXXXXX")"
	tar -xzf "$DEST/tools/$asset" -C "$tmp"
	for exe in fd rg; do
		f="$(find "$tmp" -type f -name "$exe" | head -n 1)"
		if [ -n "$f" ]; then install -m 0755 "$f" "$DEST/bin/$exe"; ok "$exe ($asset)"; found_tools=$((found_tools + 1)); fi
	done
	rm -rf "$tmp"
done <"$DEST/tools/SHA256SUMS"
[ "$found_tools" -ge 2 ] || warn "no pinned fd/ripgrep for $arch in this package; the find and grep tools will not work"

# --- Secrets: one KEY=value file, 0600, never sourced ----------------------------------
get_secret() { if [ -f "$SECRETS" ]; then sed -n "s/^$1=//p" "$SECRETS" | tail -n 1; fi; }
set_secret() {
	case "$2" in *$'\n'*) die "a value for $1 contains a line break" ;; esac
	mkdir -p "$SECRETS_DIR"; chmod 700 "$SECRETS_DIR"
	(
		umask 077
		{ [ -f "$SECRETS" ] && grep -v "^$1=" "$SECRETS" || true; printf '%s=%s\n' "$1" "$2"; } >"$SECRETS.tmp"
	)
	mv "$SECRETS.tmp" "$SECRETS"
	chmod 600 "$SECRETS"
}
ask_secret() { # prompt variable
	local v=""
	read -r -s -p "  $1: " v </dev/tty; echo >&2
	printf '%s' "$v"
}

if [ "$UPDATE" -eq 0 ]; then
	# --- GitLab token (skippable: an internal-visible project needs none) --------------
	token="${GAH_GITLAB_TOKEN:-}"
	if [ -z "$token" ] && [ -n "$(get_secret GAH_GITLAB_TOKEN)" ]; then
		ok "GitLab token already stored"
	else
		[ -z "$token" ] && [ "$NO_PROMPT" -eq 0 ] && token="$(ask_secret "GitLab token for $D_GITLAB (read_api; Enter to skip)")"
		if [ -n "$token" ]; then set_secret GAH_GITLAB_TOKEN "$token"; ok "GitLab token stored in $SECRETS"
		else ok "no GitLab token (the project must be visible without one)"; fi
	fi
	unset token

	# --- Client certificate for a GitLab behind mutual TLS ------------------------------
	# A PEM certificate and key, as curl takes them. Default: what git already
	# uses for this GitLab (http.<url>.sslCert / sslKey).
	if [ "$D_CLIENT_CERT" = "user" ]; then
		cert="${GAH_GITLAB_CLIENT_CERT:-$(get_secret GAH_GITLAB_CLIENT_CERT)}"
		key="${GAH_GITLAB_CLIENT_KEY:-$(get_secret GAH_GITLAB_CLIENT_KEY)}"
		if [ -z "$cert" ]; then
			git_cert="$(git config --get-urlmatch http.sslcert "$D_GITLAB" 2>/dev/null || true)"
			git_key="$(git config --get-urlmatch http.sslkey "$D_GITLAB" 2>/dev/null || true)"
			if [ "$NO_PROMPT" -eq 0 ]; then
				echo "  GitLab requires a client certificate (PEM file; a combined cert+key file is fine)."
				read -r -p "  Certificate file [${git_cert:-none}]: " cert </dev/tty
				cert="${cert:-$git_cert}"
				read -r -p "  Private key file, if separate [${git_key:-none}]: " key </dev/tty
				key="${key:-$git_key}"
			else
				cert="$git_cert"; key="$git_key"
			fi
		fi
		cert="${cert/#\~/$HOME}"; key="${key/#\~/$HOME}"
		if [ -n "$cert" ] && [ -f "$cert" ]; then
			set_secret GAH_GITLAB_CLIENT_CERT "$cert"; ok "client certificate: $cert"
			if [ -n "$key" ] && [ -f "$key" ]; then set_secret GAH_GITLAB_CLIENT_KEY "$key"; ok "client key: $key"; fi
		else
			warn "this deployment needs a client certificate; GitLab calls will fail until GAH_GITLAB_CLIENT_CERT=<pem> is in $SECRETS"
		fi
	fi

	# --- API keys the deployment collects via environment variables ----------------------
	for pair in $D_ENV_PROVIDERS; do
		provider="${pair%%=*}"; var="${pair#*=}"
		if [ -n "${!var:-}" ]; then set_secret "$var" "${!var}"; ok "$provider: key stored from the environment ($var)"; continue; fi
		if [ -n "$(get_secret "$var")" ]; then ok "$provider: key already set ($var)"; continue; fi
		if [ "$NO_PROMPT" -eq 1 ]; then warn "$provider: put $var=<key> in $SECRETS before launching"; continue; fi
		k="$(ask_secret "API key for $provider")"
		if [ -n "$k" ]; then set_secret "$var" "$k"; ok "$provider: key stored ($var)"
		else warn "$provider: no key given; put $var=<key> in $SECRETS later"; fi
		unset k
	done
	for p in $D_LOGIN_PROVIDERS; do ok "$p: run /login in the agent on first start and paste your API key"; done
fi

# --- Make this the current package -------------------------------------------------------
printf '%s' "$D_NAME" >"$ROOT/current.txt"
cat >"$ROOT/gah-launch" <<'EOF'
#!/usr/bin/env bash
# gah-launch - stable entry point: runs the launcher of whichever package current.txt names.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bash "$ROOT/$(tr -d '[:space:]' <"$ROOT/current.txt")/gah.sh" "$@"
rc=$?
# From the applications menu the terminal would close before an error could be read.
if [ "$rc" -ne 0 ] && [ -n "${GAH_FROM_SHORTCUT:-}" ]; then echo; read -r -p "gah exited with code $rc. Press Enter to close" _; fi
exit "$rc"
EOF
chmod 755 "$ROOT/gah-launch"
install -m 0755 "$DEST/uninstall.sh" "$ROOT/uninstall.sh"
ok "current package: $D_NAME"

# --- gah command ---------------------------------------------------------------------------
# Also runs with --update, so an install from an older package, which named the
# command gg, moves to gah on the next automatic update. A gah that is not ours
# (a gah checkout's bin/gah linked here, say) is left alone.
marker="# gah deployment command"
ours() { [ -f "$1" ] && grep -qF "$marker" "$1"; }
mkdir -p "$BIN_DIR"
if [ -e "$BIN_DIR/gah" ] && ! ours "$BIN_DIR/gah"; then
	warn "$BIN_DIR/gah exists and is not ours; left alone. Start the assistant with $ROOT/gah-launch"
elif [ "$UPDATE" -eq 0 ] || [ -e "$BIN_DIR/gah" ] || ours "$BIN_DIR/gg"; then
	printf '#!/usr/bin/env bash\n%s\nexec "%s/gah-launch" "$@"\n' "$marker" "$ROOT" >"$BIN_DIR/gah"
	chmod 755 "$BIN_DIR/gah"
	if ours "$BIN_DIR/gg"; then
		rm -f "$BIN_DIR/gg"
		ok "the command is now 'gah' (was 'gg'): $BIN_DIR/gah"
	else
		ok "'gah' command: $BIN_DIR/gah"
	fi
	# Another gah earlier on PATH would win; say so rather than leave a puzzle.
	first="$(PATH="$PATH:$BIN_DIR" type -P gah || true)"
	[ -n "$first" ] && [ "$first" != "$BIN_DIR/gah" ] && warn "'gah' on your PATH is $first, which comes before $BIN_DIR/gah"
fi

if [ "$UPDATE" -eq 0 ]; then
	case ":$PATH:" in
		*":$BIN_DIR:"*) ;;
		*)
			path_marker="# gah deployment path"
			if ! grep -qF "$path_marker" "$HOME/.bashrc" 2>/dev/null; then
				printf '\nexport PATH="$HOME/.local/bin:$PATH"  %s\n' "$path_marker" >>"$HOME/.bashrc"
				ok "added ~/.local/bin to PATH in ~/.bashrc"
			fi
			;;
	esac

	# --- Applications menu entry ------------------------------------------------------------
	if [ "$NO_DESKTOP" -eq 0 ]; then
		apps="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
		mkdir -p "$apps"
		entry="$apps/${D_NAME%-*}.desktop"
		cat >"$entry" <<EOF
[Desktop Entry]
Type=Application
Name=$D_SHORTCUT
Comment=$D_SHORTCUT (gah)
Exec=env GAH_FROM_SHORTCUT=1 "$ROOT/gah-launch"
Path=$HOME
Terminal=true
Icon=utilities-terminal
Categories=Utility;
X-GAH-Deployment=true
EOF
		ok "applications menu entry: $D_SHORTCUT"
	fi

	echo
	echo "Done. Open a new terminal and type gah, or start '$D_SHORTCUT' from the applications menu."
	echo "The first launch fetches your organisation's skills from $D_GITLAB."
	echo "To remove everything later: $ROOT/uninstall.sh"
fi
