#!/usr/bin/env bash
# Configure an OpenAI-compatible inference endpoint for this deployment.
#
# Setup steps run before the TUI on every launch and are idempotent: this exits
# immediately once models.json exists, so it costs nothing after the first run.
#
# models.json defines providers with their own baseUrl, apiKey and headers, so
# it bypasses the built-in-catalogue allowlist by design. GAH therefore refuses
# to read it unless GAH_ALLOW_MODELS_JSON=1 — set that in the environment or the
# deployment manifest, not here, so the decision stays visible.
set -euo pipefail

AGENT_DIR="${GAH_AGENT_DIR:-$HOME/.gah/agent}"
MODELS_JSON="$AGENT_DIR/models.json"

[ -f "$MODELS_JSON" ] && exit 0
[ -t 0 ] || exit 0   # non-interactive (cron, CI): skip rather than hang

echo
echo "No inference endpoint is configured yet."
echo "Leave the URL blank to skip — you can rerun this by deleting $MODELS_JSON."
echo
read -r -p "  Base URL (e.g. https://api.example.com/openai/v1): " BASE_URL
[ -z "$BASE_URL" ] && { echo "  skipped"; exit 0; }
read -r -p "  Provider id [corp]: " PROVIDER_ID
PROVIDER_ID="${PROVIDER_ID:-corp}"
read -r -p "  Model ids, comma-separated (e.g. gpt-4.1,gpt-5): " MODEL_IDS

mkdir -p "$AGENT_DIR"
{
  printf '{\n  "providers": {\n    "%s": {\n' "$PROVIDER_ID"
  printf '      "name": "%s",\n      "api": "openai-completions",\n' "$PROVIDER_ID"
  printf '      "baseUrl": "%s",\n      "models": [\n' "$BASE_URL"
  first=1
  IFS=',' read -ra IDS <<< "$MODEL_IDS"
  for id in "${IDS[@]}"; do
    id="$(echo "$id" | xargs)"; [ -z "$id" ] && continue
    [ $first -eq 0 ] && printf ',\n'; first=0
    printf '        { "id": "%s", "input": ["text"] }' "$id"
  done
  printf '\n      ]\n    }\n  }\n}\n'
} > "$MODELS_JSON"
chmod 600 "$MODELS_JSON"

echo
echo "  wrote $MODELS_JSON"
echo "  No API key is stored in it — the next step collects that separately."
echo "  If your endpoint uses the Responses API, change api to openai-responses."
