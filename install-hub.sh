#!/usr/bin/env bash
# Run ON THE PI (Raspberry Pi OS Bookworm, 64-bit), as your normal user, NOT with sudo:   bash install-hub.sh
# Installs Node.js 22 (Node-RED 5 needs >= 22.9), this app's dependencies, and a systemd service "pihub".
# Safe to re-run after `git pull`: it reinstalls dependencies and restarts the service.
set -eo pipefail
HUB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_USER="$(id -un)"
if [ "$RUN_USER" = "root" ]; then echo "run this as your normal user, not root/sudo"; exit 1; fi
ARCH="$(dpkg --print-architecture 2>/dev/null || uname -m)"
case "$ARCH" in arm64|aarch64|amd64|x86_64) ;; *) echo "this is a $ARCH system; pihub needs 64-bit Raspberry Pi OS (arm64). Reflash with the 64-bit image."; exit 1;; esac
command -v sudo >/dev/null || { echo "sudo is missing; install it or run the steps in this script by hand as root"; exit 1; }

echo "== 1. system packages"
sudo apt update
sudo apt install -y build-essential git curl

echo "== 2. Node.js 22 (NodeSource), unless /usr/bin/node is already >= 22.9"
node_ok() { [ -x /usr/bin/node ] && /usr/bin/node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=9)?0:1)'; }
if ! node_ok; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt install -y nodejs
fi
node_ok || { echo "/usr/bin/node is $(/usr/bin/node -v 2>/dev/null || echo missing); need >= 22.9"; exit 1; }
echo "node $(/usr/bin/node -v), npm $(npm -v)"

echo "== 3. pihub dependencies"
cd "$HUB_DIR"
[ -d data ] && sudo chown -R "$RUN_USER" data node_modules 2>/dev/null || true   # repair a data/ left behind by a sudo run
npm install --omit=dev --no-fund --no-audit

echo "== 4. systemd service (runs as $RUN_USER from $HUB_DIR)"
sed -e "s|__USER__|$RUN_USER|g" -e "s|__DIR__|$HUB_DIR|g" -e "s|__NODE__|/usr/bin/node|g" "$HUB_DIR/pihub.service" | sudo tee /etc/systemd/system/pihub.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable pihub.service
sudo systemctl restart pihub.service

echo "== 5. waiting for the hub to come up"
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fs -o /dev/null "http://127.0.0.1:1880/"; then break; fi
  if ! systemctl is-active --quiet pihub.service; then
    echo "pihub did not stay running. Last log lines:"; journalctl -u pihub -n 40 --no-pager; exit 1
  fi
  sleep 2
done
curl -fs -o /dev/null "http://127.0.0.1:1880/" || { echo "pihub is running but the editor did not answer within 20 s. Logs: journalctl -u pihub -n 40"; exit 1; }

echo
echo "Done. Editor: http://$(hostname -I | awk '{print $1}'):1880   (in stage mode: http://10.42.0.1:1880)"
echo "Logs:         journalctl -u pihub -f"
echo "Service:      sudo systemctl status|restart|stop pihub"
echo "Update:       cd $HUB_DIR && git pull && bash install-hub.sh"
