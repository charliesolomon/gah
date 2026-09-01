#!/usr/bin/env bash
# Collect the inference API key.
#
# Runs in the terminal before the agent starts, so the key is never part of a
# prompt, a transcript, or anything the model can read back. Idempotent: exits
# once a key is present.
set -euo pipefail

AGENT_DIR="${GAH_AGENT_DIR:-$HOME/.gah/agent}"
MODELS_JSON="$AGENT_DIR/models.json"
KEY_FILE="$AGENT_DIR/provider-key"

[ -f "$MODELS_JSON" ] || exit 0        # nothing configured to hold a key
[ -f "$KEY_FILE" ] && exit 0
[ -t 0 ] || exit 0

echo
read -r -s -p "  API key for your inference endpoint (blank to skip): " KEY
echo
[ -z "$KEY" ] && { echo "  skipped"; exit 0; }

umask 077
printf '%s' "$KEY" > "$KEY_FILE"
unset KEY

echo "  stored in $KEY_FILE (0600)"
echo
echo "  Reference it from models.json as the provider's apiKey, or export it"
echo "  from your shell profile. Storing it outside models.json keeps the key"
echo "  out of any config you might copy, paste, or attach to an issue."
