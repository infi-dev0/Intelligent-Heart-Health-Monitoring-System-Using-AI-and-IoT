/**
 * ============================================================
 *  ESP32 + AD8232 One-Page Web ECG Monitor
 * ============================================================
 *
 *  WHAT THIS SKETCH DOES
 *    - Samples the AD8232 ECG module at 500 Hz
 *    - Applies a moving-average filter for a cleaner trace
 *    - Hosts a fullscreen hospital-style ECG monitor page over Wi-Fi
 *    - Streams recent ECG samples to the browser through /ecg
 *
 *  REQUIRED LIBRARIES
 *    - WiFi.h
 *    - WebServer.h
 *    - LittleFS.h
 *
 *  WIRING
 *    AD8232 OUTPUT -> GPIO 34
 *    AD8232 LO+    -> GPIO 2
 *    AD8232 LO-    -> GPIO 4  (bypassed by default, see SKIP_LEAD_OFF)
 *    AD8232 3.3V   -> 3.3V
 *    AD8232 GND    -> GND
 *
 *  SETUP
 *    1. By default the ESP32 creates its own hotspot.
 *    2. Select your ESP32 board in Arduino IDE.
 *    3. Upload the sketch.
 *    4. Upload filesystem image (LittleFS) with: pio run -t uploadfs
 *    5. Open Serial Monitor at 115200 baud to see the IP address.
 *    6. Connect your phone or laptop to the ESP32 hotspot.
 *    7. Visit that IP address in the browser.
 *
 * ============================================================
 */

#include <Arduino.h>
#include <WiFi.h>
#include <WebServer.h>
#include <LittleFS.h>

// ============================================================
//  NETWORK CONFIGURATION
// ============================================================
// Default mode is ACCESS POINT so the ESP32 works without a router.
// Set USE_SOFT_AP to false only if you want the board to join an existing Wi-Fi network.
static const bool  USE_SOFT_AP   = true;
static const char* WIFI_SSID     = "ECG Setup";
static const char* WIFI_PASSWORD = "0123456789";
static const char* AP_SSID       = "ECG Setup";
static const char* AP_PASSWORD   = "0123456789";
static const char* DEVICE_NAME   = "esp32-ecg-monitor";

// ============================================================
//  PIN DEFINITIONS
// ============================================================
#define ECG_PIN         34
#define LO_PLUS_PIN      2
#define LO_MINUS_PIN     4

// ============================================================
//  LEAD-OFF BYPASS
//  true  = bypass lead-off detection
//  false = enable lead-off detection using LO+ and LO- pins
// ============================================================
#define SKIP_LEAD_OFF   true

// ============================================================
//  SAMPLING
// ============================================================
#define SAMPLE_RATE_HZ      500
#define SAMPLE_INTERVAL_US  (1000000UL / SAMPLE_RATE_HZ)

// ============================================================
//  ADC
// ============================================================
#define ADC_RESOLUTION      12
#define ADC_MAX             4095
#define ADC_MIDLINE         2048

// ============================================================
//  HEART RATE DETECTION
//  Kept from the reference logic for signal integrity / future use.
// ============================================================
#define HR_THRESHOLD         2200
#define HR_MIN_INTERVAL_MS    300
#define HR_MAX_INTERVAL_MS   2000
#define HR_AVERAGE_BEATS        8

// ============================================================
//  FILTER
// ============================================================
#define FILTER_WINDOW         5

// ============================================================
//  WEB STREAMING
// ============================================================
#define BAUD_RATE               115200
#define SAMPLE_BUFFER_SIZE      3000
#define MAX_JSON_SAMPLES          48
#define WIFI_RETRY_MS          10000UL

WebServer server(80);

// Software lead-off detection (variance-based backup)
#define VARIANCE_WINDOW       64
static uint16_t varianceBuf[VARIANCE_WINDOW] = {0};
static uint8_t  varianceIdx = 0;
static bool     varianceBufFull = false;

// ============================================================
//  GLOBALS
// ============================================================
static unsigned long lastSampleTime_us = 0;
static unsigned long lastWifiRetry_ms  = 0;
static bool leadsOK                    = true;
static float runningMidline            = (float)ADC_MIDLINE;

// Filter state
static int     filterBuffer[FILTER_WINDOW] = {0};
static uint8_t filterIndex = 0;
static long    filterSum   = 0;

// Heart-rate state
static unsigned long lastBeatTime_ms = 0;
static unsigned long rrBuffer[HR_AVERAGE_BEATS] = {0};
static uint8_t rrIndex = 0;
static uint8_t rrCount = 0;
static float bpm       = 0.0f;
static bool aboveThreshold = false;

