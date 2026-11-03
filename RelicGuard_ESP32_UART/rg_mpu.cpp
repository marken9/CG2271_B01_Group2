
#include "rg_mpu.h"
#include "rg_esp_uart.h"

#include <math.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>

#if RG_MPU_ENABLED
#include "rg_i2c.h"
#include <Adafruit_MPU6050.h>
#include <Adafruit_Sensor.h>
#endif

// ============================================================
// SHARED SENSOR DATA
// ============================================================

static RG_MPU_Reading latestReading = {};
static SemaphoreHandle_t readingMutex = nullptr;

#if RG_MPU_ENABLED

static Adafruit_MPU6050 mpu;

static bool sensorReady = false;
static bool baselineReady = false;

static uint32_t lastSample = 0;
static uint32_t successfulReads = 0;
static uint32_t failedReads = 0;

static float baseX = 0.0f;
static float baseY = 0.0f;
static float baseZ = 0.0f;

static uint8_t activeCount = 0;
static uint8_t quietCount = 0;

static bool moving = false;

// ============================================================
// PRIVATE: SAVE SENSOR DATA
// ============================================================

static void SaveReading(const RG_MPU_Reading &reading)
{
    if (readingMutex == nullptr) {
        return;
    }

    if (xSemaphoreTake(readingMutex, portMAX_DELAY)
        == pdTRUE) {

        latestReading = reading;

        xSemaphoreGive(readingMutex);
    }
}

#endif

// ============================================================
// INITIALIZATION
// ============================================================

bool RG_MPU_Begin(void)
{
#if !RG_MPU_ENABLED

    // No sensor is connected yet.
    // Deliberately disabled.
    Serial.println("[MPU] Disabled in configuration");
    return false;

#else

    if (readingMutex == nullptr) {
        readingMutex = xSemaphoreCreateMutex();
    }

    if (readingMutex == nullptr) {
        Serial.println("[MPU] Reading mutex failed");
        return false;
    }

    if (!RG_I2C_Begin()) {
        Serial.println("[MPU] I2C initialization failed");
        return false;
    }

    if (!RG_I2C_Lock()) {
        Serial.println("[MPU] I2C lock failed");
        return false;
    }

    bool found = mpu.begin(RG_MPU_ADDRESS, &Wire);

    if (found) {
        mpu.setAccelerometerRange(MPU6050_RANGE_4_G);
        mpu.setGyroRange(MPU6050_RANGE_500_DEG);
        mpu.setFilterBandwidth(MPU6050_BAND_21_HZ);
    }

    RG_I2C_Unlock();

    if (!found) {
        Serial.println("[MPU] Sensor not detected");
        return false;
    }

    sensorReady = true;
    baselineReady = false;

    moving = false;
    activeCount = 0;
    quietCount = 0;

    lastSample = millis();

#if RG_MPU_DEBUG
    Serial.printf(
        "[MPU] Ready on I2C 0x%02X, interval=%lu ms\n",
        RG_MPU_ADDRESS,
        (unsigned long)RG_MPU_SAMPLE_MS
    );
#endif

    return true;

#endif
}

// ============================================================
// PERIODIC UPDATE
// ============================================================

