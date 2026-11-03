#include "rg_uplink.h"
#include "rg_esp_uart.h"
#include "rg_dht.h"

#if __has_include("rg_secrets.h")
#include "rg_secrets.h"
#define RG_UPLINK_ENABLED 1
#else
#define RG_UPLINK_ENABLED 0
#endif

#if RG_UPLINK_ENABLED

#include <HTTPClient.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>

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

// TLS needs a large stack; 10 KB leaves headroom for HTTPClient.
#define RG_UPLINK_STACK     10240U
// Same priority as loop(): the UART task (priority 2) always preempts it.
#define RG_UPLINK_PRIORITY  1U

static WiFiClientSecure tls;
static HTTPClient http;

static bool ensureWifi(void)
{
    static uint32_t lastAttempt = 0;
    static bool attempted = false;

    if (WiFi.status() == WL_CONNECTED) {
        return true;
    }

    uint32_t now = millis();
    if (!attempted || (uint32_t)(now - lastAttempt) >= RG_UPLINK_WIFI_RETRY_MS) {
        attempted = true;
        lastAttempt = now;
        Serial.printf("[UPLINK] Connecting to Wi-Fi \"%s\"...\n", RG_WIFI_SSID);
        WiFi.disconnect();
        WiFi.begin(RG_WIFI_SSID, RG_WIFI_PASSWORD);
    }
    return false;
}

// Build the dashboard JSON. Any value the ESP32 can't vouch for is sent
// as null, so the dashboard shows that sensor as missing rather than wrong.
static void buildJson(char *out, size_t size)
{
    RG_ConfirmedState mcx;
    RG_ESP_GetConfirmed(&mcx);

    RG_DHT_Reading dht = {};
    bool dhtValid = RG_DHT_GetReading(&dht) && dht.valid;

    char temperature[12] = "null";
    char humidity[12] = "null";
    char light[8] = "null";
    const char *lidOpen = "null";

    if (dhtValid) {
        snprintf(temperature, sizeof(temperature), "%.1f", dht.temperatureX10 / 10.0f);
        snprintf(humidity, sizeof(humidity), "%.1f", dht.humidityX10 / 10.0f);
    }

    // stateValid is false when the MCX link is down or its status is > 1.5 s old
    if (mcx.stateValid) {
        if (mcx.lightValid) {
            snprintf(light, sizeof(light), "%u", (unsigned int)mcx.lightPercent);
        }
        if (mcx.doorValid) {
            lidOpen = mcx.doorOpen ? "true" : "false";
        }
    }

    snprintf(out, size,
             "{\"temperature\":%s,\"humidity\":%s,\"light\":%s,\"lidOpen\":%s}",
             temperature, humidity, light, lidOpen);
}

static void postReading(const char *body)
{
    if (!http.begin(tls, RG_INGEST_URL)) {
        Serial.println("[UPLINK] Bad RG_INGEST_URL");
        return;
    }

    http.addHeader("Content-Type", "application/json");
    http.addHeader("Authorization", "Bearer " RG_INGEST_TOKEN);

    int status = http.POST((uint8_t *)body, strlen(body));

    if (status == 204) {
#if RG_UPLINK_DEBUG
        Serial.printf("[UPLINK] Sent %s\n", body);
#endif
    } else if (status > 0) {
        Serial.printf("[UPLINK] Server replied %d: %s\n", status, http.getString().c_str());
    } else {
        Serial.printf("[UPLINK] POST failed: %s\n", http.errorToString(status).c_str());
    }

    // Keeps the TLS connection open for the next POST when it can
    http.end();
}

static void uplinkTask(void *)
{
    uint32_t lastSend = 0U - RG_UPLINK_SEND_MS;

    for (;;) {
        uint32_t now = millis();

        if ((uint32_t)(now - lastSend) >= RG_UPLINK_SEND_MS && ensureWifi()) {
            lastSend = now;
            char body[128];
            buildJson(body, sizeof(body));
            postReading(body);
        }

        vTaskDelay(pdMS_TO_TICKS(100));
    }
}

bool RG_Uplink_Begin(void)
{
    WiFi.mode(WIFI_STA);
    WiFi.setAutoReconnect(true);

    tls.setCACert(ROOT_CAS);
    http.setReuse(true);
    http.setTimeout(5000);

    Serial.printf("[UPLINK] Posting to %s every %u ms\n", RG_INGEST_URL, RG_UPLINK_SEND_MS);

    return xTaskCreate(uplinkTask, "RG_UPLINK", RG_UPLINK_STACK, nullptr,
                       RG_UPLINK_PRIORITY, nullptr) == pdPASS;
}

#else

bool RG_Uplink_Begin(void)
{
    Serial.println("[UPLINK] Disabled: copy rg_secrets.example.h to rg_secrets.h and fill it in");
    return false;
}

#endif