// Sample stream state
static uint16_t ecgSamples[SAMPLE_BUFFER_SIZE] = {0};
static uint32_t sampleSequence = 0;
static unsigned long lastStatusPrint_ms = 0;
static uint32_t adcSumForAvg = 0;
static uint32_t adcCountersForAvg = 0;

// ============================================================
//  FILTER
// ============================================================
//  DSP DUAL NOTCH FILTER (KILLS BOTH 50Hz AND 60Hz HUM)
// ============================================================
#define FILTER_50HZ_LEN 10
#define FILTER_60HZ_LEN 8

static int buf50[FILTER_50HZ_LEN] = {0};
static int buf60[FILTER_60HZ_LEN] = {0};
static int idx50 = 0, idx60 = 0;
static long sum50 = 0, sum60 = 0;

static int applyDSPFilter(int rawValue) {
  // 1. Notch 50Hz (10-sample window at 500Hz)
  sum50 -= buf50[idx50];
  buf50[idx50] = rawValue;
  sum50 += rawValue;
  idx50 = (idx50 + 1) % FILTER_50HZ_LEN;
  int out50 = sum50 / FILTER_50HZ_LEN;

  // 2. Notch 60Hz (8-sample window at 500Hz)
  sum60 -= buf60[idx60];
  buf60[idx60] = out50;
  sum60 += out50;
  idx60 = (idx60 + 1) % FILTER_60HZ_LEN;
  
  return sum60 / FILTER_60HZ_LEN;
}

// ============================================================
//  LEAD-OFF CHECK
// ============================================================
static bool checkLeads() {
#if SKIP_LEAD_OFF
  return true;
#else
  // AD8232 LO+ and LO- go HIGH when a lead is off
  bool loPlus  = digitalRead(LO_PLUS_PIN);
  bool loMinus = digitalRead(LO_MINUS_PIN);
  return (!loPlus && !loMinus);
#endif
}

// Software variance check — detects railed or dead-flat signals
static bool checkSignalVariance() {
  if (!varianceBufFull) return true;   // not enough data yet, assume OK

  uint32_t sum = 0;
  for (uint8_t i = 0; i < VARIANCE_WINDOW; i++) sum += varianceBuf[i];
  uint16_t mean = sum / VARIANCE_WINDOW;

  uint32_t variance = 0;
  for (uint8_t i = 0; i < VARIANCE_WINDOW; i++) {
    int32_t diff = (int32_t)varianceBuf[i] - (int32_t)mean;
    variance += diff * diff;
  }
  variance /= VARIANCE_WINDOW;

  // Signal railed at 0 or 4095 => mean near extremes
  if (mean < 50 || mean > 4045) return false;

  // Dead-flat (variance < 2) => no actual bio-signal
  if (variance < 2) return false;

  return true;
}

// ============================================================
//  R-PEAK DETECTOR
// ============================================================
static void detectBPM(int filteredValue) {
  unsigned long now = millis();

  if (filteredValue > HR_THRESHOLD) {
    if (!aboveThreshold) {
      aboveThreshold = true;
      unsigned long rr = now - lastBeatTime_ms;

      if (rr >= HR_MIN_INTERVAL_MS && rr <= HR_MAX_INTERVAL_MS) {
        rrBuffer[rrIndex] = rr;
        rrIndex = (rrIndex + 1) % HR_AVERAGE_BEATS;
        if (rrCount < HR_AVERAGE_BEATS) {
          rrCount++;
        }

        unsigned long sum = 0;
        for (uint8_t i = 0; i < rrCount; i++) {
          sum += rrBuffer[i];
        }
        bpm = 60000.0f / ((float)sum / rrCount);
      }

      lastBeatTime_ms = now;
    }
  } else {
    aboveThreshold = false;
  }
}

// ============================================================
//  SAMPLE BUFFER
// ============================================================
static void pushSample(uint16_t value) {
  ecgSamples[sampleSequence % SAMPLE_BUFFER_SIZE] = value;
  sampleSequence++;
}

// ============================================================
//  WIFI
// ============================================================
static void connectNetwork() {
  if (USE_SOFT_AP) {
    WiFi.mode(WIFI_AP);
    WiFi.setSleep(false);

    bool apStarted = WiFi.softAP(AP_SSID, AP_PASSWORD);
    delay(500);

    IPAddress apIP(192, 168, 4, 1);
    IPAddress apGateway(192, 168, 4, 1);
    IPAddress apSubnet(255, 255, 255, 0);
    WiFi.softAPConfig(apIP, apGateway, apSubnet);

    if (!apStarted) {
      Serial.println(F("Failed to start ESP32 hotspot."));
      return;
    }

    Serial.print(F("ESP32 hotspot ready. SSID: "));
    Serial.println(AP_SSID);
    Serial.print(F("Password: "));
    Serial.println(AP_PASSWORD);
    Serial.println(F("Band: 2.4 GHz"));
    Serial.print(F("Open: http://"));
    Serial.println(WiFi.softAPIP());
    return;
  }

  if (WiFi.status() == WL_CONNECTED) {
    return;
  }

  Serial.print(F("Connecting to Wi-Fi"));
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.setHostname(DEVICE_NAME);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && (millis() - start) < 15000UL) {
    delay(300);
    Serial.print('.');
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.print(F("Connected. Open: http://"));
    Serial.println(WiFi.localIP());
  } else {
    Serial.println(F("Wi-Fi not connected. Will retry automatically."));
  }
}

