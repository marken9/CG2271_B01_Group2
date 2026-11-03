#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include "env_warning.h"

static EnvInputs climate(int16_t t, uint16_t h)
{
    return (EnvInputs){.climateValid = true, .temperatureX10 = t, .humidityX10 = h,
                       .lightValid = true, .brightnessPercent = 0};
}

int main(void)
{
    EnvLimits lim;
    EnvWarning_DefaultLimits(&lim);
    EnvWarning env;

    /* Normal conditions: no warnings and nothing unavailable. */
    EnvWarning_Init(&env);
    EnvInputs in = climate(250, 500);
    assert(EnvWarning_Update(&env, &in, &lim, 0) == 0U);

    /* Temperature must stay high for 10 s before warning. */
    in = climate(310, 500);
    assert(EnvWarning_Update(&env, &in, &lim, 1000) == 0U);
    assert(EnvWarning_Update(&env, &in, &lim, 10999) == 0U);
    assert(EnvWarning_Update(&env, &in, &lim, 11000) == ENV_WARN_TEMP_HIGH);
    assert(env.raised == ENV_WARN_TEMP_HIGH);
    assert(EnvWarning_Update(&env, &in, &lim, 11050) == ENV_WARN_TEMP_HIGH);
    assert(env.raised == 0U); /* Raised edge reported only once. */

    /* Hysteresis: 29.5 C is inside the limit but not by 1.0 C, so stay on. */
    in = climate(295, 500);
    assert(EnvWarning_Update(&env, &in, &lim, 12000) == ENV_WARN_TEMP_HIGH);
    in = climate(290, 500);
    assert(EnvWarning_Update(&env, &in, &lim, 13000) == 0U);

    /* A brief spike does not warn; the timer restarts after it ends. */
    in = climate(310, 500);
    EnvWarning_Update(&env, &in, &lim, 20000);
    in = climate(250, 500);
    EnvWarning_Update(&env, &in, &lim, 25000);
    in = climate(310, 500);
    assert(EnvWarning_Update(&env, &in, &lim, 26000) == 0U);
    assert(EnvWarning_Update(&env, &in, &lim, 35999) == 0U);
    assert(EnvWarning_Update(&env, &in, &lim, 36000) == ENV_WARN_TEMP_HIGH);

    /* Low and high humidity, and low temperature. */
    EnvWarning_Init(&env);
    in = climate(170, 700);
    EnvWarning_Update(&env, &in, &lim, 0);
    assert(EnvWarning_Update(&env, &in, &lim, 10000) ==
           (ENV_WARN_TEMP_LOW | ENV_WARN_HUMIDITY_HIGH));
    EnvWarning_Init(&env);
    in = climate(250, 250);
    EnvWarning_Update(&env, &in, &lim, 0);
    assert(EnvWarning_Update(&env, &in, &lim, 10000) == ENV_WARN_HUMIDITY_LOW);
    in = climate(250, 320); /* Inside by 2 %, hysteresis is 3 %. */
    assert(EnvWarning_Update(&env, &in, &lim, 11000) == ENV_WARN_HUMIDITY_LOW);
    in = climate(250, 330);
    assert(EnvWarning_Update(&env, &in, &lim, 12000) == 0U);

    /* Stale climate: warnings clear and the data is flagged unavailable,
     * never reported as normal.
     */
    EnvWarning_Init(&env);
    in = climate(310, 500);
    EnvWarning_Update(&env, &in, &lim, 0);
    EnvWarning_Update(&env, &in, &lim, 10000);
    in.climateValid = false;
    assert(EnvWarning_Update(&env, &in, &lim, 11000) == ENV_CLIMATE_UNAVAILABLE);
    in.lightValid = false;
    assert(EnvWarning_Update(&env, &in, &lim, 12000) ==
           (ENV_CLIMATE_UNAVAILABLE | ENV_LIGHT_UNAVAILABLE));

    /* Too bright, with hysteresis. */
    EnvWarning_Init(&env);
    in = climate(250, 500);
    in.brightnessPercent = 90;
    EnvWarning_Update(&env, &in, &lim, 0);
    assert((EnvWarning_Update(&env, &in, &lim, 10000) & ENV_WARN_LIGHT_HIGH) != 0U);
    in.brightnessPercent = 78;
    assert((EnvWarning_Update(&env, &in, &lim, 10050) & ENV_WARN_LIGHT_HIGH) != 0U);
    in.brightnessPercent = 75;
    assert((EnvWarning_Update(&env, &in, &lim, 10100) & ENV_WARN_LIGHT_HIGH) == 0U);

    /* Exposure: 50 % for 10 s = 500 percent-seconds. */
    EnvWarning_Init(&env);
    lim.exposureLimit = 500;
    in = climate(250, 500);
    in.brightnessPercent = 50;
    uint32_t t = 0;
    EnvWarning_Update(&env, &in, &lim, t);
    for (int i = 0; i < 199; i++) { t += 50; EnvWarning_Update(&env, &in, &lim, t); }
    assert(env.exposure == 497 || env.exposure == 498 || env.exposure == 499);
    assert((env.mask & ENV_WARN_EXPOSURE) == 0U);
    t += 50; EnvWarning_Update(&env, &in, &lim, t);
    assert(env.exposure == 500 && (env.mask & ENV_WARN_EXPOSURE) != 0U);
    assert((env.raised & ENV_WARN_EXPOSURE) != 0U);
    /* Exposure pauses while light is unavailable. */
    in.lightValid = false;
    t += 5000; EnvWarning_Update(&env, &in, &lim, t);
    assert(env.exposure == 500);
    /* Raising the limit clears the flag; resetting starts a new period. */
    lim.exposureLimit = 1000;
    in.lightValid = true;
    t += 50; EnvWarning_Update(&env, &in, &lim, t);
    assert((env.mask & ENV_WARN_EXPOSURE) == 0U);
    EnvWarning_ResetExposure(&env);
    assert(env.exposure == 0U);
    /* A long gap between updates is capped at 1 s of exposure. */
    t += 60000; EnvWarning_Update(&env, &in, &lim, t);
    assert(env.exposure == 50U);

    /* Millisecond counter wraparound. */
    EnvWarning_Init(&env);
    lim.exposureLimit = 360000;
    in = climate(310, 500);
    uint32_t start = UINT32_MAX - 3000U;
    EnvWarning_Update(&env, &in, &lim, start);
    assert(EnvWarning_Update(&env, &in, &lim, start + 9999U) == 0U);
    assert(EnvWarning_Update(&env, &in, &lim, start + 10000U) == ENV_WARN_TEMP_HIGH);

    /* Light calibration works in both directions and clamps. */
    assert(Light_ToBrightness(1000, 1000, 3000) == 0U);
    assert(Light_ToBrightness(2000, 1000, 3000) == 50U);
    assert(Light_ToBrightness(3500, 1000, 3000) == 100U);
    assert(Light_ToBrightness(2000, 3000, 1000) == 50U);  /* Brighter = lower raw. */
    assert(Light_ToBrightness(500, 3000, 1000) == 100U);
    assert(Light_ToBrightness(3500, 3000, 1000) == 0U);
    assert(Light_ToBrightness(2000, 2000, 2000) == 0U);

    /* Filter starts at the first value and then smooths jumps. */
    LightFilter f = {0};
    assert(LightFilter_Update(&f, 2000) == 2000U);
    assert(LightFilter_Update(&f, 4000) == 2500U);
    for (int i = 0; i < 40; i++) LightFilter_Update(&f, 4000);
    assert(LightFilter_Update(&f, 4000) >= 3990U);

    puts("Environmental warning, exposure and light tests passed.");
    return 0;
}
