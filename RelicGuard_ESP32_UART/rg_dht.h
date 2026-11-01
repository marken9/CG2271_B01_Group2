
#ifndef RG_DHT_H
#define RG_DHT_H

#include <Arduino.h>
#include <DHT.h>

// ============================================================
// DHT SENSOR CONFIGURATION
// ============================================================

// Hardware
#define RG_DHT_PIN             4U
#define RG_DHT_TYPE            DHT11

// Sampling interval
#define RG_DHT_SAMPLE_MS       5000U

// Valid sensor ranges (in x10 units)
#define RG_DHT_TEMP_MIN_X10    (-400)
#define RG_DHT_TEMP_MAX_X10    1000
#define RG_DHT_HUM_MIN_X10     0
#define RG_DHT_HUM_MAX_X10     1000

// Serial debugging
#define RG_DHT_DEBUG           1

// ============================================================
// SENSOR FUNCTIONS
// ============================================================

void RG_DHT_Begin(void);
void RG_DHT_Update(void);

// ============================================================
// SHARED SENSOR DATA
// ============================================================

// Reading becomes stale after 15 seconds
#define RG_DHT_STALE_MS 15000U

typedef struct {
    bool valid;
    int16_t temperatureX10;
    uint16_t humidityX10;
    uint32_t timestampMs;
} RG_DHT_Reading;

// Thread-safe access to latest sensor reading
// Returns false if snapshot retrieval fails.
// Check reading.valid to determine data availability.
bool RG_DHT_GetReading(RG_DHT_Reading *reading);




#endif
