#!/usr/bin/env bash
# Configure the inference endpoint for this deployment.
#
# Setup steps run before the TUI on every launch and are idempotent: this exits
# immediately once models.json exists, so it costs nothing after the first run.
# To reconfigure or rotate the key, delete the file and relaunch.
#
# The key is collected here, in the terminal, so it is never part of a prompt, a
# transcript, or anything the model can read back -- and it is written straight
# into models.json, because a key stored anywhere else is a second step the user
# has to discover on their own, after launch, from an error that does not name
# it. One prompt, one file, models work on the first run.
set -euo pipefail

AGENT_DIR="${GAH_CODING_AGENT_DIR:-$HOME/.gah/agent}"
MODELS_JSON="$AGENT_DIR/models.json"

[ -f "$MODELS_JSON" ] && exit 0
[ -t 0 ] || exit 0   # non-interactive (cron, CI): skip rather than hang

# Backslash and double-quote are the only characters that can break a JSON
# string literal here; everything else in a key is passed through untouched.
json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

echo
echo "No inference endpoint is configured yet."
echo "Leave the URL blank to skip — you can rerun this by deleting $MODELS_JSON."
echo
read -r -p "  Base URL (e.g. https://api.example.com/openai/v1): " BASE_URL
[ -z "$BASE_URL" ] && { echo "  skipped"; exit 0; }
read -r -p "  Provider id [corp]: " PROVIDER_ID
PROVIDER_ID="${PROVIDER_ID:-corp}"
read -r -p "  Model ids, comma-separated (e.g. gpt-4.1,gpt-5): " MODEL_IDS
read -r -s -p "  API key: " API_KEY
echo

mkdir -p "$AGENT_DIR"
umask 077
{
  printf '{\n  "providers": {\n    "%s": {\n' "$(json_escape "$PROVIDER_ID")"
  printf '      "name": "%s",\n      "api": "openai-completions",\n' "$(json_escape "$PROVIDER_ID")"
  printf '      "baseUrl": "%s",\n' "$(json_escape "$BASE_URL")"
  [ -n "$API_KEY" ] && printf '      "apiKey": "%s",\n' "$(json_escape "$API_KEY")"
  printf '      "models": [\n'
  first=1
  IFS=',' read -ra IDS <<< "$MODEL_IDS"
  for id in "${IDS[@]}"; do
    id="$(echo "$id" | xargs)"; [ -z "$id" ] && continue
    [ $first -eq 0 ] && printf ',\n'; first=0
    printf '        { "id": "%s", "input": ["text"] }' "$(json_escape "$id")"
  done
  printf '\n      ]\n    }\n  }\n}\n'
} > "$MODELS_JSON"
chmod 600 "$MODELS_JSON"
# Record whether a key was stored before dropping it from the environment.
had_key=0; [ -n "$API_KEY" ] && had_key=1
unset API_KEY

echo
echo "  wrote $MODELS_JSON (0600)"
if [ "$had_key" -eq 0 ]; then
  echo "  No key stored — add \"apiKey\" to that file, or run /login in the agent."
fi
echo "  If your endpoint uses the Responses API, change api to openai-responses."
