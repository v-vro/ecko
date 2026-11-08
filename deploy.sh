#!/usr/bin/env bash
# Copy the app to the server and restart it. Run from the project folder (Git Bash): ./deploy.sh
# The server's own data/ and logs/ are kept. Server details live in .deploy.env (not committed):
#   DEPLOY_HOST=root@<server-ip>   DEPLOY_KEY=~/.ssh/<key>   DEPLOY_URL=https://<site>/phone
set -euo pipefail
[ -f .deploy.env ] && source .deploy.env
: "${DEPLOY_HOST:?set DEPLOY_HOST in .deploy.env}" "${DEPLOY_KEY:?set DEPLOY_KEY in .deploy.env}"
SSH=(ssh -F /dev/null -i "$DEPLOY_KEY" -o UserKnownHostsFile=~/.ssh/known_hosts) # -F: skip the local ssh config
tar -cf - server.js tiger.js tiger-ca.pem package.json package-lock.json node_modules .env public | "${SSH[@]}" "$DEPLOY_HOST" '
  set -e
  tar -xf - -C /opt/ecko && chown -R ecko:ecko /opt/ecko && chmod 600 /opt/ecko/.env
  systemctl restart ecko && sleep 1.5 && systemctl is-active ecko'
# 401 = up and asking for the site password.
[ -n "${DEPLOY_URL:-}" ] && curl -s -o /dev/null -w "live: %{http_code} (401 = up, password-protected)\n" "$DEPLOY_URL"