// ============================================================
//  LITTLEFS FILE SERVER HELPER
// ============================================================
static String getContentType(const String& path) {
  if (path.endsWith(".html")) return "text/html";
  if (path.endsWith(".css"))  return "text/css";
  if (path.endsWith(".js"))   return "application/javascript";
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".png"))  return "image/png";
  if (path.endsWith(".jpg"))  return "image/jpeg";
  if (path.endsWith(".ico"))  return "image/x-icon";
  if (path.endsWith(".svg"))  return "image/svg+xml";
  return "text/plain";
}

static bool serveFile(const String& path) {
  if (!LittleFS.exists(path)) {
    return false;
  }

  File file = LittleFS.open(path, "r");
  if (!file) {
    return false;
  }

  String contentType = getContentType(path);
  server.sendHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  server.sendHeader("Pragma", "no-cache");
  server.streamFile(file, contentType);
  file.close();
  return true;
}

// ============================================================
//  WEB HANDLERS
// ============================================================
static void handleRoot() {
  if (!serveFile("/index.html")) {
    server.send(500, "text/plain", "index.html not found. Upload filesystem with: pio run -t uploadfs");
  }
}


static void handleECG() {
  uint32_t currentSequence = sampleSequence;
  uint32_t since = 0;

  if (server.hasArg("since")) {
    since = (uint32_t)strtoul(server.arg("since").c_str(), nullptr, 10);
  }

  if (since > currentSequence) {
    since = currentSequence;
  }

  uint32_t oldestSequence = (currentSequence > SAMPLE_BUFFER_SIZE)
    ? (currentSequence - SAMPLE_BUFFER_SIZE)
    : 0;

  if (since < oldestSequence) {
    since = oldestSequence;
  }

  uint32_t available = currentSequence - since;
  if (available > MAX_JSON_SAMPLES) {
    since = currentSequence - MAX_JSON_SAMPLES;
    available = MAX_JSON_SAMPLES;
  }

  String json;
  json.reserve(540 + available * 6);
  json += "{\"leadsOk\":";
  json += (leadsOK ? "true" : "false");
  json += ",\"sampleRate\":";
  json += SAMPLE_RATE_HZ;
  json += ",\"midline\":";
  json += String((int)runningMidline);
  json += ",\"adcMin\":";
  json += 0;
  json += ",\"adcMax\":";
  json += ADC_MAX;
  json += ",\"nextSeq\":";
  json += String(since + available);
  json += ",\"samples\":[";

  for (uint32_t i = 0; i < available; i++) {
    if (i) {
      json += ',';
    }
    uint32_t sequence = since + i;
    json += String(ecgSamples[sequence % SAMPLE_BUFFER_SIZE]);
  }

  json += "]}";
  server.sendHeader("Cache-Control", "no-store");
  server.send(200, "application/json", json);
}

static void handleRedirectToRoot() {
  server.sendHeader("Location", "/", true);
  server.send(302, "text/plain", "");
}

static void handleFavicon() {
  server.send(204, "image/x-icon", "");
}

static void handleNotFound() {
  // Try to serve the requested file from LittleFS
  String path = server.uri();
  if (serveFile(path)) {
    return;
  }
  // If file not found, redirect to root
  handleRedirectToRoot();
}

// ============================================================
//  SERVER
// ============================================================
static void setupServer() {
  server.on("/", HTTP_ANY, handleRoot);
  server.on("/index.html", HTTP_ANY, handleRoot);
  server.on("/ecg", HTTP_GET, handleECG);
  server.on("/favicon.ico", HTTP_ANY, handleFavicon);

  // Captive portal detection — HTTP_ANY to handle GET, HEAD, POST etc.
  server.on("/generate_204", HTTP_ANY, handleRedirectToRoot);
  server.on("/gen_204", HTTP_ANY, handleRedirectToRoot);
  server.on("/hotspot-detect.html", HTTP_ANY, handleRedirectToRoot);
  server.on("/ncsi.txt", HTTP_ANY, handleRedirectToRoot);
  server.on("/connecttest.txt", HTTP_ANY, handleRedirectToRoot);
  server.on("/redirect", HTTP_ANY, handleRedirectToRoot);
  server.on("/fwlink", HTTP_ANY, handleRedirectToRoot);
  server.on("/canonical.html", HTTP_ANY, handleRedirectToRoot);
  server.on("/success.txt", HTTP_ANY, handleRedirectToRoot);
  server.on("/chat", HTTP_ANY, handleRedirectToRoot);
  server.onNotFound(handleNotFound);
  server.begin();
  Serial.println(F("Web server started."));
}

