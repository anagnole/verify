#!/bin/bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl rsync git
command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh
command -v node >/dev/null || { curl -fsSL https://deb.nodesource.com/setup_24.x | bash -; apt-get install -y nodejs; }
docker build -t verify-base:latest /opt/verify/sandbox
[ -f /etc/verify-worker.env ] || cat > /etc/verify-worker.env <<ENV
CONTROL_URL=${CONTROL_URL:-http://localhost:7300}
WORKER_TOKEN=${WORKER_TOKEN:-dev-worker-token}
WORKER_NAME=$(hostname)
WORKER_REGION=${WORKER_REGION:-fra}
ENV
cat > /etc/systemd/system/verify-worker.service <<'UNIT'
[Unit]
Description=verify worker
After=docker.service network-online.target
Wants=network-online.target

[Service]
EnvironmentFile=/etc/verify-worker.env
WorkingDirectory=/opt/verify/packages/worker
ExecStart=/usr/bin/node worker.ts
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable verify-worker
systemctl restart verify-worker
echo "worker ready"
