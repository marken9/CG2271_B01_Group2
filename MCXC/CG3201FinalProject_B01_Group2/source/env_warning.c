#include "env_warning.h"

#define ENV_MAX_STEP_MS   1000U          /* Ignore huge gaps when integrating. */
#define ENV_EXPOSURE_CAP  0x7FFFFFFFUL   /* Protocol v1 needs a positive int32. */

void EnvWarning_Init(EnvWarning *env)
{
    *env = (EnvWarning){0};
}

void EnvWarning_DefaultLimits(EnvLimits *limits)
{
    *limits = (EnvLimits){
        ENV_DEFAULT_TEMP_LOW_X10, ENV_DEFAULT_TEMP_HIGH_X10,
        ENV_DEFAULT_HUMIDITY_LOW_X10, ENV_DEFAULT_HUMIDITY_HIGH_X10,
        ENV_DEFAULT_LIGHT_HIGH_PCT, ENV_DEFAULT_EXPOSURE_LIMIT
    };
}

void EnvWarning_ResetExposure(EnvWarning *env)
{
    env->exposure = 0U;
    env->exposurePartial = 0U;
    env->exposureFlagged = false;
}

static void condClear(EnvCondition *c)
{
    *c = (EnvCondition){0};
}

/* outside: reading is past the limit. recovered: back inside by the
 * hysteresis margin. Returns true when the warning is newly raised.
 */
static bool condStep(EnvCondition *c, bool outside, bool recovered, uint32_t now)
{
    if (c->active) {
        if (recovered) condClear(c);
        return false;
    }
    if (!outside) {
        c->pending = false;
        return false;
    }
    if (!c->pending) {
        c->pending = true;
        c->outsideSince = now;
    }
    if ((uint32_t)(now - c->outsideSince) >= ENV_PERSIST_MS) {
        c->active = true;
        c->pending = false;
        return true;
    }
    return false;
}

static const uint8_t condBits[ENV_COND_COUNT] = {
    ENV_WARN_TEMP_HIGH, ENV_WARN_TEMP_LOW, ENV_WARN_HUMIDITY_HIGH,
    ENV_WARN_HUMIDITY_LOW, ENV_WARN_LIGHT_HIGH
};

