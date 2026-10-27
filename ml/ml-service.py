#!/usr/bin/env python3
"""
pihub ML service: a FluCoMa-compatible MLP regressor that sits beside Node-RED.

Data path
  hub  --OSC-->  this service   : every device message, unchanged  (/<device>/<param> <float>)   on :9100
  Node-RED  --OSC-->  this      : control messages                 (/ml/record, /ml/train, ...)  on :9100
  this  --OSC-->  hub :9000     : predictions as a virtual device   (/ml/<device>/<param> <float>)
                                  and status text                   (/ml/status "<text>")

The hub's routing table then forwards /ml/<device>/<param> to the real device, so a
prediction is just another source the performer can wire up.

Files (all FluCoMa JSON, loadable in Max with `read` on fluid.dataset / fluid.mlpregressor)
  <dir>/dataset-in.json   fluid.dataset of input vectors   {"cols": N, "data": {"point-0": [...], ...}}
  <dir>/dataset-out.json  fluid.dataset of target vectors
  <dir>/model.json        fluid.mlpregressor               {"layers": [{"activation", "biases", "cols", "rows", "weights"}, ...]}
  <dir>/log/<session>.csv every incoming value with a timestamp (time, device, param, value)

Control messages (send to :9100)
  /ml/record            add (current inputs -> current targets) as one training pair
  /ml/train             fit the MLP on the recorded pairs, then save model.json
  /ml/predict <0|1>     turn live prediction on/off
  /ml/save              write datasets + model
  /ml/load              read datasets + model from disk
  /ml/clear             forget recorded pairs (does not delete files until /ml/save)
  /ml/status            resend status

Usage
  python3 ml-service.py --config ml-config.json
"""
import argparse, csv, json, signal, sys, threading, time
from datetime import datetime
from pathlib import Path

import numpy as np
from pythonosc.dispatcher import Dispatcher
from pythonosc.osc_server import ThreadingOSCUDPServer
from pythonosc.udp_client import SimpleUDPClient

# ---------------------------------------------------------------- FluCoMa MLP (forward pass + JSON I/O)

ACT_NAMES = {0: "identity", 1: "sigmoid", 2: "relu", 3: "tanh"}
SK_ACT    = {0: "identity", 1: "logistic", 2: "relu", 3: "tanh"}

def _act(code, z):
    if code == 0: return z
    if code == 1: return 1.0 / (1.0 + np.exp(-z))
    if code == 2: return np.maximum(z, 0.0)
    if code == 3: return np.tanh(z)
    raise ValueError(f"unknown activation {code}")

class FluidMLP:
    """Layers exactly as fluid.mlpregressor stores them: weights (rows=in, cols=out), biases, activation."""
    def __init__(self, layers):
        self.layers = []
        for l in layers:
            W = np.asarray(l["weights"], dtype=float)
            b = np.asarray(l["biases"], dtype=float)
            if W.shape != (l["rows"], l["cols"]) or b.shape != (l["cols"],):
                raise ValueError("layer shape mismatch")
            self.layers.append((W, b, int(l["activation"])))

    @property
    def n_in(self):  return self.layers[0][0].shape[0]
    @property
    def n_out(self): return self.layers[-1][0].shape[1]

    def forward(self, x):
        h = np.asarray(x, dtype=float)
        for W, b, a in self.layers:
            h = _act(a, h @ W + b)
        return h

    def to_json(self):
        return {"layers": [
            {"activation": a, "biases": b.tolist(), "cols": int(W.shape[1]), "rows": int(W.shape[0]),
             "weights": W.tolist()}
            for W, b, a in self.layers]}

    @staticmethod
    def from_json(j):
        return FluidMLP(j["layers"])

    @staticmethod
    def from_sklearn(reg, hidden_act, output_act=0):
        layers = []
        n = len(reg.coefs_)
        for i, (W, b) in enumerate(zip(reg.coefs_, reg.intercepts_)):
            a = output_act if i == n - 1 else hidden_act
            layers.append({"activation": a, "biases": b.tolist(), "cols": W.shape[1], "rows": W.shape[0],
                           "weights": W.tolist()})
        return FluidMLP(layers)

def dataset_to_json(rows):
    rows = np.asarray(rows, dtype=float)
    cols = int(rows.shape[1]) if rows.size else 0
    return {"cols": cols, "data": {f"point-{i}": r.tolist() for i, r in enumerate(rows)}}

def _id_order(k):
    # point-N sorts numerically (FluCoMa's default ids); anything else sorts after, alphabetically
    return (0, int(k[6:]), "") if k.startswith("point-") and k[6:].isdigit() else (1, 0, k)

