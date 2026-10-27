# pihub

A performance hub for a network of performer-controlled devices (mechanical TV, cassette player, turntable, ...).
One program, runnable on a Raspberry Pi: it embeds the **Node-RED** runtime and editor, adds its own palette of
**device** and **ML** nodes, and ships with a working default flow. Devices talk to it over **OSC/UDP**.

```
 tv ───┐                                    ┌──▶ cassette
 cassette ─┤  OSC /dev/param  ──▶  pihub  ──┤  OSC /dev/set/param
 turntable ┘        :9000          (Pi)     └──▶ turntable   :9001
                                     │
                     node graph: device in ─▶ [range | function | ml mapper] ─▶ device out
```

## The palette

| node | does |
|---|---|
| **device in** | emits everything one device publishes: `msg.device`, `msg.param`, `msg.value` (also `topic`/`payload`) |
| **device out** | sends `/<device>/set/<param>` to that device, if it is online |
| **ml mapper** | learns a mapping from some parameters to others from recorded examples, then predicts live. Pluggable learner: `fluid-mlp` (FluCoMa-compatible) or `knn` |
| **registry** | who is online, every N seconds, also in global context `pihub_devices` |
| *hub* (config) | the UDP socket and device registry; ports and online timeout |

Everything else is standard Node-RED: `range` to scale, `function` for custom logic, `inject` for buttons,
`debug` to watch, and the palette manager to add `@flowfuse/node-red-dashboard` for a touch UI.

## Device contract

- A device is a **class** (`tv`, `cassette`, `turntable`) with any number of **params** (`m` = motor speed, `pot`, ...).
- Devices send `/<device>/<param> <float 0..1>` to the hub on UDP **9000**, ~20 Hz (the heartbeat is how the hub knows who is online; 3 s silence = offline).
- The hub sends `/<device>/set/<param> <float>` to the device's last-seen IP on UDP **9001**.
- Devices are discovered from their traffic. Nothing is configured by hand.
- The ml mapper is a virtual device `ml`: its predictions carry `param = "<device>/<param>"`, and a `device out` only accepts the ones addressed to its device, so one mapper can drive several devices.

## Install on the Pi

```
git clone https://github.com/andrewfrangella/pihub.git ~/pihub
bash ~/pihub/install-hub.sh          # Node.js 22.9+, npm install, systemd service "pihub" (re-run after git pull)
# open http://<pi-ip>:1880
```

Run by hand instead: `npm install && npm start`. Logs: `journalctl -u pihub -f`.

## First run, no hardware

The **Dummy Devices** tab simulates a TV sending `/tv/m` and a cassette receiving `/cassette/set/m` over real UDP.
On **Hub Core**, `tv in` feeds the `ml mapper`, which feeds `cassette out`. Watch the node status badges and the
`devices` debug output.

Teach a mapping (same workflow as `fluid.mlpregressor` / Data Knot regression):

1. Dummy Devices: `freeze m = 0.1`. Hub Core: `cassette m = 0.9`. ML Control: **record**.
2. Repeat for `0.5 → 0.5` and `0.9 → 0.1` (edit the inject values or add your own).
3. ML Control: **train**, then **predict on**. Dummy Devices: `resume sine`. The cassette now follows the learned curve.

For a direct, non-learned mapping, enable the disabled `range` node (tv in → invert → cassette out) and disable the mapper.

## Files

| path | what |
|---|---|
| `app.js` | the program: embeds Node-RED, seeds `data/flows.json` from `flows/hub-flow.json` on first run |
| `settings.js` | Node-RED settings: trimmed palette, editor theme, `nodes/` as the custom node dir |
| `nodes/` | the pihub palette (`pihub-hub.js`: hub config, device in/out, registry; `pihub-ml.js`: ml mapper) |
| `nodes/lib/hub.js` | the OSC socket + registry runtime |
| `nodes/learners/` | ML algorithms behind the mapper, one file each (see its README to add your own) |
| `flows/hub-flow.json` | the shipped default flow (3 tabs: Hub Core, ML Control, Dummy Devices) |
| `data/` | runtime state, not in git: live `flows.json`, `ml/` datasets + models + logs |
| `install-hub.sh`, `pihub.service` | Pi install and systemd unit |
| `fake-device.py` | a simulated device to run from a laptop (`pip3 install python-osc`). Give it a name the Dummy Devices tab is not already using, or disable that tab |
| `devices/` | reference device firmware (cassette: ESP32 + L298N + pot + OLED). Work in progress; the hub does not depend on it |

`npm run export-flow` copies the live flow back into `flows/` for committing; `npm run reset-flow` does the reverse.

## ML files and Max

The mapper writes FluCoMa JSON into `data/ml/`: `dataset-in.json` / `dataset-out.json` (`fluid.dataset`) and,
for `fluid-mlp`, `model.json` (`fluid.mlpregressor`, same layer layout and activation codes). Open them in Max with
`read`, or drop Max-written files in and click **load**. Every value the mapper sees is appended to `data/ml/log/<session>.csv`:
that log is the multi-device performance dataset.

## Changing the ML

The mapper node only does bookkeeping (latest values, recording, files, predictions). The algorithm is a learner
module with `create`, `fit`, `predict`, `toJSON`: see `nodes/learners/README.md`. Add a file, register it, pick it in the node.

## Stage mode (Pi as its own access point)

```
sudo nmcli device wifi hotspot ifname wlan0 ssid PERFNET password perfnet123
sudo nmcli connection modify Hotspot connection.autoconnect yes
```

The Pi is then at `10.42.0.1`. Wi-Fi internet is off in this mode; use Ethernet to install things.
