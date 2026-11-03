/*
 * RelicGuard uplink for the ESP32 (Arduino core).
 *
 * Reads one sample line at a time from the MCXC444 over UART and POSTs it to the
 * dashboard's /api/readings as JSON, with INGEST_TOKEN as a Bearer token.
 *
 * Wiring: MCXC UART TX -> ESP32 GPIO16 (RX2), GND -> GND. Both run at 3.3 V.
 *
 * Line format expected from the board (proposed; one field per SensorData_t member):
 *   RG,<doorValid>,<doorOpen>,<lightValid>,<lightPercent>,<climateValid>,<temperatureX10>,<humidityX10>
 *   e.g. RG,1,0,1,38,1,214,472
 * which the MonitorTask could print with:
 *   PRINTF("RG,%d,%d,%d,%u,%d,%d,%u\r\n", snapshot.doorValid, snapshot.doorOpen,
 *          snapshot.lightValid, snapshot.lightPercent, snapshot.climateValid,
 *          snapshot.temperatureX10, snapshot.humidityX10);
 * Other lines (the human-readable status block) are ignored.
 */

#include <HTTPClient.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>

/* ---------- Settings ---------- */

const char *WIFI_SSID = "your-wifi-name";
const char *WIFI_PASSWORD = "your-wifi-password";
const char *INGEST_URL = "https://relicguard-dashboard.onrender.com/api/readings";
const char *INGEST_TOKEN = "paste-the-INGEST_TOKEN-from-render";

const uint32_t SEND_EVERY_MS = 2000;
const uint32_t BOARD_STALE_MS = 5000; // stop sending if the board goes quiet
const int BOARD_RX_PIN = 16;
const int BOARD_TX_PIN = 17;
const uint32_t BOARD_BAUD = 115200;

/* Root certificates: GTS Root R4 signs *.onrender.com; ISRG Root X1 (Let's
 * Encrypt) covers a custom domain. Valid until 2036 and 2035. */
