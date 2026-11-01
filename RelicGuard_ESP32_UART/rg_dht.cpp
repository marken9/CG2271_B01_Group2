
#include "rg_dht.h"
#include "rg_esp_uart.h"

#include <math.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>

// ============================================================
// PRIVATE VARIABLES
// ============================================================

static DHT dht(RG_DHT_PIN, RG_DHT_TYPE);

static uint32_t lastSampleTime = 0;
static uint32_t successfulReads = 0;
static uint32_t failedReads = 0;

// Shared latest reading for OLED / website
static RG_DHT_Reading latestReading = {};

// Mutex protects the shared reading
static SemaphoreHandle_t readingMutex = nullptr;

// ============================================================
// INITIALIZATION
// ============================================================

void RG_DHT_Begin(void)
{
    // Create mutex before accessing shared data
    if (readingMutex == nullptr) {
        readingMutex = xSemaphoreCreateMutex();
    }

    if (readingMutex == nullptr) {
        Serial.println("[DHT] ERROR: Mutex creation failed");
    }

    dht.begin();

    lastSampleTime = millis();

#if RG_DHT_DEBUG
    Serial.printf(
        "[DHT] Initialized on GPIO%u\n",
        (unsigned)RG_DHT_PIN
    );

    Serial.printf(
        "[DHT] Sampling interval: %lu ms\n",
        (unsigned long)RG_DHT_SAMPLE_MS
    );
#endif
}

// ============================================================
// UPDATE SHARED READING
// ============================================================

static void RG_DHT_SaveReading(
    bool valid,
    int16_t temperatureX10,
    uint16_t humidityX10,
    uint32_t timestampMs)
{
    if (readingMutex == nullptr) {
        return;
    }

    if (xSemaphoreTake(readingMutex, portMAX_DELAY) == pdTRUE) {

        latestReading.valid = valid;

        latestReading.temperatureX10 =
            valid ? temperatureX10 : 0;

        latestReading.humidityX10 =
            valid ? humidityX10 : 0;

        latestReading.timestampMs = timestampMs;

        xSemaphoreGive(readingMutex);
    }
}

// ============================================================
// PERIODIC SENSOR READING
// ============================================================

void RG_DHT_Update(void)
{
    uint32_t now = millis();

    // Only sample when the interval has elapsed
    if ((uint32_t)(now - lastSampleTime)
        < RG_DHT_SAMPLE_MS) {
        return;
    }

    lastSampleTime = now;

    // Read temperature in Celsius and humidity in %RH
    float temperature = dht.readTemperature();
    float humidity = dht.readHumidity();

    // Check for failed or invalid readings
    bool valid =
        isfinite(temperature) &&
        isfinite(humidity);

    int16_t temperatureX10 = 0;
    uint16_t humidityX10 = 0;

    if (valid) {

        // Convert to UART protocol's x10 format
        long t = lroundf(temperature * 10.0f);
        long h = lroundf(humidity * 10.0f);

        if (t < RG_DHT_TEMP_MIN_X10 ||
            t > RG_DHT_TEMP_MAX_X10 ||
            h < RG_DHT_HUM_MIN_X10 ||
            h > RG_DHT_HUM_MAX_X10) {

            valid = false;

        } else {

            temperatureX10 = (int16_t)t;
            humidityX10 = (uint16_t)h;
        }
    }

    // Save reading for OLED / website tasks
    RG_DHT_SaveReading(
        valid,
        temperatureX10,
        humidityX10,
        millis()
    );

    // ========================================================
    // INVALID READING
    // ========================================================

    if (!valid) {

        failedReads++;

        // Report unavailable to MCXC444
        bool queued = RG_ESP_PublishClimate(false, 0, 0);

#if RG_DHT_DEBUG
        Serial.printf(
            "[DHT] READ FAILED | failures=%lu | queue=%s\n",
            (unsigned long)failedReads,
            queued ? "OK" : "FAILED"
        );
#endif

        return;
    }

    // ========================================================
    // VALID READING
    // ========================================================

    successfulReads++;

    // Send reading to existing UART module
    bool queued = RG_ESP_PublishClimate(
        true,
        temperatureX10,
        humidityX10
    );

#if RG_DHT_DEBUG
    Serial.printf(
        "[DHT] Temp: %.1f C | Humidity: %.1f %%RH"
        " | reads=%lu | queue=%s\n",
        temperature,
        humidity,
        (unsigned long)successfulReads,
        queued ? "OK" : "FAILED"
    );
#endif
}

// ============================================================
// PUBLIC FUNCTION: GET LATEST READING
// ============================================================

bool RG_DHT_GetReading(RG_DHT_Reading *reading)
{
    if (reading == nullptr || readingMutex == nullptr) {
        return false;
    }

    // Protect access to shared sensor data
    if (xSemaphoreTake(readingMutex, portMAX_DELAY) != pdTRUE) {
        return false;
    }

    // Copy latest reading
    *reading = latestReading;

    xSemaphoreGive(readingMutex);

    // Check whether reading is stale or invalid
    if (!reading->valid ||
        (uint32_t)(millis() - reading->timestampMs)
            >= RG_DHT_STALE_MS) {

        reading->valid = false;
    }

    return true;
}
