# pihub

Raspberry Pi 5 hub for a network of performer-controlled devices (mechanical TV, cassette player, turntable, ...).
The hub runs **Node-RED** as the central OSC receiving station, device registry, and router, with a
**FluCoMa-compatible MLP service** (Python) beside it for learned mappings between devices.

```
 devices ──OSC/UDP 9000──▶ Node-RED hub ──copy──▶ ml-service (:9100)
   ▲                         │  registry            │ MLP predict
   └────OSC/UDP 9001─────────┘  routing ◀──/ml/...──┘
```

## Files

| path | what |
|---|---|
| `install-hub.sh` | run on the Pi: Node-RED + OSC node + dashboard, Python venv, both as systemd services |
| `hub-flow.json` | Node-RED flow, three tabs: **Hub Core**, **Dummy Devices**, **ML Control**. Import via the editor menu |
| `ml/ml-service.py` | MLP regressor service. Records input→target pairs, trains, predicts live. Reads/writes FluCoMa JSON |
| `ml/ml-config.json` | which `device/param` streams are inputs and outputs, hidden layer sizes, activation |
| `ml/pihub-ml.service` | systemd unit (installed by the script) |
| `fake-device.py` | simulated device for testing from a laptop (`pip3 install python-osc`) |
| `devices/cassette-esp32/` | reference ESP32 device (L298N PWM, slide pot, OLED) following the contract; compiles on core 3.x. Devices are a work in progress, the hub does not depend on them |

## Device contract

- Each device is a **class** (`tv`, `cassette`, `turntable`) with any number of **params** (`m` = motor speed, ...).
  `tv.m` on the wire is the OSC address `/tv/m`.
- Devices send state to the hub on UDP **9000**, address `/<device>/<param>`, one float 0..1, at ~20 Hz (the heartbeat is how the hub knows who is online).
- Hub sends commands to a device on UDP **9001** at the device's IP, address `/<device>/set/<param>`.
- The hub learns each device's IP from its first packet; nothing is configured by hand.
- A device is "online" if the hub heard from it in the last 3 s; commands and routes to an offline device are dropped
  (the `routing table` node shows a red status while a target is offline).
- The ML service is a virtual device named `ml`: predictions arrive as `/ml/<device>/<param>` and the
  routing table forwards them to the real device like any other source.

## Hub-side framework, in one picture

| layer | where | what you edit |
|---|---|---|
| receive + registry | Hub Core → `parse + registry` | nothing; it learns devices from traffic |
| routing | Hub Core → `routing table` | the `routes` object: `'source/param': [{device, param, scale}]` |
| manual control | Hub Core → inject `manual: ...` | topic `/<device>/set/<param>`, payload `{"type":"f","value":x}` |
| learned mapping | `ml/ml-config.json` + ML Control tab | `inputs`, `outputs`, `hidden`, `activation` (0 identity, 1 sigmoid, 2 relu, 3 tanh) |
| simulation | Dummy Devices tab | delete when real devices exist |

## Quick start (on the Pi)

```
git clone https://github.com/andrewfrangella/pihub.git ~/pi-hub
bash ~/pi-hub/install-hub.sh
# open http://<pi-ip>:1880 → menu → Import → hub-flow.json → Deploy
```

The **Dummy Devices** tab gives you a fake TV sending `/tv/m` and a fake cassette receiving `/cassette/set/m`,
so the whole path runs with no hardware. Watch the debug sidebar: `incoming` shows every message,
`devices` shows who is online every 5 s.

## Teaching a mapping (ML Control tab)

Same workflow as `fluid.mlpregressor` / Data Knot regression: show the system a few input states paired with
the output you want, fit, then let it fill in between.

1. Freeze the TV at a value (`freeze m = 0.1`), set the cassette (`manual: cassette m = 0.5` on Hub Core, or edit the inject).
2. Click **record** — one training pair (current inputs → current targets).
3. Repeat for several states. Click **train**. Click **predict on**.
4. `resume sine` on the TV and watch the cassette follow the learned curve.

Inputs and outputs are listed in `ml/ml-config.json`; add any `device/param` you like, restart the service.

Files written to `ml/data/` are FluCoMa JSON and open directly in Max:
`dataset-in.json` / `dataset-out.json` (`fluid.dataset read`), `model.json` (`fluid.mlpregressor read`).
A model trained in Max/Data Knot can be dropped in and loaded the same way (**load**).
Every incoming value is also appended to `ml/data/log/<session>.csv`.

## Stage mode (Pi as its own access point)

```
sudo nmcli device wifi hotspot ifname wlan0 ssid PERFNET password perfnet123
sudo nmcli connection modify Hotspot connection.autoconnect yes
```

The Pi is then at `10.42.0.1` (already set in the cassette sketch). Wi-Fi internet is off in this mode; use Ethernet to install things.
