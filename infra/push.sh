#!/bin/bash
set -euo pipefail
role=$1
ip=$2
root=$(cd "$(dirname "$0")/.." && pwd)
key="$HOME/.ssh/verify_vultr"
ssh_opts=(-i "$key" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15)
(cd "$root/packages/web" && npx vite build >/dev/null)
rsync -az --delete -e "ssh ${ssh_opts[*]}" \
  --exclude node_modules --exclude data --exclude .git --exclude CLAUDE.md --exclude PLAN.md --exclude docs/ \
  --exclude .DS_Store --exclude .expo \
  "$root/" "root@$ip:/opt/verify/"
if [ "$role" = control ]; then
  ssh "${ssh_opts[@]}" "root@$ip" "cd /opt/verify && npm install --omit=dev --no-audit --no-fund --workspace @verify/control >/dev/null && systemctl restart verify-control"
else
  ssh "${ssh_opts[@]}" "root@$ip" "docker build -q -t verify-base:latest /opt/verify/sandbox >/dev/null && systemctl restart verify-worker"
fi
echo "pushed $role to $ip"