uint8_t EnvWarning_Update(EnvWarning *env, const EnvInputs *in,
                          const EnvLimits *limits, uint32_t nowMs)
{
    uint8_t raised = 0U;
    uint32_t stepMs = env->started ? (uint32_t)(nowMs - env->lastUpdateMs) : 0U;
    if (stepMs > ENV_MAX_STEP_MS) stepMs = ENV_MAX_STEP_MS;
    env->started = true;
    env->lastUpdateMs = nowMs;

    if (in->climateValid) {
        int32_t t = in->temperatureX10;
        int32_t h = in->humidityX10;
        if (condStep(&env->cond[ENV_COND_TEMP_HIGH], t > limits->tempHighX10,
                     t <= limits->tempHighX10 - ENV_TEMP_HYSTERESIS_X10, nowMs))
            raised |= ENV_WARN_TEMP_HIGH;
        if (condStep(&env->cond[ENV_COND_TEMP_LOW], t < limits->tempLowX10,
                     t >= limits->tempLowX10 + ENV_TEMP_HYSTERESIS_X10, nowMs))
            raised |= ENV_WARN_TEMP_LOW;
        if (condStep(&env->cond[ENV_COND_HUM_HIGH], h > limits->humidityHighX10,
                     h <= limits->humidityHighX10 - ENV_HUMIDITY_HYSTERESIS_X10, nowMs))
            raised |= ENV_WARN_HUMIDITY_HIGH;
        if (condStep(&env->cond[ENV_COND_HUM_LOW], h < limits->humidityLowX10,
                     h >= limits->humidityLowX10 + ENV_HUMIDITY_HYSTERESIS_X10, nowMs))
            raised |= ENV_WARN_HUMIDITY_LOW;
    } else {
        /* Missing or stale climate data: no climate warnings, but report it
         * as unavailable rather than letting it look like normal conditions.
         */
        for (unsigned i = ENV_COND_TEMP_HIGH; i <= ENV_COND_HUM_LOW; i++) condClear(&env->cond[i]);
    }

    if (in->lightValid) {
        int32_t b = in->brightnessPercent;
        if (condStep(&env->cond[ENV_COND_LIGHT_HIGH], b > limits->lightHighPercent,
                     b <= limits->lightHighPercent - ENV_LIGHT_HYSTERESIS_PCT, nowMs))
            raised |= ENV_WARN_LIGHT_HIGH;

        /* Exposure accumulates only while the light reading is valid. */
        env->exposureValid = true;
        env->exposurePartial += (uint32_t)in->brightnessPercent * stepMs;
        uint32_t whole = env->exposurePartial / 1000U;
        env->exposurePartial %= 1000U;
        env->exposure = (whole > ENV_EXPOSURE_CAP - env->exposure)
                      ? ENV_EXPOSURE_CAP : env->exposure + whole;
    } else {
        condClear(&env->cond[ENV_COND_LIGHT_HIGH]);
    }

    /* Exposure is cumulative, so it needs no persistence delay. It clears
     * only after a reset or if the limit is raised above the total.
     */
    bool overExposed = env->exposureValid && limits->exposureLimit > 0 &&
                       env->exposure >= (uint32_t)limits->exposureLimit;
    if (overExposed && !env->exposureFlagged) raised |= ENV_WARN_EXPOSURE;
    env->exposureFlagged = overExposed;

    uint8_t mask = 0U;
    for (unsigned i = 0; i < ENV_COND_COUNT; i++) {
        if (env->cond[i].active) mask |= condBits[i];
    }
    if (overExposed) mask |= ENV_WARN_EXPOSURE;
    if (!in->climateValid) mask |= ENV_CLIMATE_UNAVAILABLE;
    if (!in->lightValid) mask |= ENV_LIGHT_UNAVAILABLE;

    env->mask = mask;
    env->raised = raised;
    return mask;
}

uint16_t LightFilter_Update(LightFilter *filter, uint16_t raw)
{
    /* Exponential moving average, alpha = 1/4: smooths flicker and noise
     * while still settling within about a second at 10 Hz sampling.
     */
    if (!filter->primed) {
        filter->scaled = (uint32_t)raw * 4U;
        filter->primed = true;
    } else {
        filter->scaled = filter->scaled - filter->scaled / 4U + raw;
    }
    return (uint16_t)(filter->scaled / 4U);
}

uint8_t Light_ToBrightness(uint16_t raw, uint16_t darkRaw, uint16_t brightRaw)
{
    if (darkRaw == brightRaw) return 0U;
    uint32_t span, offset;
    if (brightRaw > darkRaw) {
        if (raw <= darkRaw) return 0U;
        if (raw >= brightRaw) return 100U;
        span = (uint32_t)(brightRaw - darkRaw);
        offset = (uint32_t)(raw - darkRaw);
    } else {
        if (raw >= darkRaw) return 0U;
        if (raw <= brightRaw) return 100U;
        span = (uint32_t)(darkRaw - brightRaw);
        offset = (uint32_t)(darkRaw - raw);
    }
    return (uint8_t)((offset * 100U + span / 2U) / span);
}

const char *EnvWarning_Name(uint8_t bit)
{
    switch (bit) {
        case ENV_WARN_TEMP_HIGH: return "TEMP HIGH";
        case ENV_WARN_TEMP_LOW: return "TEMP LOW";
        case ENV_WARN_HUMIDITY_HIGH: return "HUMIDITY HIGH";
        case ENV_WARN_HUMIDITY_LOW: return "HUMIDITY LOW";
        case ENV_WARN_LIGHT_HIGH: return "TOO BRIGHT";
        case ENV_WARN_EXPOSURE: return "EXPOSURE LIMIT";
        case ENV_CLIMATE_UNAVAILABLE: return "CLIMATE UNAVAILABLE";
        case ENV_LIGHT_UNAVAILABLE: return "LIGHT UNAVAILABLE";
        default: return "UNKNOWN";
    }
}