static const char ROOT_CAS[] = R"PEM(
-----BEGIN CERTIFICATE-----
MIICCTCCAY6gAwIBAgINAgPlwGjvYxqccpBQUjAKBggqhkjOPQQDAzBHMQswCQYD
VQQGEwJVUzEiMCAGA1UEChMZR29vZ2xlIFRydXN0IFNlcnZpY2VzIExMQzEUMBIG
A1UEAxMLR1RTIFJvb3QgUjQwHhcNMTYwNjIyMDAwMDAwWhcNMzYwNjIyMDAwMDAw
WjBHMQswCQYDVQQGEwJVUzEiMCAGA1UEChMZR29vZ2xlIFRydXN0IFNlcnZpY2Vz
IExMQzEUMBIGA1UEAxMLR1RTIFJvb3QgUjQwdjAQBgcqhkjOPQIBBgUrgQQAIgNi
AATzdHOnaItgrkO4NcWBMHtLSZ37wWHO5t5GvWvVYRg1rkDdc/eJkTBa6zzuhXyi
QHY7qca4R9gq55KRanPpsXI5nymfopjTX15YhmUPoYRlBtHci8nHc8iMai/lxKvR
HYqjQjBAMA4GA1UdDwEB/wQEAwIBhjAPBgNVHRMBAf8EBTADAQH/MB0GA1UdDgQW
BBSATNbrdP9JNqPV2Py1PsVq8JQdjDAKBggqhkjOPQQDAwNpADBmAjEA6ED/g94D
9J+uHXqnLrmvT/aDHQ4thQEd0dlq7A/Cr8deVl5c1RxYIigL9zC2L7F8AjEA8GE8
p/SgguMh1YQdc4acLa/KNJvxn7kjNuK8YAOdgLOaVsjh4rsUecrNIdSUtUlD
-----END CERTIFICATE-----
-----BEGIN CERTIFICATE-----
MIIFazCCA1OgAwIBAgIRAIIQz7DSQONZRGPgu2OCiwAwDQYJKoZIhvcNAQELBQAw
TzELMAkGA1UEBhMCVVMxKTAnBgNVBAoTIEludGVybmV0IFNlY3VyaXR5IFJlc2Vh
cmNoIEdyb3VwMRUwEwYDVQQDEwxJU1JHIFJvb3QgWDEwHhcNMTUwNjA0MTEwNDM4
WhcNMzUwNjA0MTEwNDM4WjBPMQswCQYDVQQGEwJVUzEpMCcGA1UEChMgSW50ZXJu
ZXQgU2VjdXJpdHkgUmVzZWFyY2ggR3JvdXAxFTATBgNVBAMTDElTUkcgUm9vdCBY
MTCCAiIwDQYJKoZIhvcNAQEBBQADggIPADCCAgoCggIBAK3oJHP0FDfzm54rVygc
h77ct984kIxuPOZXoHj3dcKi/vVqbvYATyjb3miGbESTtrFj/RQSa78f0uoxmyF+
0TM8ukj13Xnfs7j/EvEhmkvBioZxaUpmZmyPfjxwv60pIgbz5MDmgK7iS4+3mX6U
A5/TR5d8mUgjU+g4rk8Kb4Mu0UlXjIB0ttov0DiNewNwIRt18jA8+o+u3dpjq+sW
T8KOEUt+zwvo/7V3LvSye0rgTBIlDHCNAymg4VMk7BPZ7hm/ELNKjD+Jo2FR3qyH
B5T0Y3HsLuJvW5iB4YlcNHlsdu87kGJ55tukmi8mxdAQ4Q7e2RCOFvu396j3x+UC
B5iPNgiV5+I3lg02dZ77DnKxHZu8A/lJBdiB3QW0KtZB6awBdpUKD9jf1b0SHzUv
KBds0pjBqAlkd25HN7rOrFleaJ1/ctaJxQZBKT5ZPt0m9STJEadao0xAH0ahmbWn
OlFuhjuefXKnEgV4We0+UXgVCwOPjdAvBbI+e0ocS3MFEvzG6uBQE3xDk3SzynTn
jh8BCNAw1FtxNrQHusEwMFxIt4I7mKZ9YIqioymCzLq9gwQbooMDQaHWBfEbwrbw
qHyGO0aoSCqI3Haadr8faqU9GY/rOPNk3sgrDQoo//fb4hVC1CLQJ13hef4Y53CI
rU7m2Ys6xt0nUW7/vGT1M0NPAgMBAAGjQjBAMA4GA1UdDwEB/wQEAwIBBjAPBgNV
HRMBAf8EBTADAQH/MB0GA1UdDgQWBBR5tFnme7bl5AFzgAiIyBpY9umbbjANBgkq
hkiG9w0BAQsFAAOCAgEAVR9YqbyyqFDQDLHYGmkgJykIrGF1XIpu+ILlaS/V9lZL
ubhzEFnTIZd+50xx+7LSYK05qAvqFyFWhfFQDlnrzuBZ6brJFe+GnY+EgPbk6ZGQ
3BebYhtF8GaV0nxvwuo77x/Py9auJ/GpsMiu/X1+mvoiBOv/2X/qkSsisRcOj/KK
NFtY2PwByVS5uCbMiogziUwthDyC3+6WVwW6LLv3xLfHTjuCvjHIInNzktHCgKQ5
ORAzI4JMPJ+GslWYHb4phowim57iaztXOoJwTdwJx4nLCgdNbOhdjsnvzqvHu7Ur
TkXWStAmzOVyyghqpZXjFaH3pO3JLF+l+/+sKAIuvtd7u+Nxe5AW0wdeRlN8NwdC
jNPElpzVmbUq4JUagEiuTDkHzsxHpFKVK7q4+63SM1N95R1NbdWhscdCb+ZAJzVc
oyi3B43njTOQ5yOf+1CceWxG1bQVs5ZufpsMljq4Ui0/1lvh+wjChP4kqKOJ2qxq
4RgqsahDYVvTH9w7jXbyLeiNdd8XM2w9U/t7y0Ff/9yi0GE44Za4rF2LN9d11TPA
mRGunUHBcnWEvgJBQl9nJEiU0Zsnvgc/ubhPgXRR4Xq37Z0j4r7g1SgEEzwxA57d
emyPxgcYxn/eR44/KJ4EBs+lVDR3veyJm+kXQ99b21/+jh5Xos1AnX5iItreGCc=
-----END CERTIFICATE-----
)PEM";

