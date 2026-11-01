
#ifndef RG_MPU_H
#define RG_MPU_H

#include <Arduino.h>

// ============================================================
// MASTER ENABLE SWITCH
// ============================================================

// 0 = MPU6050 disabled
// 1 = MPU6050 enabled
#define RG_MPU_ENABLED           0

// ============================================================
// CONFIGURATION
// ============================================================

// GY-521 default I2C address (AD0 LOW)
#define RG_MPU_ADDRESS           0x68

// Sampling: 10 readings per second
#define RG_MPU_SAMPLE_MS         100U

// Movement thresholds (initial estimates)
// Acceleration vector difference: m/s^2
#define RG_MPU_ACCEL_THRESHOLD   2.0f

// Angular velocity magnitude: rad/s
#define RG_MPU_GYRO_THRESHOLD    0.8f

// Debouncing / noise filtering
#define RG_MPU_ACTIVE_SAMPLES    3U
#define RG_MPU_QUIET_SAMPLES     10U

// Reading expiry
#define RG_MPU_STALE_MS          1500U

// Serial debugging
#define RG_MPU_DEBUG             1

// ============================================================
// SHARED SENSOR READING
// ============================================================

typedef struct {
    bool valid;
    bool moving;

    float accelX;
    float accelY;
    float accelZ;

    float gyroX;
    float gyroY;
    float gyroZ;

    uint32_t timestampMs;
} RG_MPU_Reading;

// ============================================================
// PUBLIC FUNCTIONS
// ============================================================

bool RG_MPU_Begin(void);

void RG_MPU_Update(void);

// Thread-safe getter for OLED / website
bool RG_MPU_GetReading(RG_MPU_Reading *reading);

#endif
