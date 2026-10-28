# pihub

A performance hub for a network of performer-controlled devices (mechanical TV, cassette player, turntable, ...).

pihub is **one program, runnable on a Raspberry Pi**. It embeds the [Node-RED](https://nodered.org) runtime and
editor, adds its own palette of **device** and **machine-learning** nodes, and ships with a working default flow.
Devices talk to it over **OSC/UDP**. The performer sees every device's data in the node graph, routes any
parameter to any other by drawing wires, controls any device by hand, and can put a learned mapping (trained
from examples, in the style of FluCoMa / Data Knot regression) or a **knot** (recall of recorded states, in the
style of [CinemaKnot](https://github.com/andrewfrangella/cinemaknot)) between any input and any output.

```
   tv ─────────┐                                     ┌───▶ cassette
   cassette ───┤  OSC  /<device>/<param> <float>     │     OSC  /<device>/set/<param> <float>
   turntable ──┘       to UDP 9000, ~20 Hz           │     to the device's IP, UDP 9001
                           │                         │
                           ▼                         │
                  ┌────────────────────────────────────────────┐
                  │  pihub (Raspberry Pi)                      │
                  │  node graph in the browser:                │
                  │   device in ─▶ [ range | function | describe | ml | knot ] ─▶ device out
                  └────────────────────────────────────────────┘
```

Contents: [Installing on the Pi](#installing-on-the-pi) · [The palette](#the-palette) · [Device contract](#device-contract) ·
[How a message flows](#how-a-message-flows) · [Teaching a mapping](#teaching-a-mapping-ml-mapper) ·
[Recalling a state](#recalling-a-state-knot) · [Describing a gesture](#describing-a-gesture-describe) ·
[Adding a device](#adding-a-device) · [Changing the ML](#changing-the-ml) · [Files](#files) ·
[Running on a laptop](#running-on-a-laptop-for-development) · [Stage mode](#stage-mode-pi-as-its-own-access-point) ·
[Troubleshooting](#troubleshooting) · [Known limits](#known-limits)

---

## Installing on the Pi

**What you need.** A Raspberry Pi 4 or 5 running Raspberry Pi OS **Bookworm, 64-bit** (Lite is fine; the hub
needs no screen or desktop), internet **during installation only**, and any laptop, tablet or phone with a browser
on the same network to open the editor. The repository is called `pihub` on GitHub; the folder name on the Pi does
not matter, the installer uses wherever it finds itself.

**Install.** On the Pi, as your normal user (`pi` or whatever you created), **not** with `sudo`:

```
git clone https://github.com/andrewfrangella/pihub.git ~/pihub
bash ~/pihub/install-hub.sh
```

(If `git` is not found, `sudo apt install -y git` first.) The installer refuses to run as root or on a 32-bit OS,
then does five things, printing a heading before each:

1. `apt install build-essential git curl` (a minute).
2. Installs **Node.js 22** from NodeSource if `/usr/bin/node` is older than 22.9 (Node-RED 5 needs 22.9 or newer).
   A Node installed another way (nvm, snap) is ignored: the service runs `/usr/bin/node`.
3. `npm install` in the hub folder (two to five minutes on a Pi 4; the Monaco editor is large).
4. Writes `/etc/systemd/system/pihub.service` with your user name and the folder filled in, enables it so it
   starts on every boot, and starts it now.
5. Waits until the editor answers on port 1880. If the service dies instead, it prints the last log lines and
   stops with an error, so a failed install never says "Done".

It ends with the editor's address, `http://<pi-ip>:1880`. Open that from the laptop. You should see four tabs:
**Hub Core**, **ML Control**, **Knot**, **Dummy Devices**; on Dummy Devices the `tv.m generator` node shows a green
`m=0.xxx` badge that changes, and on Hub Core `tv in` shows green `m=` values. That is the hub receiving OSC from its
own simulated device over real UDP. Nothing else is needed to start exploring.

**Two Node-RED habits.** Nothing you change in the editor takes effect until you click the red **Deploy** button at
the top right; a node with undeployed edits shows a small blue dot. Text answers from the hub (who is online,
`recorded pair 3`, `knot status`) go to the **Debug sidebar**, the bug icon in the right-hand panel; a debug node's
small square button turns its output on or off without a deploy. The status badges under the nodes (coloured dot and
text) update live and need no deploy.

**Day to day.**

```
sudo systemctl status pihub     # running? since when? last log lines
journalctl -u pihub -f          # live log (Ctrl-C to leave)
journalctl -u pihub -n 200      # the last 200 lines
sudo systemctl restart pihub    # restart (devices reconnect by themselves, they just keep sending)
sudo systemctl stop pihub       # stop until the next boot or `start`
sudo systemctl disable pihub    # do not start on boot any more (enable to undo)
```

The service restarts itself two seconds after a crash. To run the hub by hand instead, for example to watch its
output directly: `sudo systemctl stop pihub`, then `cd ~/pihub && npm start`; Ctrl-C stops it; `sudo systemctl
start pihub` brings the service back. Two copies cannot run at once: the second one fails with "port in use".

**Update.** Plug in Ethernet or join a network with internet, then:

```
cd ~/pihub && git pull && bash install-hub.sh
```

The installer is safe to re-run: it reinstalls dependencies and restarts the service. Your live flow and your
recorded data are in `data/`, which git does not touch.

**Where your work lives.** Everything the hub learns or you edit is in `~/pihub/data/`:

| path | what |
|---|---|
| `data/flows.json` | the live flow, rewritten every time you click Deploy |
| `data/ml/` | the ml mapper's datasets, model and value logs (one folder per mapper node, if you gave them different folders) |
| `data/knot/` | the knot's datasets (likewise one folder per knot node) |
| `data/.config.*.json` | Node-RED's own bookkeeping; harmless to lose |

**Back up** by copying that folder: `cp -r ~/pihub/data ~/pihub-data-$(date +%F)` on the Pi, or from the laptop
`scp -r pi@<pi-ip>:pihub/data ./pihub-data`. **Restore** by stopping the service, copying it back, starting the
service. To go back to the shipped flow and lose your edits: `cd ~/pihub && npm run reset-flow && sudo systemctl
restart pihub`. To make your edited flow the new shipped default (and commit it): `npm run export-flow`.

**Network.** The hub listens on **TCP 1880** (the editor), **UDP 9000** (devices publish here), and sends to each
device's **UDP 9001**. Raspberry Pi OS ships without a firewall, so nothing needs opening. Find the Pi's address
with `hostname -I` on the Pi; `http://raspberrypi.local:1880` also works from most laptops if you kept the default
hostname. In stage mode (below) the Pi is always `10.42.0.1`.

The editor has **no password**: anyone on the network can rewire the hub. That is fine on the stage network, which
is yours; do not leave the hub on a shared or public Wi-Fi.

**An offline Pi.** The hub needs internet only to install and update. Without it the Pi's clock may be wrong after
a reboot (no battery, no NTP); nothing in the hub depends on the time except the names of the value-log files and
the timestamps inside them. Set it by hand if you care: `sudo date -s "2026-10-28 20:00"`.

**Disk.** The value log of each ml mapper grows about 1 MB per hour per 20 Hz parameter; switch it off in the node or
prune `data/ml/log/` now and then. The system journal is capped by the OS (a few hundred MB); `journalctl --disk-usage`
shows it, `sudo journalctl --vacuum-size=100M` trims it. `df -h /` shows free space.

---

## The palette

pihub adds a `pihub` category to the Node-RED palette. Everything else is standard Node-RED, except the **osc**
encode/decode node that the Dummy Devices tab uses to build real OSC packets; it comes from `node-red-contrib-osc`
and is installed with the app.

| node | what it does |
|---|---|
| **device in** | emits one message for every parameter the named device publishes. Optional filter to only some params. Status badge shows the latest value, or red when the device goes quiet |
| **device out** | sends `/<device>/set/<param>` to the named device. Param can be fixed in the node or taken from the message. Drops the message with a red status if the device is offline |
| **ml mapper** | learns a mapping from some parameters to others from recorded examples, then predicts live. The algorithm is a pluggable *learner*: `fluid-mlp` (FluCoMa-compatible MLP) or `knn` |
| **knot** | remembers states of the devices as labelled entries and answers the live inputs with the **nearest recorded state** (or one of the k nearest, at random), with its distance. Retrieval, not regression |
| **describe** | turns a parameter's stream into descriptors of the gesture: `mean`, `dev` (flutter), `speed`, `range`, each a new parameter such as `tv/m.speed`; and **onsets**, a pulse when the value jumps |
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
The **knot** does the same from a virtual device named `knot`. Those two device names are reserved.

**Descriptors** from a **describe** node are new parameters of the same device, with a dot:
`{ device: "tv", param: "m.speed", value: 0.3, topic: "/tv/m.speed" }`. Anything that takes a parameter name
takes `tv/m.speed` as a knot or mapper input; wired into a **device out** with a fixed param, the descriptor's value
drives that param.

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
2. Dummy Devices: **freeze m = 0.5**. Hub Core: **cassette m = 0.5**. **record**.
3. Dummy Devices: **freeze m = 0.9**. Hub Core: **cassette m = 0.1**. **record**.
4. ML Control: **train** (the status badge turns blue), then **predict on** (green).
5. Dummy Devices: **resume sine**. The cassette now follows the learned, inverted curve. Watch the status badges
   on `cassette out` and the dummy cassette's `apply command` node.

Every answer to **record**, **train**, **predict** also appears in the Debug sidebar (the `ml status` debug node on
Hub Core): `recorded pair 3: ...`, `trained fluid-mlp on 3 pairs, ... mse=...`. If a button seems to do nothing,
look there first; `record refused, no value yet for cassette/m` means the mapper has not seen that device yet.

**With real devices** the recording step is the performance itself: put the input device in a state, set the
output device by hand, record. Repeat for a handful of states.

**Learners.** `fluid-mlp` is a multilayer perceptron with the same layer layout and activation codes as FluCoMa
(0 identity, 1 sigmoid, 2 relu, 3 tanh); hidden layers, activation, epochs and learning rate are in the node.
It generalizes smoothly and writes a model file. `knn` predicts the distance-weighted average of the k closest
recorded inputs. Its **train** only stores the pairs, so it is instant, but it still has to be pressed after
recording; **load** fits it from the dataset files, and it writes no model file.

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

## Recalling a state (knot)

The ml mapper **interpolates**: it fits a curve through the recorded pairs and answers any input with a point on
that curve, including inputs it never saw. The knot **retrieves**: it keeps the recorded states themselves and
answers the live inputs with one of them, the nearest, together with how far away it was. Nothing is invented.
Every output was once a real state of the devices, and the performer can read the distance and the
neighbourhood on the second output instead of trusting an oracle.

This is CinemaKnot's idea (its `Corpus` and `queryKnot`) brought into the hub: a gesture is a point in a
multidimensional space, the corpus is a set of remembered points, and the "knot" is the neighbourhood that
negotiates the answer. With several inputs (`tv/m, turntable/drag.speed, cassette/m.dev`) the knot recalls by
the *combination* of states, not by one leader parameter.

**Wiring** is the same as the mapper: wire the **device in** (or **describe**) of every input *and* every output
into the knot, wire output 1 into the **device out** nodes it should drive, output 2 into a debug node or your
own logic, output 3 is status text. List inputs and outputs as `device/param`.

**Control messages** (topics; the **Knot** tab has an inject for each):

| topic | effect |
|---|---|
| `knot/record`, payload a label (optional) | store (current inputs → current outputs) as an entry named by the label. Same label again replaces it. No label: `point-N` |
| `knot/query` with payload `true`/`false` | start or stop answering live, whenever an input changes |
| `knot/once` | answer right now with a fresh choice. Works whether live query is on or off, so an **onset** wired here is a trigger |
| `knot/recall`, payload a label | emit that entry directly, a cue. It holds until the inputs move to a new neighbourhood |
| `knot/randomness`, `knot/k`, `knot/hold`, numeric payload | change the policy live |
| `knot/forget`, payload a label | remove one entry |
| `knot/save`, `knot/load`, `knot/clear`, `knot/status` | files and bookkeeping |

**Policy.** `k` is the size of the neighbourhood. `randomness` is the chance that the answer is a random member
of the neighbourhood instead of the nearest: 0 is strict nearest-neighbour, 1 is any of the k nearest. The random
choice is made when the nearest entry changes, or on `knot/once`, never on every tick, so a still input stays on
one entry and a needle drop is what re-rolls it. `hold` is hysteresis in distance units: the current entry is
kept while it is within `hold` of the nearest, so an input sitting on the boundary between two entries does not
flicker. `weights` make some inputs count more in the distance; `euclidean` or `manhattan` distance.

**The match** on output 2, every answer: `payload = { id, distance, changed, rolled, how, neighbors: [{ id,
distance }], query, outputs }`, where `how` is `live`, `once` or `recall`; also `msg.id` and `msg.distance`.
The status badge shows the chosen entry and its distance.

**With the dummy devices**, the **Knot** tab is wired for `tv/m → cassette/m`. Set ML Control's **predict off**
first, since the mapper and the knot both drive the cassette.

1. Dummy Devices: **freeze m = 0.1**. Knot: **cassette m = 0.9**, then **record "dark"**.
2. **freeze m = 0.5**, **cassette m = 0.5**, **record "mid"**. Then **freeze m = 0.9**, **cassette m = 0.1**, **record "bright"**.
3. **query on**, then Dummy Devices **resume sine**. The cassette now *steps* 0.9 → 0.5 → 0.1 as the sine sweeps,
   where the mapper drew a curve. Enable the **knot match** debug node to watch the distance fall and rise.
4. **randomness 0.5**: now, each time the nearest entry changes, there is a coin flip among the three.
5. Press a **freeze** button while the sine is far from that value: the jump is an onset, the describe node sends
   `knot/once`, and the knot answers again with a fresh roll. **recall "dark"** places a cue by hand.

**Files.** `data/<folder>/dataset-in.json` and `dataset-out.json` (default folder `knot`), FluCoMa `fluid.dataset`
with the labels as the point ids, saved on every record. They are the same two files the ml mapper writes, so one
recorded set of states can be read two ways: point a mapper and a knot at the same folder, **load** both, and
compare the curve with the steps. Give each knot its own folder otherwise.

---

## Describing a gesture (describe)

CinemaKnot's sensor nodes do not send raw audio; they send descriptors of it (energy, spectral centroid, flatness,
onsets). The **describe** node does the same for a parameter stream on the hub side. Put it after a **device in**
and, over a sliding window (default 500 ms), every parameter of that device gains four more, each 0..1:

| descriptor | meaning |
|---|---|
| `m.mean` | where the parameter is, smoothed |
| `m.dev` | how much it shakes: the standard deviation, scaled so the widest possible flutter (a 0/1 square wave) is 1 |
| `m.speed` | how fast it moves: the slope of the window in units per second, over the speed scale (default: a full sweep in 1 s is 1) |
| `m.range` | how far it swung inside the window |

So a turntable's `drag` becomes `turntable/drag.speed` and `turntable/drag.dev`, which is how a *scrub* differs
from a *position*. Those names go anywhere a parameter goes: knot or mapper inputs, or straight into a
**device out** with a fixed param (`drag.dev → cassette m` is a direct mapping of flutter to speed).

**Onsets** come out of the second output: when the value jumps by more than the threshold within one hop
(defaults 0.1 within 100 ms; the shipped Knot tab uses 0.15 and a 300 ms refractory, a little calmer), one pulse (`value = 1`, with `delta`, `from`, `to`), then nothing for the refractory
time (200 ms, and never less than the hop, so one jump is one onset), the same energy-flux-plus-lockout rule
CinemaKnot uses on audio. Set the node's **onset topic** to
`knot/once` and wire output 2 into a knot: the needle drop re-asks the knot. Leave it empty and the onset is an
ordinary parameter, `tv/m.onset`.

A device that computes descriptors itself (an ESP32 with a contact mic, as in CinemaKnot) just publishes them as
parameters: `/turntable/rms`, `/turntable/centroid`, `/turntable/onset`. The hub does not care where a number
was computed.

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

`devices/cassette-esp32/` is the reference sketch: ESP32 + L298N motor driver + slide pot + SSD1306 OLED,
with the local/remote arbitration described above. It compiles on arduino-esp32 core 2.x and 3.x. Treat it as a
starting point, not a finished device: expect to adjust pins, motor driver and pot range to your hardware.
For a Raspberry Pi device (the mechanical TV), any OSC library works; publish derived values such as disk RPM,
sync lock and mean brightness, not raw pixel data, and keep the network code out of the timing-critical loop.

To test from a laptop, `fake-device.py` is a simulated device (`pip3 install python-osc`; on a Bookworm Pi, whose
Python refuses system-wide pip installs, make a venv first: `python3 -m venv ~/venv && ~/venv/bin/pip install python-osc`,
then run it with `~/venv/bin/python`). Give it a name the
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
| `nodes/pihub-knot.js`, `.html` | knot |
| `nodes/pihub-describe.js`, `.html` | describe |
| `nodes/lib/hub.js` | the OSC socket and device registry runtime (uses the `osc` npm package) |
| `nodes/lib/knot.js` | the corpus and the retrieval policy (k, randomness, hold, recall), pure JavaScript |
| `nodes/lib/describe.js` | the sliding-window descriptors and onset detector |
| `nodes/lib/dataset.js` | `fluid.dataset` read/write shared by the mapper and the knot |
| `nodes/learners/` | `fluid-mlp.js`, `knn.js`, and the README describing the learner interface |
| `flows/hub-flow.json` | the shipped default flow: tabs **Hub Core**, **ML Control**, **Knot**, **Dummy Devices** |
| `test/` | unit tests for the libraries: `npm test` |
| `data/` | runtime state, not in git: the live `flows.json`, `ml/` datasets, models and logs, Node-RED's own files |
| `install-hub.sh`, `pihub.service` | Pi installer and systemd unit |
| `fake-device.py` | simulated device for a laptop |
| `devices/cassette-esp32/` | reference device firmware: compiles, still needs bench time against real hardware; the hub does not depend on it |

The live flow you edit in the browser is `data/flows.json`. To commit it as the new default:
`npm run export-flow` copies it to `flows/hub-flow.json`. `npm run reset-flow` does the reverse.

---

## Running on a laptop (for development)

Everything runs on macOS or Linux with Node.js 22.9+:

```
npm install
npm start               # http://localhost:1880
PIHUB_PORT=1881 npm start   # if 1880 is taken
npm test                # unit tests for knot, describe and the dataset helpers
```

The Dummy Devices tab works there too. Point real devices at the laptop's IP instead of the Pi's.

---

## Stage mode (Pi as its own access point)

So the system never depends on venue Wi-Fi:

```
sudo nmcli device wifi hotspot ifname wlan0 ssid PERFNET password perfnet123
sudo nmcli connection modify Hotspot connection.autoconnect yes
```

The Pi is then at `10.42.0.1`, which is the hub address already in the cassette firmware, and the editor is at
**http://10.42.0.1:1880** from any laptop that joins `PERFNET` (the address the installer printed was for the old
network). Wi-Fi internet is off in this mode; plug in Ethernet when you need to install or update.

If `nmcli` says Wi-Fi is disabled or `wlan0` is unavailable, the Wi-Fi country has not been set: `sudo raspi-config`
→ Localisation Options → WLAN Country, then reboot. Without it the radio stays blocked.

To go back to the venue's Wi-Fi: `sudo nmcli connection down Hotspot && sudo nmcli connection modify Hotspot
connection.autoconnect no`, then join the network as usual.

The editor has no password. The private network is what keeps strangers out of the hub; do not run it on a shared
or public Wi-Fi.

---

## Troubleshooting

**Getting to the hub**

| symptom | look at |
|---|---|
| the browser cannot open `http://<pi-ip>:1880` | on the Pi, `curl -s localhost:1880 \| head -3` prints HTML if the hub is up. If it does, the laptop is on another network or the IP changed (`hostname -I`; in stage mode it is `10.42.0.1`). If it does not, see the service rows below |
| `systemctl status pihub` says `activating (auto-restart)`, `failed` or `start-limit-hit` | the app exits at start and systemd retries every 2 s, then gives up after five tries. `journalctl -u pihub -n 100` has the reason. Fix it, then `sudo systemctl reset-failed pihub && sudo systemctl restart pihub` |
| the log says `cannot listen on port 1880: port in use` | another hub is running, usually one started by hand with `npm start`; stop it (`sudo ss -ltnp \| grep 1880` names the process) |
| the log says `hub socket error: bind EADDRINUSE` every 5 s | something else holds UDP 9000 (`sudo ss -lunp \| grep 9000`); the editor works meanwhile but no device data arrives until the port is free |
| the log says `Cannot find module` | dependencies are missing or half-installed; re-run `install-hub.sh` |
| `node -v` on the Pi says 18 or 20 | Node-RED 5 refuses to start; re-run `install-hub.sh`, it installs Node 22. If `node -v` and `/usr/bin/node -v` differ you have a second Node (nvm) on your PATH; the service uses `/usr/bin/node`, `npm start` uses whatever is first on the PATH |
| service will not start after a `sudo npm start` | `data/` is root-owned; re-run `install-hub.sh`, it repairs ownership |
| the editor opens with an empty workspace or a red error banner | `data/flows.json` is broken (a power cut during Deploy, or a hand edit). `sudo systemctl stop pihub`, then either restore `data/.flows.json.backup` (Node-RED keeps the previous deploy there) or `npm run reset-flow` for the shipped flow, then `sudo systemctl start pihub` |
| the Pi rebooted and the hub is gone | `systemctl is-enabled pihub` must say `enabled`; `sudo systemctl enable --now pihub` fixes it |
| `apt update` fails with "is not valid yet" | the Pi's clock is behind (no internet, no clock battery); `sudo date -s "2026-10-28 20:00"` then retry |

**Devices**

| symptom | look at |
|---|---|
| a **device in** stays grey "waiting" or red "never seen" | the device is not reaching UDP 9000 on the hub's IP: check SSID, hub IP, that it sends `/<device>/<param>` with the exact name in the node. `sudo tcpdump -i any -n udp port 9000` on the Pi (`sudo apt install tcpdump`) shows whether anything arrives at all |
| packets arrive but no device appears | the address is not `/<device>/<param>` with a float argument; the hub logs `dropped undecodable packet` if it is not OSC at all |
| the device appears, then goes offline every few seconds | it publishes slower than once per 3 s, or Wi-Fi drops packets; publish at ~20 Hz and keep devices near the access point |
| devices cannot reach the hub on the venue's Wi-Fi although both are connected | many venue networks isolate clients from each other; use stage mode instead |
| **device out** shows red "offline, dropped" | the device has not been heard from for 3 s; it must publish state at ~20 Hz to count as online |
| **device out** shows yellow "non-numeric value" | the message's `payload` is not a number and it has no numeric `value`; check what the node before it emits |
| commands reach the dummy cassette but not a real one | the real device must listen on UDP 9001 and dispatch `/<device>/set/<param>`; the hub sends to the IP it last heard the device from, so a device behind a phone hotspot or a NAT is unreachable. If a fake device and a real one share a name, delete the Dummy Devices tab |
| two devices show as one, or a value jumps between two streams | two devices use the same name; names are the only identity the hub has |

**Mapping and knot**

| symptom | look at |
|---|---|
| `ml/record` or `knot/record` refused "no value yet for ..." | the node has not seen that parameter; wire its device in (or describe) into the mapper or knot |
| predictions stop and the mapper's status says error | `journalctl -u pihub` has the message; **load** reports a bad model file in its status |
| **load** says `datasets skipped`, `model skipped` or `load failed, corpus unchanged` | the file does not fit this node (different number of inputs or outputs) or is not valid JSON; the node keeps what it had. Fix the node's inputs/outputs, or delete the file and re-record |
| the knot flickers between two entries | the input sits on a boundary; raise **hold**, or smooth the input first (a **function** node with a running average, or `node-red-node-smooth` from the palette manager, which needs internet) |
| onsets fire on noise, or never | raise or lower the describe node's **threshold**; a longer **hop** catches slower jumps |
| the cassette jumps around while recording knot cues | an onset (a freeze button is a jump) sent `knot/once`; set the output device *after* the freeze, as in the recipe, or disconnect the onset wire while recording |
| the mapper and the knot fight over a device | both are driving it; **predict off** on one or **query off** on the other |

**Data and disk**

| symptom | look at |
|---|---|
| the disk is filling up | `du -sh ~/pihub/data/*/log` and `journalctl --disk-usage`. Delete old CSVs, untick **Log values** in the mapper, `sudo journalctl --vacuum-size=100M` |
| timestamps in the logs are wrong | the Pi has no clock battery and no internet; `sudo date -s "..."`. Nothing else depends on the time |
| I want yesterday's flow or corpus back | restore your copy of `data/` (see Installing on the Pi); without a copy, `data/.flows.json.backup` is the previous deploy only |

---

## Known limits

- **Training runs on the main thread.** Dozens of pairs take milliseconds; hundreds can pause the hub for
  seconds on a Pi. Train between pieces, not mid-phrase.
- **The value log grows without limit**, about 3 MB per hour per 20 Hz parameter (140 MB a day for the shipped
  two-parameter flow). It can be switched off
  per mapper node; prune `data/ml/log/` now and then.
- **One hub config node per port.** Two hubs on the same port will fight; the second retries until the first is
  gone.
- **Wi-Fi is the weak link on stage.** Use the access point mode and keep local control on every device.
- **The dummy cassette owns UDP 9001 on the hub machine**, so a real device running on the hub itself would
  need the dummy tab removed.
- **The knot searches by brute force.** Fine for thousands of entries at 20 Hz on a Pi; a corpus of film frames
  by the hundred thousand would want an index.
- **`knot/once` acts even when live query is off**, on purpose: an onset can trigger a retrieval without a
  continuous stream. Disconnect the onset wire if you do not want that.
- **One driver per output.** The ml mapper and the knot both drive whatever they are wired to; run one of them
  at a time per device, or give them different outputs.
- **The editor has no password.** Anyone on the hub's network can rewire it. Stage mode's private network is the
  protection.
- **The ESP32 firmware is a reference sketch, not a finished device.** It compiles; it has not had bench time
  against real hardware in this repository.
