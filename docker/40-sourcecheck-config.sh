#!/bin/sh
# Writes config.js and the Content-Security-Policy from environment variables at container start.
set -e
ROOT=/usr/share/nginx/html
AI="${AI_ENABLED:-false}"
case "$AI" in true|1|yes) AI=true ;; *) AI=false ;; esac
LABEL=$(printf '%s' "${ENVIRONMENT_LABEL:-}" | sed 's/\\/\\\\/g; s/"/\\"/g')

cat > "$ROOT/config.js" <<CFG
window.SC_CONFIG = { pdfjsBase: './vendor/', aiEnabled: $AI, environmentLabel: "$LABEL" };
CFG

CONNECT="'self'"
[ "$AI" = true ] && CONNECT="'self' https://api.anthropic.com"
CSP="default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src $CONNECT; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'"
sed -i "s|__CSP__|$CSP|" /etc/nginx/conf.d/default.conf
echo "sourcecheck: AI_ENABLED=$AI"
