#!/bin/bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl rsync git caddy
command -v node >/dev/null || { curl -fsSL https://deb.nodesource.com/setup_24.x | bash -; apt-get install -y nodejs; }
command -v ufw >/dev/null && ufw allow 80/tcp >/dev/null && ufw allow 443/tcp >/dev/null
mkdir -p /var/lib/verify
cd /opt/verify && npm install --omit=dev --no-audit --no-fund --workspace @verify/control
cat > /etc/systemd/system/verify-control.service <<'UNIT'
[Unit]
Description=verify control
After=network-online.target
Wants=network-online.target

[Service]
EnvironmentFile=/etc/verify-control.env
WorkingDirectory=/opt/verify/packages/control
ExecStart=/usr/bin/node server.ts
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
host=$(grep '^PUBLIC_HOST=' /etc/verify-control.env | cut -d= -f2)
cat > /etc/caddy/Caddyfile <<CADDY
${host} {
  encode gzip
  reverse_proxy 127.0.0.1:7300
}
CADDY
systemctl daemon-reload
systemctl enable verify-control
systemctl restart verify-control
systemctl reload caddy || systemctl restart caddy
echo "control ready at https://${host}"
