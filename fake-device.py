#!/usr/bin/env python3
"""Simulated device for testing the hub from your Mac (or any machine).

  pip3 install python-osc
  python3 fake-device.py --hub 192.168.1.50 --name cassette

Publishes /<name>/speed as a slow sine 0..1 at 20 Hz to hub:9000,
and listens on :9001 for /<name>/set/<param> commands from the hub.
Run two copies with --name cassette and --name turntable to watch routing work.
"""
import argparse, math, threading, time
from pythonosc.udp_client import SimpleUDPClient
from pythonosc.dispatcher import Dispatcher
from pythonosc.osc_server import BlockingOSCUDPServer

ap = argparse.ArgumentParser()
ap.add_argument("--hub", required=True, help="hub IP")
ap.add_argument("--name", default="cassette")
ap.add_argument("--listen", type=int, default=9001)
args = ap.parse_args()

client = SimpleUDPClient(args.hub, 9000)

def on_set(address, *vals):
    print(f"[{args.name}] command {address} {vals}")

disp = Dispatcher()
disp.map(f"/{args.name}/set/*", on_set)
server = BlockingOSCUDPServer(("0.0.0.0", args.listen), disp)
threading.Thread(target=server.serve_forever, daemon=True).start()
print(f"[{args.name}] -> hub {args.hub}:9000, listening :{args.listen}")

t0 = time.time()
while True:
    v = 0.5 + 0.5 * math.sin((time.time() - t0) * 0.5)
    client.send_message(f"/{args.name}/speed", float(v))
    time.sleep(0.05)
