// pihub cassette device: ESP32 + L298N (motor PWM) + slide pot + SSD1306 OLED.
//
// Publishes  /cassette/m    effective motor speed 0..1   (20 Hz)
//            /cassette/pot  raw slider position 0..1     (20 Hz)  <- usable as a sensor even while remote-controlled
// Listens    /cassette/set/m <float>  on UDP 9001        -> drives the L298N
//
// Arbitration: the slider is the base. A hub command takes over for REMOTE_HOLD_MS after the last command
// (the hub streams at 20 Hz while predicting, so control stays remote until it stops). Moving the slider
// by more than GRAB_DELTA hands control back to the performer, and it stays local until the hub has been
// silent for REMOTE_HOLD_MS; the next command after that starts a new remote session.
//
// Libraries (Arduino Library Manager): "OSC" (CNMAT), "Adafruit SSD1306", "Adafruit GFX Library".
// Board: ESP32 Dev Module. Works on arduino-esp32 core 2.x and 3.x.

#include <WiFi.h>
#include <WiFiUdp.h>
#include <OSCMessage.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

// ---- network (hub hotspot defaults; change for a LAN)
const char* SSID     = "PERFNET";
const char* PASS     = "perfnet123";
IPAddress   HUB_IP(10, 42, 0, 1);
const int   HUB_PORT = 9000;
const int   MY_PORT  = 9001;
const char* DEVICE   = "cassette";

// ---- pins
const int PIN_POT = 34;   // ADC1 (ADC2 pins do not work while WiFi is on)
const int PIN_ENA = 25;   // L298N ENA (PWM)
const int PIN_IN1 = 26;   // L298N IN1
const int PIN_IN2 = 27;   // L298N IN2
// OLED on I2C: SDA 21, SCL 22 (ESP32 defaults)

// ---- behaviour
const int      PWM_FREQ        = 20000;  // Hz, above audible range
const int      PWM_BITS        = 8;
const int      MIN_DUTY        = 60;     // lowest duty that still turns the motor; measure yours
const uint32_t REMOTE_HOLD_MS  = 1000;   // fall back to the slider this long after the last hub command
const float    GRAB_DELTA      = 0.03f;  // slider movement that reclaims control
const float    POT_SMOOTH      = 0.2f;   // EMA factor for the ADC

WiFiUDP udp;
Adafruit_SSD1306 oled(128, 64, &Wire, -1);
bool oledOk = false;

float potVal = 0.0f, potRef = 0.0f;
float speedRemote = 0.0f;
uint32_t remoteUntil = 0;
bool localOverride = false;   // performer grabbed the slider during a remote session
float speedOut = 0.0f;

// ---- PWM across core versions
void pwmSetup() {
#if defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcAttach(PIN_ENA, PWM_FREQ, PWM_BITS);
#else
  ledcSetup(0, PWM_FREQ, PWM_BITS);
  ledcAttachPin(PIN_ENA, 0);
#endif
}
void pwmWrite(uint32_t duty) {
#if defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcWrite(PIN_ENA, duty);
#else
  ledcWrite(0, duty);
#endif
}

void setMotor(float s) {              // s in 0..1
  s = constrain(s, 0.0f, 1.0f);
  uint32_t duty = (s <= 0.005f) ? 0 : (uint32_t)(MIN_DUTY + s * (255 - MIN_DUTY));
  pwmWrite(duty);
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

void onSetM(OSCMessage& m) {
  if (m.isFloat(0))      speedRemote = m.getFloat(0);
  else if (m.isInt(0))   speedRemote = (float)m.getInt(0);
  else return;
  speedRemote = constrain(speedRemote, 0.0f, 1.0f);
  uint32_t now = millis();
  if ((int32_t)(remoteUntil - now) <= 0) { potRef = potVal; localOverride = false; }   // new remote session
  remoteUntil = now + REMOTE_HOLD_MS;
}

void drawOled(bool remote) {
  if (!oledOk) return;
  oled.clearDisplay();
  oled.setTextColor(SSD1306_WHITE);
  oled.setTextSize(1);
  oled.setCursor(0, 0);
  oled.print(remote ? "REMOTE" : "LOCAL ");
  oled.print("  ");
  oled.print(WiFi.status() == WL_CONNECTED ? WiFi.localIP().toString() : String("no wifi"));
  oled.setTextSize(3);
  oled.setCursor(0, 18);
  oled.print(speedOut, 2);
  oled.setTextSize(1);
  oled.setCursor(0, 54);
  oled.print("pot ");
  oled.print(potVal, 2);
  oled.display();
}

void setup() {
  Serial.begin(115200);
  pinMode(PIN_IN1, OUTPUT); pinMode(PIN_IN2, OUTPUT);
  digitalWrite(PIN_IN1, HIGH); digitalWrite(PIN_IN2, LOW);   // one direction
  pwmSetup(); setMotor(0);
  analogReadResolution(12);

  Wire.begin();
  oledOk = oled.begin(SSD1306_SWITCHCAPVCC, 0x3C);
  if (oledOk) { oled.clearDisplay(); oled.setTextColor(SSD1306_WHITE); oled.setCursor(0,0); oled.print("connecting..."); oled.display(); }

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);                  // lower latency for UDP
  WiFi.begin(SSID, PASS);
  udp.begin(MY_PORT);
  potVal = potRef = analogRead(PIN_POT) / 4095.0f;
}

void loop() {
  uint32_t now = millis();

  // 1. wifi watchdog (non-blocking)
  static uint32_t lastReconnect = 0;
  if (WiFi.status() != WL_CONNECTED && now - lastReconnect > 5000) { lastReconnect = now; WiFi.reconnect(); }

  // 2. slider
  float raw = analogRead(PIN_POT) / 4095.0f;
  potVal += POT_SMOOTH * (raw - potVal);

  // 3. commands from the hub
  OSCMessage in;
  int size = udp.parsePacket();
  if (size > 0) {
    while (size--) in.fill(udp.read());
    if (!in.hasError()) {
      char pattern[32];
      snprintf(pattern, sizeof(pattern), "/%s/set/m", DEVICE);
      in.dispatch(pattern, onSetM);
    }
  }

  // 4. arbitration
  bool remoteActive = (int32_t)(remoteUntil - now) > 0;
  if (!remoteActive) localOverride = false;
  else if (!localOverride && fabsf(potVal - potRef) > GRAB_DELTA) localOverride = true;   // performer grabs back
  bool remote = remoteActive && !localOverride;
  speedOut = remote ? speedRemote : potVal;
  setMotor(speedOut);

  // 5. publish at 20 Hz
  static uint32_t lastPub = 0;
  if (now - lastPub >= 50) {
    lastPub = now;
    if (WiFi.status() == WL_CONNECTED) { publish("m", speedOut); publish("pot", potVal); }
  }

  // 6. display at 10 Hz
  static uint32_t lastDraw = 0;
  if (now - lastDraw >= 100) { lastDraw = now; drawOled(remote); }
}