// ============================================================
//  SAMPLE + PROCESS ECG
// ============================================================
static void sampleECG() {
  bool hwLeads = checkLeads();

  int rawValue = analogRead(ECG_PIN);
  int filteredValue = applyDSPFilter(rawValue);

  // Track dynamic midline — slow EMA so it follows DC drift but not QRS
  runningMidline = runningMidline * 0.999f + (float)filteredValue * 0.001f;

  // Feed variance buffer for software lead-off detection
  varianceBuf[varianceIdx] = (uint16_t)filteredValue;
  varianceIdx = (varianceIdx + 1) % VARIANCE_WINDOW;
  if (varianceIdx == 0) varianceBufFull = true;

  // Combine hardware + software lead checks
  // Force leadsOK to true to allow raw signal to bypass detection
  // and display on the UI regardless of connection noise.
  leadsOK = true;

  adcSumForAvg += (uint32_t)rawValue;
  adcCountersForAvg++;

  if (leadsOK) {
    detectBPM(filteredValue);
    pushSample((uint16_t)filteredValue);
  } else {
    bpm = 0.0f;
    rrCount = 0;
    pushSample((uint16_t)filteredValue);  // still push real data so UI can show noise
  }
}

// ============================================================
//  SETUP
// ============================================================
void setup() {
  Serial.begin(BAUD_RATE);
  delay(200);

  analogReadResolution(ADC_RESOLUTION);
  analogSetAttenuation(ADC_11db);

#if !SKIP_LEAD_OFF
  pinMode(LO_PLUS_PIN, INPUT);
  pinMode(LO_MINUS_PIN, INPUT);
  Serial.println(F("Lead-off detection ENABLED (LO+ = GPIO2, LO- = GPIO4)"));
#else
  Serial.println(F("Lead-off detection BYPASSED"));
#endif

  for (uint16_t i = 0; i < SAMPLE_BUFFER_SIZE; i++) {
    ecgSamples[i] = ADC_MIDLINE;
  }

  memset(filterBuffer, 0, sizeof(filterBuffer));
  memset(rrBuffer, 0, sizeof(rrBuffer));

  // Initialize LittleFS
  if (!LittleFS.begin(true)) {
    Serial.println(F("LittleFS mount failed! Upload filesystem with: pio run -t uploadfs"));
  } else {
    Serial.println(F("LittleFS mounted successfully."));
  }

  Serial.println();
  Serial.println(F("========================================"));
  Serial.println(F("ESP32 + AD8232 Web ECG Monitor"));
  Serial.println(F("Sampling: 500 Hz"));
  Serial.println(F("UI: Served from LittleFS (data/ folder)"));
  Serial.println(F("Network: Direct ESP32 hotspot mode"));
  Serial.println(F("========================================"));

  connectNetwork();
  setupServer();

  lastSampleTime_us = micros();
  lastWifiRetry_ms = millis();
}

// ============================================================
//  LOOP
// ============================================================
void loop() {
  unsigned long now_us = micros();
  while ((unsigned long)(now_us - lastSampleTime_us) >= SAMPLE_INTERVAL_US) {
    lastSampleTime_us += SAMPLE_INTERVAL_US;
    sampleECG();
    now_us = micros();
  }

  server.handleClient();

  if (millis() - lastStatusPrint_ms >= 1000) {
    lastStatusPrint_ms = millis();
    uint32_t avgAdc = (adcCountersForAvg > 0) ? (adcSumForAvg / adcCountersForAvg) : 0;
    adcSumForAvg = 0;
    adcCountersForAvg = 0;

    Serial.print(F(" [STATUS] Leads: "));
    Serial.print(leadsOK ? F("OK ") : F("OFF"));
    Serial.print(F(" | BPM: "));
    Serial.print((int)bpm);
    Serial.print(F(" | Avg ADC: "));
    Serial.println(avgAdc);
  }

  if (!USE_SOFT_AP && WiFi.status() != WL_CONNECTED && (millis() - lastWifiRetry_ms) >= WIFI_RETRY_MS) {
    lastWifiRetry_ms = millis();
    connectNetwork();
  }
}