void RG_MPU_Update(void)
{
#if !RG_MPU_ENABLED

    // Completely disabled until hardware is ready.
    return;

#else

    if (!sensorReady) {
        return;
    }

    uint32_t now = millis();

    if ((uint32_t)(now - lastSample)
        < RG_MPU_SAMPLE_MS) {
        return;
    }

    lastSample = now;

    sensors_event_t accel;
    sensors_event_t gyro;
    sensors_event_t temp;

    bool valid = false;

    // Use same I2C mutex as future OLED.
    if (RG_I2C_Lock()) {
        valid = mpu.getEvent(&accel, &gyro, &temp);
        RG_I2C_Unlock();
    }

    RG_MPU_Reading reading = {};
    reading.timestampMs = millis();

    if (valid) {
        valid =
            isfinite(accel.acceleration.x) &&
            isfinite(accel.acceleration.y) &&
            isfinite(accel.acceleration.z) &&
            isfinite(gyro.gyro.x) &&
            isfinite(gyro.gyro.y) &&
            isfinite(gyro.gyro.z);
    }

    // ========================================================
    // FAILED READING
    // ========================================================

    if (!valid) {
        failedReads++;

        // Store invalid reading for OLED / website.
        reading.valid = false;
        SaveReading(reading);

        // Inform MCXC444 that motion data is unavailable.
        RG_ESP_PublishMotion(false, false);

        // Re-establish baseline after sensor recovery.
        baselineReady = false;
        activeCount = 0;
        quietCount = 0;
        moving = false;

#if RG_MPU_DEBUG
        Serial.printf(
            "[MPU] Read failed (%lu failures)\n",
            (unsigned long)failedReads
        );
#endif
        return;
    }

    // ========================================================
    // VALID READING
    // ========================================================

    successfulReads++;

    reading.valid = true;

    reading.accelX = accel.acceleration.x;
    reading.accelY = accel.acceleration.y;
    reading.accelZ = accel.acceleration.z;

    reading.gyroX = gyro.gyro.x;
    reading.gyroY = gyro.gyro.y;
    reading.gyroZ = gyro.gyro.z;

    // Establish initial resting orientation.
    if (!baselineReady) {
        baseX = reading.accelX;
        baseY = reading.accelY;
        baseZ = reading.accelZ;

        baselineReady = true;
        activeCount = 0;
        quietCount = 0;
        moving = false;
    }

    // ========================================================
    // MOTION DETECTION
    // ========================================================

    // Change relative to initial orientation.
    float dx = reading.accelX - baseX;
    float dy = reading.accelY - baseY;
    float dz = reading.accelZ - baseZ;

    float accelChange = sqrtf(
        dx * dx + dy * dy + dz * dz
    );

    // Angular velocity magnitude.
    float gyroMagnitude = sqrtf(
        reading.gyroX * reading.gyroX +
        reading.gyroY * reading.gyroY +
        reading.gyroZ * reading.gyroZ
    );

    bool activity =
        accelChange >= RG_MPU_ACCEL_THRESHOLD ||
        gyroMagnitude >= RG_MPU_GYRO_THRESHOLD;

    bool newMovement = false;

    // ========================================================
    // FILTER SMALL VIBRATIONS
    // ========================================================

    if (activity) {

        if (activeCount < RG_MPU_ACTIVE_SAMPLES) {
            activeCount++;
        }

        quietCount = 0;

    } else {

        activeCount = 0;

        if (quietCount < RG_MPU_QUIET_SAMPLES) {
            quietCount++;
        }
    }

    // Motion confirmed only after consecutive active samples.
    if (!moving &&
        activeCount >= RG_MPU_ACTIVE_SAMPLES) {

        moving = true;
        newMovement = true;
    }

    // Stationary after consecutive quiet samples.
    if (moving &&
        quietCount >= RG_MPU_QUIET_SAMPLES) {

        moving = false;
    }

    reading.moving = moving;

    // ========================================================
    // UART REPORTING
    // ========================================================

    // Report current movement status continuously.
    // Do this even during authorized access.
    RG_ESP_PublishMotion(true, moving);

    // Send a discrete event on new confirmed movement.
    // Do not retain and send an old event later.
    if (newMovement) {
        bool queued = RG_ESP_MovementEvent();

#if RG_MPU_DEBUG
        Serial.printf(
            "[MPU] MOVEMENT EVENT | queued=%s\n",
            queued ? "YES" : "NO"
        );
#endif
    }

    // ========================================================
    // SHARED READING FOR OLED / WEBSITE
    // ========================================================

    SaveReading(reading);

#if RG_MPU_DEBUG
    static uint32_t lastPrint = 0;

    if ((uint32_t)(millis() - lastPrint) >= 1000U) {

        lastPrint = millis();

        Serial.printf(
            "[MPU] accelChange=%.2f m/s2"
            " | gyro=%.2f rad/s"
            " | moving=%s | samples=%lu\n",
            accelChange,
            gyroMagnitude,
            moving ? "YES" : "NO",
            (unsigned long)successfulReads
        );
    }
#endif

#endif
}

// ============================================================
// THREAD-SAFE GETTER FOR OLED / WEBSITE
// ============================================================

bool RG_MPU_GetReading(RG_MPU_Reading *reading)
{
    if (reading == nullptr) {
        return false;
    }

    *reading = {};

#if !RG_MPU_ENABLED

    // Disabled: valid=false, never treat as stationary.
    return true;

#else

    if (readingMutex == nullptr) {
        return false;
    }

    if (xSemaphoreTake(readingMutex, portMAX_DELAY)
        != pdTRUE) {
        return false;
    }

    *reading = latestReading;

    xSemaphoreGive(readingMutex);

    // Reject failed or stale readings.
    if (!reading->valid ||
        (uint32_t)(millis() - reading->timestampMs)
            >= RG_MPU_STALE_MS) {

        reading->valid = false;
        reading->moving = false;
    }

    return true;

#endif
}
