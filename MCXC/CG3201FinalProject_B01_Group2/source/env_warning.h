#ifndef RELICGUARD_ENV_WARNING_H
#define RELICGUARD_ENV_WARNING_H

#include <stdbool.h>
#include <stdint.h>

/* Environmental warnings and relative light exposure.
 *
 * Pure logic: no hardware or RTOS calls, so it can be tested on a host
 * (tests/test_env_warning.c). ControlTask calls EnvWarning_Update() and
 * sends the returned mask to the ESP32 as wire.warningMask.
 *
 * The light reading is a RELATIVE brightness percentage between two measured
 * calibration points (covered sensor and torch). It is not lux and not UV.
 */

/* warningMask bits sent over UART (S frame, 0..255). Bits 0-5 are active
 * warnings. Bits 6-7 mean that input is unavailable or stale: show
 * "SENSOR UNAVAILABLE", never "conditions normal", for those readings.
 */
#define ENV_WARN_TEMP_HIGH          (1U << 0)
#define ENV_WARN_TEMP_LOW           (1U << 1)
#define ENV_WARN_HUMIDITY_HIGH      (1U << 2)
#define ENV_WARN_HUMIDITY_LOW       (1U << 3)
#define ENV_WARN_LIGHT_HIGH         (1U << 4)
#define ENV_WARN_EXPOSURE           (1U << 5)
#define ENV_CLIMATE_UNAVAILABLE     (1U << 6)
#define ENV_LIGHT_UNAVAILABLE       (1U << 7)
#define ENV_WARNING_BITS            0x3FU   /* Bits 0-5: real warnings. */

/* A condition must stay outside its limit this long before a warning. */
#define ENV_PERSIST_MS              10000U

/* Hysteresis: a warning clears only once the reading is back inside the
 * limit by at least this much, so it does not flicker around a threshold.
 */
#define ENV_TEMP_HYSTERESIS_X10     10      /* 1.0 C */
#define ENV_HUMIDITY_HYSTERESIS_X10 30      /* 3.0 %RH */
#define ENV_LIGHT_HYSTERESIS_PCT    5       /* 5 % relative brightness */

/* Initial limits until the website sends an L command. These match the
 * illustrative L frame in docs/uart-sample-messages.txt and still need
 * group approval. Exposure is in percent-seconds: brightness (%) x time (s),
 * e.g. 360000 = 100 % for 1 hour or 50 % for 2 hours. Lower it for the demo.
 */
#define ENV_DEFAULT_TEMP_LOW_X10        180     /* 18.0 C */
#define ENV_DEFAULT_TEMP_HIGH_X10       300     /* 30.0 C */
#define ENV_DEFAULT_HUMIDITY_LOW_X10    300     /* 30.0 %RH */
#define ENV_DEFAULT_HUMIDITY_HIGH_X10   650     /* 65.0 %RH */
#define ENV_DEFAULT_LIGHT_HIGH_PCT      80      /* 80 % relative */
#define ENV_DEFAULT_EXPOSURE_LIMIT      360000  /* percent-seconds */

/* Same field order and units as RG_Limits in rg_mcx_uart.h. */
typedef struct {
    int32_t tempLowX10, tempHighX10;
    int32_t humidityLowX10, humidityHighX10;
    int32_t lightHighPercent;
    int32_t exposureLimit;
} EnvLimits;

typedef struct {
    bool climateValid;          /* From the ESP: online and not stale. */
    int16_t temperatureX10;
    uint16_t humidityX10;
    bool lightValid;
    uint8_t brightnessPercent;  /* Relative, 0-100. */
} EnvInputs;

typedef struct {
    bool active;
    bool pending;
    uint32_t outsideSince;
} EnvCondition;

enum { ENV_COND_TEMP_HIGH, ENV_COND_TEMP_LOW, ENV_COND_HUM_HIGH,
       ENV_COND_HUM_LOW, ENV_COND_LIGHT_HIGH, ENV_COND_COUNT };

typedef struct {
    EnvCondition cond[ENV_COND_COUNT];
    uint8_t mask;               /* Last result: warnings + unavailable bits. */
    uint8_t raised;             /* Warning bits newly raised by the last update. */
    uint32_t exposure;          /* Accumulated percent-seconds, capped at INT32_MAX. */
    uint32_t exposurePartial;   /* Percent-milliseconds not yet a whole second. */
    bool exposureValid;         /* True once a valid light sample has been counted. */
    bool exposureFlagged;
    bool started;
    uint32_t lastUpdateMs;
} EnvWarning;

void EnvWarning_Init(EnvWarning *env);
void EnvWarning_DefaultLimits(EnvLimits *limits);

/* Call regularly (ControlTask runs it at least every 50 ms). nowMs is a
 * free-running millisecond counter; wraparound is handled. Returns the mask.
 */
uint8_t EnvWarning_Update(EnvWarning *env, const EnvInputs *in,
                          const EnvLimits *limits, uint32_t nowMs);

/* Start a new exposure period (e.g. after the cards were moved). */
void EnvWarning_ResetExposure(EnvWarning *env);

/* Light helpers: smoothing and two-point relative calibration. */
typedef struct {
    uint32_t scaled;    /* Filtered value x 4. */
    bool primed;
} LightFilter;

uint16_t LightFilter_Update(LightFilter *filter, uint16_t raw);

/* Maps raw ADC to 0-100 % between darkRaw (covered) and brightRaw (torch).
 * Works whether brighter light raises or lowers the raw value.
 */
uint8_t Light_ToBrightness(uint16_t raw, uint16_t darkRaw, uint16_t brightRaw);

const char *EnvWarning_Name(uint8_t bit);

#endif
