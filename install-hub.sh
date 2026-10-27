#!/usr/bin/env bash
# Run ON THE PI 5 (Raspberry Pi OS Bookworm, 64-bit):  bash install-hub.sh
set -e
HUB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # resolve before any cd

echo "== 1. system packages"
sudo apt update
sudo apt install -y build-essential git curl python3-venv python3-pip

echo "== 2. Node-RED (official installer: Node.js LTS + Node-RED + systemd service)"
bash <(curl -sL https://github.com/node-red/linux-installers/releases/latest/download/install-update-nodered-deb) --confirm-install --confirm-pi --no-init

echo "== 3. palette nodes: OSC codec + dashboard"
cd ~/.node-red
npm install node-red-contrib-osc @flowfuse/node-red-dashboard

echo "== 4. Node-RED on boot"
sudo systemctl enable nodered.service
sudo systemctl restart nodered.service

echo "== 5. Python ML service (venv + deps + systemd)"
python3 -m venv "$HUB_DIR/.venv"
"$HUB_DIR/.venv/bin/pip" install -q -r "$HUB_DIR/ml/requirements.txt"
sed -e "s|/home/pi/pi-hub|$HUB_DIR|g" -e "s|^User=pi|User=$USER|" "$HUB_DIR/ml/pihub-ml.service" | sudo tee /etc/systemd/system/pihub-ml.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now pihub-ml.service

echo
echo "Done. Editor:    http://$(hostname -I | awk '{print $1}'):1880"
echo "      Dashboard: http://$(hostname -I | awk '{print $1}'):1880/dashboard"
echo "ML svc:    journalctl -u pihub-ml -f"
echo "Next: import hub-flow.json via the editor menu (Import > select a file), then Deploy."
