# pihub

Raspberry Pi 5 hub for a network of performer-controlled devices (mechanical TV, cassette player, turntable, ...).
The hub runs Node-RED and acts as the central OSC receiving station, device registry, and router.

## Files

- `install-hub.sh` — run on the Pi: installs Node-RED, the OSC codec node, and the dashboard; enables the service on boot.
- `hub-flow.json` — starting Node-RED flow: OSC in, device registry, routing table, manual command, status dump. Import via the editor menu.
- `fake-device.py` — simulated device for testing from a laptop (`pip3 install python-osc`).
- `esp32-device-skeleton.ino` — ESP32 device following the hub contract (CNMAT OSC library).

## Device contract

- Devices send state to the hub on UDP **9000**, address `/<device>/<param>`, one float 0..1, at ~20 Hz.
- Hub sends commands to a device on UDP **9001** at the device's IP, address `/<device>/set/<param>`.
- The hub learns each device's IP from its first packet; nothing is configured by hand.

## Quick start

```
scp -r pi-hub pi@<pi-ip>:~
ssh pi@<pi-ip> 'bash ~/pi-hub/install-hub.sh'
# open http://<pi-ip>:1880, Import > hub-flow.json, Deploy

# on the laptop
pip3 install python-osc
python3 fake-device.py --hub <pi-ip> --name cassette
python3 fake-device.py --hub <pi-ip> --name turntable
```

## Stage mode (Pi as its own access point)

```
sudo nmcli device wifi hotspot ifname wlan0 ssid PERFNET password perfnet123
sudo nmcli connection modify Hotspot connection.autoconnect yes
```

The Pi is then at `10.42.0.1`.
