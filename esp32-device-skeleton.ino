// ESP32 device skeleton following the hub contract.
// Libraries (Arduino Library Manager): "OSC" by Adrian Freed / CNMAT.
#include <WiFi.h>
#include <WiFiUdp.h>
#include <OSCMessage.h>

const char* SSID     = "PERFNET";
const char* PASS     = "perfnet123";
const char* DEVICE   = "cassette";      // one word, unique per device
IPAddress   HUB_IP(10, 42, 0, 1);       // Pi hotspot default; change if on a LAN
const int   HUB_PORT = 9000;
const int   MY_PORT  = 9001;

WiFiUDP udp;
float speedLocal = 0.5f;   // from the slider pot
float speedRemote = -1.0f; // -1 = no remote override active

void setup() {
  Serial.begin(115200);
  WiFi.begin(SSID, PASS);
  while (WiFi.status() != WL_CONNECTED) { delay(250); Serial.print("."); }
  Serial.println(WiFi.localIP());
  udp.begin(MY_PORT);
}

void publish(const char* param, float v) {
  char addr[48];
  snprintf(addr, sizeof(addr), "/%s/%s", DEVICE, param);
  OSCMessage m(addr);
  m.add(v);
  udp.beginPacket(HUB_IP, HUB_PORT);
  m.send(udp);
  udp.endPacket();
  m.empty();
}

void handleSet(OSCMessage& m) {
  // address was /<DEVICE>/set/<param>; m matched on "/set/speed" below
  if (m.isFloat(0)) speedRemote = m.getFloat(0);
}

void loop() {
  // 1. read sensors (replace with real pot read)
  speedLocal = analogRead(34) / 4095.0f;

  // 2. receive commands
  OSCMessage in;
  int size = udp.parsePacket();
  if (size > 0) {
    while (size--) in.fill(udp.read());
    if (!in.hasError()) {
      char prefix[32];
      snprintf(prefix, sizeof(prefix), "/%s/set/speed", DEVICE);
      in.dispatch(prefix, handleSet);
    }
  }

  // 3. arbitration: remote overrides local when present (swap for multiply/offset later)
  float speed = (speedRemote >= 0) ? speedRemote : speedLocal;
  // -> drive L298N PWM from `speed` here

  // 4. publish state at 20 Hz
  static uint32_t last = 0;
  if (millis() - last >= 50) {
    last = millis();
    publish("speed", speed);
  }
}
