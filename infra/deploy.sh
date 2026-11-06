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
  scp "${ssh_opts[@]}" "$3" "root@$ip:/etc/verify-control.env"
  ssh "${ssh_opts[@]}" "root@$ip" "bash /opt/verify/infra/setup-control.sh"
else
  scp "${ssh_opts[@]}" "$3" "root@$ip:/etc/verify-worker.env"
  ssh "${ssh_opts[@]}" "root@$ip" "bash /opt/verify/infra/setup-worker.sh"
fi