/* ---------- Board readings ---------- */

struct Reading {
  int doorValid, doorOpen, lightValid, lightPercent, climateValid, temperatureX10, humidityX10;
};

Reading latest;
bool haveReading = false;
uint32_t lastReadingAt = 0;

char line[96];
size_t lineLength = 0;

void parseLine(const char *text) {
  Reading r;
  int fields = sscanf(text, "RG,%d,%d,%d,%d,%d,%d,%d", &r.doorValid, &r.doorOpen, &r.lightValid,
                      &r.lightPercent, &r.climateValid, &r.temperatureX10, &r.humidityX10);
  if (fields != 7) return;
  latest = r;
  haveReading = true;
  lastReadingAt = millis();
}

void pollBoard() {
  while (Serial2.available()) {
    char c = Serial2.read();
    if (c == '\n' || c == '\r') {
      if (lineLength > 0) {
        line[lineLength] = '\0';
        parseLine(line);
        lineLength = 0;
      }
    } else if (lineLength < sizeof(line) - 1) {
      line[lineLength++] = c;
    } else {
      lineLength = 0; // overlong line: drop it
    }
  }
}

/* ---------- Upload ---------- */

WiFiClientSecure tls;
HTTPClient http;

void connectWifi() {
  if (WiFi.status() == WL_CONNECTED) return;
  Serial.printf("Connecting to %s...\n", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 15000) {
    pollBoard();
    delay(100);
  }
  Serial.println(WiFi.status() == WL_CONNECTED ? "Wi-Fi connected" : "Wi-Fi not connected; will retry");
}

void buildJson(const Reading &r, char *out, size_t size) {
  char temperature[12] = "null";
  char humidity[12] = "null";
  char light[8] = "null";

  if (r.climateValid) {
    snprintf(temperature, sizeof temperature, "%.1f", r.temperatureX10 / 10.0f);
    snprintf(humidity, sizeof humidity, "%.1f", r.humidityX10 / 10.0f);
  }
  if (r.lightValid) snprintf(light, sizeof light, "%d", r.lightPercent);
  const char *lidOpen = !r.doorValid ? "null" : r.doorOpen ? "true" : "false";

  snprintf(out, size,
           "{\"temperature\":%s,\"humidity\":%s,\"light\":%s,\"lidOpen\":%s}",
           temperature, humidity, light, lidOpen);
}

void sendReading(const Reading &r) {
  char body[192];
  buildJson(r, body, sizeof body);

  if (!http.begin(tls, INGEST_URL)) {
    Serial.println("Bad INGEST_URL");
    return;
  }
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Authorization", String("Bearer ") + INGEST_TOKEN);

  int status = http.POST((uint8_t *)body, strlen(body));
  if (status == 204) {
    Serial.printf("Sent %s\n", body);
  } else if (status > 0) {
    Serial.printf("Server replied %d: %s\n", status, http.getString().c_str());
  } else {
    Serial.printf("POST failed: %s\n", http.errorToString(status).c_str());
  }
  http.end(); // keeps the TLS connection open for the next POST when it can
}

/* ---------- Main ---------- */

void setup() {
  Serial.begin(115200);
  Serial2.setRxBufferSize(1024);
  Serial2.begin(BOARD_BAUD, SERIAL_8N1, BOARD_RX_PIN, BOARD_TX_PIN);

  tls.setCACert(ROOT_CAS);
  http.setReuse(true);
  http.setTimeout(5000);

  connectWifi();
}

void loop() {
  pollBoard();

  static uint32_t lastSendAt = 0;
  if (millis() - lastSendAt < SEND_EVERY_MS) return;
  lastSendAt = millis();

  /* Only send what the board actually reported recently; if it goes quiet,
   * the dashboard shows the feed as stale and then disconnected. */
  if (!haveReading || millis() - lastReadingAt > BOARD_STALE_MS) return;

  connectWifi();
  if (WiFi.status() == WL_CONNECTED) sendReading(latest);
}