def dataset_from_json(j, ids=None):
    """Rows of a fluid.dataset as an array. With ids, returns exactly those rows in that order."""
    data = j.get("data", {})
    keys = list(ids) if ids is not None else sorted(data.keys(), key=_id_order)
    rows = [data[k] for k in keys]
    arr = np.asarray(rows, dtype=float) if rows else np.zeros((0, int(j.get("cols", 0))))
    if arr.ndim != 2:
        raise ValueError("dataset rows must all have the same length")
    return arr

def paired_datasets(jin, jout):
    """Pair input/output datasets by id, the way FluCoMa does. Returns (X, Y, note)."""
    a, b = set(jin.get("data", {})), set(jout.get("data", {}))
    common = sorted(a & b, key=_id_order)
    note = "" if a == b else f" ({len(a - b) + len(b - a)} unpaired ids dropped)"
    return dataset_from_json(jin, common), dataset_from_json(jout, common), note

# ---------------------------------------------------------------- service

class MLService:
    def __init__(self, cfg, cfg_dir):
        self.inputs  = list(cfg["inputs"])            # e.g. ["tv/m"]
        self.outputs = list(cfg["outputs"])           # e.g. ["cassette/m"]
        self.hidden  = list(cfg.get("hidden", [8]))
        self.hidden_act = int(cfg.get("activation", 3))      # FluCoMa code; default tanh
        self.max_iter   = int(cfg.get("max_iter", 2000))
        self.rate_ms    = float(cfg.get("predict_interval_ms", 50))
        d = Path(cfg.get("dir", "data")).expanduser()
        self.dir = d if d.is_absolute() else (Path(cfg_dir) / d)   # relative = next to the config file
        self.dir.mkdir(parents=True, exist_ok=True)

        hub = cfg.get("hub", {"ip": "127.0.0.1", "port": 9000})
        self.hub = SimpleUDPClient(hub["ip"], int(hub["port"]))

        self.cur = {k: None for k in self.inputs + self.outputs}   # latest value per feature
        self.X, self.Y = [], []                                    # recorded pairs
        self.model = None
        self.predicting = False
        self.last_pred = 0.0
        self.lock = threading.Lock()

        logdir = self.dir / "log"; logdir.mkdir(exist_ok=True)
        session = datetime.now().strftime("%Y%m%d-%H%M%S")
        self.logf = open(logdir / f"{session}.csv", "w", newline="", buffering=1)   # line-buffered
        self.log = csv.writer(self.logf); self.log.writerow(["time", "device", "param", "value"])
        self.filelock = threading.Lock()                                           # serializes dataset/model writes

    # ---- outgoing
    def status(self, text):
        print("[ml]", text, flush=True)
        self.hub.send_message("/ml/status", text)

    def emit_prediction(self, y):
        for key, v in zip(self.outputs, y):
            v = float(min(1.0, max(0.0, v)))
            self.hub.send_message("/ml/" + key, v)

    # ---- incoming data
    def on_data(self, address, *args):
        parts = address.strip("/").split("/")
        if len(parts) < 2 or parts[0] == "ml" or not args:
            return
        try:
            v = float(args[0])
        except (TypeError, ValueError):
            return
        key = parts[0] + "/" + "/".join(parts[1:])
        with self.lock:
            self.log.writerow([f"{time.time():.3f}", parts[0], "/".join(parts[1:]), v])
            if key in self.cur:
                self.cur[key] = v
            do_pred = (self.predicting and key in self.inputs and self.model is not None
                       and (time.time() - self.last_pred) * 1000 >= self.rate_ms)
            if do_pred:
                x = [self.cur[k] for k in self.inputs]
                if any(e is None for e in x):
                    return
                self.last_pred = time.time()
                self.emit_prediction(self.model.forward(x))   # inside the lock so predictions stay in order

    # ---- control
    def on_record(self, *_):
        with self.lock:
            x = [self.cur[k] for k in self.inputs]; y = [self.cur[k] for k in self.outputs]
            if any(e is None for e in x + y):
                missing = [k for k in self.inputs + self.outputs if self.cur[k] is None]
                self.status("record refused, no value yet for: " + ", ".join(missing)); return
            self.X.append(x); self.Y.append(y); n = len(self.X)
        self.status(f"recorded pair {n}: in={x} out={y}")
        self.save_datasets()

    def on_train(self, *_):
        from sklearn.neural_network import MLPRegressor
        with self.lock:
            if len(self.X) < 2:
                self.status("train refused, need at least 2 recorded pairs"); return
            X = np.asarray(self.X); Y = np.asarray(self.Y)
        reg = MLPRegressor(hidden_layer_sizes=tuple(self.hidden), activation=SK_ACT[self.hidden_act],
                           solver="lbfgs", max_iter=self.max_iter, tol=1e-6, random_state=0)
        reg.fit(X, Y if Y.shape[1] > 1 else Y.ravel())
        model = FluidMLP.from_sklearn(reg, self.hidden_act, output_act=0)
        pred = np.array([model.forward(x) for x in X]).reshape(Y.shape)
        loss = float(np.mean((pred - Y) ** 2))
        with self.lock:
            self.model = model
        self.save_model()
        self.status(f"trained on {len(X)} pairs, hidden={self.hidden} act={ACT_NAMES[self.hidden_act]}, mse={loss:.5f}")

    def on_predict(self, _addr, *args):
        a = args[0] if args else 1
        if isinstance(a, str):
            a = a.strip().lower()
            if a in ("on", "1", "true", "yes"): on = True
            elif a in ("off", "0", "false", "no"): on = False
            else: self.status(f"predict refused, bad argument {a!r} (use 1/0 or on/off)"); return
        else:
            try: on = float(a) != 0.0
            except (TypeError, ValueError): self.status(f"predict refused, bad argument {a!r}"); return
        with self.lock:
            if on and self.model is None:
                self.status("predict refused, no model (train or load first)"); return
            self.predicting = on
        self.status("predict " + ("on" if on else "off"))

    def on_clear(self, *_):
        with self.lock:
            self.X, self.Y = [], []
        self.status("cleared recorded pairs")

    def on_status(self, *_):
        with self.lock:
            self.status(f"pairs={len(self.X)} model={'yes' if self.model else 'no'} predict={'on' if self.predicting else 'off'} "
                        f"inputs={self.inputs} outputs={self.outputs} cur={self.cur}")

    # ---- files
    def save_datasets(self):
        with self.lock:
            X, Y = list(self.X), list(self.Y)
        with self.filelock:
            (self.dir / "dataset-in.json").write_text(json.dumps(dataset_to_json(X), indent=2))
            (self.dir / "dataset-out.json").write_text(json.dumps(dataset_to_json(Y), indent=2))

    def save_model(self):
        with self.lock:
            m = self.model
        if m is not None:
            with self.filelock:
                (self.dir / "model.json").write_text(json.dumps(m.to_json(), indent=2))

    def on_save(self, *_):
        self.save_datasets(); self.save_model()
        self.status(f"saved to {self.dir}")

    def on_load(self, *_):
        """Load datasets and model from disk. Never raises: a bad file is reported in the status, not fatal."""
        msgs = []
        fi, fo, fm = self.dir / "dataset-in.json", self.dir / "dataset-out.json", self.dir / "model.json"
        if fi.exists() and fo.exists():
            try:
                X, Y, note = paired_datasets(json.loads(fi.read_text()), json.loads(fo.read_text()))
                if len(X) == 0 or (X.shape[1] == len(self.inputs) and Y.shape[1] == len(self.outputs)):
                    with self.lock:
                        self.X, self.Y = X.tolist(), Y.tolist()
                    msgs.append(f"{len(X)} pairs{note}")
                else:
                    msgs.append(f"datasets skipped ({X.shape[1]}->{Y.shape[1]} does not match config {len(self.inputs)}->{len(self.outputs)})")
            except (ValueError, KeyError, TypeError, IndexError, json.JSONDecodeError) as e:
                msgs.append(f"datasets skipped ({type(e).__name__}: {e})")
        if fm.exists():
            try:
                m = FluidMLP.from_json(json.loads(fm.read_text()))
                if m.n_in == len(self.inputs) and m.n_out == len(self.outputs):
                    with self.lock:
                        self.model = m
                    msgs.append("model")
                else:
                    msgs.append(f"model skipped ({m.n_in}->{m.n_out} does not match config {len(self.inputs)}->{len(self.outputs)})")
            except (ValueError, KeyError, TypeError, IndexError, json.JSONDecodeError) as e:
                msgs.append(f"model skipped ({type(e).__name__}: {e})")
        self.status("loaded " + (", ".join(msgs) if msgs else "nothing (no files)"))

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=str(Path(__file__).with_name("ml-config.json")))
    ap.add_argument("--listen", type=int, default=9100)
    a = ap.parse_args()
    cfg_path = Path(a.config)
    cfg = json.loads(cfg_path.read_text())
    svc = MLService(cfg, cfg_path.parent)

    d = Dispatcher()
    d.map("/ml/record",  svc.on_record)
    d.map("/ml/train",   svc.on_train)
    d.map("/ml/predict", svc.on_predict)
    d.map("/ml/save",    svc.on_save)
    d.map("/ml/load",    svc.on_load)
    d.map("/ml/clear",   svc.on_clear)
    d.map("/ml/status",  svc.on_status)
    d.set_default_handler(svc.on_data)

    server = ThreadingOSCUDPServer(("0.0.0.0", a.listen), d)
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))   # systemd stop -> finally: closes the log
    svc.on_load()
    svc.status(f"ml-service listening :{a.listen}, inputs={svc.inputs} outputs={svc.outputs}")
    try:
        server.serve_forever()
    finally:
        svc.logf.close()

if __name__ == "__main__":
    main()
