#!/usr/bin/env bash
# Seed the studio app's connection to the agent-workflows image door.
#
# Writes gateway.baseUrl + gateway.token into ~/Pictures/ImageGen/.imagegen/settings.json, merging
# into whatever is already there. Both values live on the mini (the dev host) and are read over ssh:
#   base URL  https://agw-image.<DEV_DOMAIN>/door/image   DEV_DOMAIN from ~/.config/caddy-tailnet.conf
#   token     the `studio` line of ~/.agent-workflows/data/door-tokens (`name=token`)
# Overrides, for a human who has them: AGW_DOOR_URL, AGW_DOOR_TOKEN (each skips its ssh read).
# The remote files are filtered on the mini, so only the one wanted line crosses the wire: the conf
# also names a Cloudflare token path and is never sourced. The token is never printed.
set -euo pipefail
umask 077

SETTINGS="$HOME/Pictures/ImageGen/.imagegen/settings.json"
MINI_CONF='~/.config/caddy-tailnet.conf'
MINI_TOKENS='~/.agent-workflows/data/door-tokens'

fail() { printf '✗ %s\n' "$*" >&2; exit 1; }

# remote_line <sed-script> <remote-file>: first matching value, CR/whitespace/quotes stripped.
remote_line() {
  ssh -o BatchMode=yes -o ConnectTimeout=10 mini "sed -n '$1' $2" 2>/dev/null \
    | head -n 1 | tr -d '\r' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/" \
    || true
}

URL="${AGW_DOOR_URL:-}"
if [ -z "$URL" ]; then
  DOMAIN=$(remote_line 's/^DEV_DOMAIN=//p' "$MINI_CONF")
  [ -n "$DOMAIN" ] || fail "could not read DEV_DOMAIN from $MINI_CONF on the mini (ssh mini). Check: ssh mini \"grep '^DEV_DOMAIN=' $MINI_CONF\" -- or pass AGW_DOOR_URL=https://agw-image.<dev-domain>/door/image"
  [[ $DOMAIN =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] || fail "DEV_DOMAIN read from the mini is not a plain hostname; fix $MINI_CONF or pass AGW_DOOR_URL"
  URL="https://agw-image.$DOMAIN/door/image"
fi
URL="${URL%/}"

TOKEN="${AGW_DOOR_TOKEN:-}"
if [ -z "$TOKEN" ]; then
  TOKEN=$(remote_line 's/^studio=//p' "$MINI_TOKENS")
  [ -n "$TOKEN" ] || fail "could not read the studio token from $MINI_TOKENS on the mini (ssh mini). Check the line exists: ssh mini \"grep -c '^studio=' $MINI_TOKENS\" -- or pass AGW_DOOR_TOKEN"
fi

mkdir -p "$(dirname "$SETTINGS")"
URL="$URL" TOKEN="$TOKEN" SETTINGS="$SETTINGS" bun -e '
const { existsSync, readFileSync, writeFileSync, renameSync, chmodSync } = require("node:fs")
const path = process.env.SETTINGS
let current = {}
if (existsSync(path)) {
  try {
    current = JSON.parse(readFileSync(path, "utf8"))
  } catch {
    console.error(`✗ ${path} is not valid JSON; fix or move it, then re-run (left untouched).`)
    process.exit(1)
  }
  if (typeof current !== "object" || current === null || Array.isArray(current)) {
    console.error(`✗ ${path} is not a JSON object; fix or move it, then re-run (left untouched).`)
    process.exit(1)
  }
}
// A v1 flat { baseUrl, token } is the gateway connection itself; the nested one replaces it.
const { baseUrl: _v1Url, token: _v1Token, ...rest } = current
const gateway = typeof rest.gateway === "object" && rest.gateway !== null ? rest.gateway : {}
const merged = { ...rest, gateway: { ...gateway, baseUrl: process.env.URL, token: process.env.TOKEN } }
const tmp = `${path}.tmp-${process.pid}`
writeFileSync(tmp, JSON.stringify(merged, null, 2) + "\n", { mode: 0o600 })
chmodSync(tmp, 0o600)
renameSync(tmp, path)
' || fail "could not write $SETTINGS"
chmod 600 "$SETTINGS"
echo "✓ wrote $SETTINGS (chmod 600): door $URL — restart the app to pick it up"
