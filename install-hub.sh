#!/usr/bin/env bash
# Run ON THE PI 5 (Raspberry Pi OS Bookworm, 64-bit):  bash install-hub.sh
set -e

echo "== 1. system packages"
sudo apt update
sudo apt install -y build-essential git curl python3-pip

echo "== 2. Node-RED (official installer: Node.js LTS + Node-RED + systemd service)"
bash <(curl -sL https://github.com/node-red/linux-installers/releases/latest/download/install-update-nodered-deb) --confirm-install --confirm-pi

echo "== 3. palette nodes: OSC codec + dashboard"
cd ~/.node-red
npm install node-red-contrib-osc @flowfuse/node-red-dashboard

echo "== 4. start on boot"
sudo systemctl enable nodered.service
sudo systemctl restart nodered.service

echo
echo "Done. Editor:    http://$(hostname -I | awk '{print $1}'):1880"
echo "      Dashboard: http://$(hostname -I | awk '{print $1}'):1880/dashboard"
echo "Next: import hub-flow.json via the editor menu (Import > select a file)."
