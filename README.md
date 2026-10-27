# pihub

A performance hub for a network of performer-controlled devices (mechanical TV, cassette player, turntable, ...).

pihub is **one program, runnable on a Raspberry Pi**. It embeds the [Node-RED](https://nodered.org) runtime and
editor, adds its own palette of **device** and **machine-learning** nodes, and ships with a working default flow.
Devices talk to it over **OSC/UDP**. The performer sees every device's data in the node graph, routes any
parameter to any other by drawing wires, controls any device by hand, and can put a learned mapping (trained
from examples, in the style of FluCoMa / Data Knot regression) between any input and any output.

```
   tv ─────────┐                                     ┌───▶ cassette
   cassette ───┤  OSC  /<device>/<param> <float>     │     OSC  /<device>/set/<param> <float>
   turntable ──┘       to UDP 9000, ~20 Hz           │     to the device's IP, UDP 9001
                           │                         │
                           ▼                         │
                  ┌────────────────────────────────────────────┐
                  │  pihub (Raspberry Pi)                      │
                  │  node graph in the browser:                │
                  │   device in ─▶ [ range | function | ml ] ─▶ device out
                  └────────────────────────────────────────────┘
```

Contents: [Quick start](#quick-start) · [The palette](#the-palette) · [Device contract](#device-contract) ·
[How a message flows](#how-a-message-flows) · [Teaching a mapping](#teaching-a-mapping-ml-mapper) ·
[Adding a device](#adding-a-device) · [Changing the ML](#changing-the-ml) · [Files](#files) ·
[Running on a laptop](#running-on-a-laptop-for-development) · [Stage mode](#stage-mode-pi-as-its-own-access-point) ·
[Troubleshooting](#troubleshooting) · [Known limits](#known-limits)

---

## Quick start

On the Pi (Raspberry Pi OS Bookworm 64-bit, Pi 4 or 5), as your normal user, not root:

```
git clone https://github.com/andrewfrangella/pihub.git ~/pihub
bash ~/pihub/install-hub.sh
```

The installer puts Node.js 22 in place (Node-RED 5 needs 22.9 or newer), installs the app's dependencies,
and registers a systemd service called `pihub` that starts on boot. Then open **http://\<pi-ip\>:1880** in a
browser on any machine on the same network. Re-run the installer after `git pull` to update and restart.

```
journalctl -u pihub -f          # logs
sudo systemctl restart pihub    # restart
npm start                       # run by hand instead of the service (stop the service first)
```

No hardware yet? The default flow's **Dummy Devices** tab simulates a TV and a cassette, so everything below
works on day one.

---

## The palette

pihub adds a `pihub` category to the Node-RED palette. Everything else is standard Node-RED.

| node | what it does |
|---|---|
| **device in** | emits one message for every parameter the named device publishes. Optional filter to only some params. Status badge shows the latest value, or red when the device goes quiet |
| **device out** | sends `/<device>/set/<param>` to the named device. Param can be fixed in the node or taken from the message. Drops the message with a red status if the device is offline |
| **ml mapper** | learns a mapping from some parameters to others from recorded examples, then predicts live. The algorithm is a pluggable *learner*: `fluid-mlp` (FluCoMa-compatible MLP) or `knn` |
| **registry** | emits who is online every N seconds and stores it in global context as `pihub_devices` |
| *hub* (config node) | the UDP socket and device registry. Ports and the online timeout live here. One per hub |

Standard nodes you will use most: **inject** for buttons and fixed values, **range** to scale or invert,
**function** for custom logic in JavaScript, **debug** to watch messages, **link in/out** to wire across tabs.
Through the palette manager you can add `@flowfuse/node-red-dashboard` for a touch UI with sliders and gauges.

---

## Device contract

This is the whole interface between a device and the hub. Any microcontroller or computer that can send UDP
can be a device.

- A device is a **class** (`tv`, `cassette`, `turntable`, ...) with any number of **params** (`m` for motor
  speed, `pot`, `drag`, `brightness`, ...). Think of it as `tv.m`; on the wire it is the OSC address `/tv/m`.
- Devices **publish state** to the hub: OSC address `/<device>/<param>`, one float argument scaled **0..1**,
  sent to the hub's IP on **UDP 9000**, at about **20 Hz** whether or not the value changed. That steady stream
  is the heartbeat: a device that has not been heard from for 3 s is **offline**.
- The hub **sends commands** to a device: OSC address `/<device>/set/<param>`, one float 0..1, to the device's
  last-seen IP on **UDP 9001**.
- Devices are **discovered from their traffic**. The hub learns each device's IP from its first packet;
  nothing is configured by hand on the hub. Nothing stops a device from publishing params it does not accept
  as commands, or accepting commands for params it does not publish.
- A device should keep **local control** (a pot, a switch) that works when the network is gone, and should
  decide how a remote command and the local control combine. The reference cassette firmware uses: the slider
  is the base, a hub command takes over while the hub keeps sending, and moving the slider hands control back.

Scaling to 0..1 on the device is deliberate. The hub then only ever maps unitless numbers to unitless numbers,
and any device can be wired to any other without knowing units.

---

## How a message flows

1. A UDP packet `/tv/m 0.42` arrives at the hub config node's socket. The hub updates the registry
   (`tv`: IP, last seen, `m = 0.42`) and emits the message to every **device in** node.
2. The `tv` **device in** node sends a Node-RED message:

   ```
   { device: "tv", param: "m", value: 0.42, topic: "/tv/m", payload: 0.42, ip: "10.42.0.17" }
   ```

   `value` and `payload` start out equal. Standard nodes such as **range** change `payload`.
3. Whatever you wired in between runs. A **range** node turns `payload` 0.42 into, say, 0.58.
   An **ml mapper** node uses it as an input and emits a prediction (see below).
4. A **device out** node for `cassette` receives the message. It picks the value as
   **`payload` if it is numeric** (numeric strings count), otherwise `value`, and the param as the node's fixed
   param if set, else `msg.param`, else `msg.topic`. It clamps to 0..1 by default and sends
   `/cassette/set/m 0.58` to the cassette's IP on port 9001, if the cassette is online.

**Manual control** is the same path with an **inject** node as the source: topic `m`, payload `0.9`, wired into
`cassette out`.

**Predictions** from the ml mapper look like messages from a virtual device named `ml`, with the target device
in the param: `{ device: "ml", param: "cassette/m", value: 0.58, payload: 0.58 }`. A **device out** only accepts
a message whose device prefix is its own device, so one mapper wired to several outs drives each correctly.

---

## Teaching a mapping (ml mapper)

The workflow mirrors `fluid.mlpregressor` in Max and the regression tools in Data Knot: show the system a few
input states paired with the output you want for each, fit, then let it fill in everything between.

**Wiring.** Wire the **device in** of every input *and* every output into the mapper (it has to see the outputs
to record targets). Wire the mapper's first output into the **device out** nodes it should drive. Its second
output is status text. In the mapper's settings, list the inputs and outputs as `device/param`, for example
inputs `tv/m, turntable/drag` and outputs `cassette/m`.

**Control messages** reach the mapper as messages with these topics (the **ML Control** tab has one inject per
command, wired through link nodes):

| topic | effect |
|---|---|
| `ml/record` | store (current inputs → current outputs) as one training pair |
| `ml/train` | fit the learner on the recorded pairs and save the model |
| `ml/predict` with payload `true`/`false` | start or stop emitting predictions whenever an input changes |
| `ml/save`, `ml/load` | write / read the dataset and model files |
| `ml/clear` | forget the recorded pairs (files unchanged until save) |
| `ml/status` | report pairs, model, latest values |

**With the dummy devices**, the shipped flow already maps `tv/m → cassette/m`:

1. Dummy Devices tab: **freeze m = 0.1**. Hub Core: **cassette m = 0.9**. ML Control: **record**.
2. Dummy Devices: **freeze m = 0.5**. Hub Core: **cassette m = 0.5** (edit an inject's payload or add one). **record**.
3. Dummy Devices: **freeze m = 0.9**. Hub Core: **cassette m = 0.1**. **record**.
4. ML Control: **train** (the status badge turns blue), then **predict on** (green).
5. Dummy Devices: **resume sine**. The cassette now follows the learned, inverted curve. Watch the status badges
   on `cassette out` and the dummy cassette's `apply command` node.

**With real devices** the recording step is the performance itself: put the input device in a state, set the
output device by hand, record. Repeat for a handful of states.

**Learners.** `fluid-mlp` is a multilayer perceptron with the same layer layout and activation codes as FluCoMa
(0 identity, 1 sigmoid, 2 relu, 3 tanh); hidden layers, activation, epochs and learning rate are in the node.
It generalizes smoothly and writes a model file. `knn` predicts the distance-weighted average of the k closest
recorded inputs; it needs no training step beyond storing the pairs, and reacts instantly to a new recording.

**Files.** The mapper keeps its files under `data/<folder>/` (default `data/ml/`), all in FluCoMa JSON:

| file | format | Max object |
|---|---|---|
| `dataset-in.json` | `fluid.dataset`: `{"cols": N, "data": {"point-0": [...], ...}}` | `fluid.dataset` → `read` |
| `dataset-out.json` | same | `fluid.dataset` → `read` |
| `model.json` | `fluid.mlpregressor`: `{"layers": [{"activation", "biases", "cols", "rows", "weights"}]}` | `fluid.mlpregressor` → `read` |
| `log/<session>.csv` | `time, device, param, value` for every value seen | your dataset |

Models and datasets move both ways: train in Max / Data Knot, drop the files in, click **load**. The CSV log
is the multi-device performance record; it is the raw material for anything you want to analyze or train later.

---

## Adding a device

On the hub, nothing is required. Drag a **device in** and a **device out**, type the device's name, wire them.

On the device, implement the contract. For an ESP32 with the Arduino core and the CNMAT **OSC** library:

```cpp
OSCMessage m("/turntable/drag"); m.add(value01);          // publish state, 20 Hz
udp.beginPacket(HUB_IP, 9000); m.send(udp); udp.endPacket(); m.empty();

// receive commands on UDP 9001
OSCMessage in; int n = udp.parsePacket();
if (n) { while (n--) in.fill(udp.read()); if (!in.hasError()) in.dispatch("/turntable/set/speed", onSetSpeed); }
```

`devices/cassette-esp32/` is a complete reference: ESP32 + L298N motor driver + slide pot + SSD1306 OLED,
with the local/remote arbitration described above. It compiles on arduino-esp32 core 2.x and 3.x.
For a Raspberry Pi device (the mechanical TV), any OSC library works; publish derived values such as disk RPM,
sync lock and mean brightness, not raw pixel data, and keep the network code out of the timing-critical loop.

To test from a laptop, `fake-device.py` is a simulated device (`pip3 install python-osc`). Give it a name the
Dummy Devices tab is not already using, or disable that tab, otherwise two sources fight over one device name.

---

## Changing the ML

The **ml mapper** node only does bookkeeping: latest values, recording, files, predictions, status. The
algorithm is a learner module in `nodes/learners/`, one file each, exposing `create`, `fit`, `predict`,
`toJSON` and `fromJSON`. Add a file, register it in the `LEARNERS` table at the top of `nodes/pihub-ml.js`,
add an option to the dropdown in `nodes/pihub-ml.html`, and it appears in the node. `nodes/learners/README.md`
has the exact interface.

Ideas that fit the interface without touching the node: a classifier that emits a class index instead of a
regression, a learner that updates continuously from demonstrations instead of on `ml/train`, or a bridge that
forwards the pairs to an external process (Python, Pure Data with FluCoMa, Max) and returns its predictions.

---

## Files

| path | what |
|---|---|
| `app.js` | the program. Embeds Node-RED, seeds `data/flows.json` from `flows/hub-flow.json` on first run, clean shutdown on SIGTERM |
| `settings.js` | Node-RED settings: editor title, trimmed palette (no MQTT/HTTP/TCP/exec nodes), `nodes/` as the custom node dir |
| `nodes/pihub-hub.js`, `.html` | hub config node, device in, device out, registry |
| `nodes/pihub-ml.js`, `.html` | ml mapper |
| `nodes/lib/hub.js` | the OSC socket and device registry runtime (uses the `osc` npm package) |
| `nodes/learners/` | `fluid-mlp.js`, `knn.js`, and the README describing the learner interface |
| `flows/hub-flow.json` | the shipped default flow: tabs **Hub Core**, **ML Control**, **Dummy Devices** |
| `data/` | runtime state, not in git: the live `flows.json`, `ml/` datasets, models and logs, Node-RED's own files |
| `install-hub.sh`, `pihub.service` | Pi installer and systemd unit |
| `fake-device.py` | simulated device for a laptop |
| `devices/cassette-esp32/` | reference device firmware (work in progress; the hub does not depend on it) |

The live flow you edit in the browser is `data/flows.json`. To commit it as the new default:
`npm run export-flow` copies it to `flows/hub-flow.json`. `npm run reset-flow` does the reverse.

---

## Running on a laptop (for development)

Everything runs on macOS or Linux with Node.js 22.9+:

```
npm install
npm start               # http://localhost:1880
```

The Dummy Devices tab works there too. Point real devices at the laptop's IP instead of the Pi's.

---

## Stage mode (Pi as its own access point)

So the system never depends on venue Wi-Fi:

```
sudo nmcli device wifi hotspot ifname wlan0 ssid PERFNET password perfnet123
sudo nmcli connection modify Hotspot connection.autoconnect yes
```

The Pi is then at `10.42.0.1`, which is the hub address already in the cassette firmware. Wi-Fi internet is off
in this mode; plug in Ethernet when you need to install or update.

---

## Troubleshooting

| symptom | look at |
|---|---|
| a **device in** stays grey "waiting" or red "never seen" | the device is not reaching UDP 9000 on the hub's IP: check SSID, hub IP, that it sends `/<device>/<param>` with the exact name in the node |
| **device out** shows red "offline, dropped" | the device has not been heard from for 3 s; it must publish state at ~20 Hz to count as online |
| **device out** shows yellow "non-numeric value" | the message's `payload` is not a number and it has no numeric `value`; check what the node before it emits |
| commands reach the dummy cassette but not a real one | real device must listen on UDP 9001 and dispatch `/<device>/set/<param>`; if a fake device and a real one share a name, delete the Dummy Devices tab |
| `ml/record` refused "no value yet for ..." | the mapper has not seen that parameter; wire its device in into the mapper |
| predictions stop and the mapper's status says error | `journalctl -u pihub` has the message; **load** reports a bad model file in its status |
| hub log says "port in use" | something else holds UDP 9000 or TCP 1880; the hub retries the UDP bind every 5 s, the editor port does not |
| service will not start after a `sudo npm start` | `data/` is root-owned; re-run `install-hub.sh`, it repairs ownership |

---

## Known limits

- **Training runs on the main thread.** Dozens of pairs take milliseconds; hundreds can pause the hub for
  seconds on a Pi. Train between pieces, not mid-phrase.
- **The value log grows without limit**, roughly 1 MB per hour per 20 Hz parameter. It can be switched off
  per mapper node; prune `data/ml/log/` now and then.
- **One hub config node per port.** Two hubs on the same port will fight; the second retries until the first is
  gone.
- **Wi-Fi is the weak link on stage.** Use the access point mode and keep local control on every device.
- **The dummy cassette owns UDP 9001 on the hub machine**, so a real device running on the hub itself would
  need the dummy tab removed.
