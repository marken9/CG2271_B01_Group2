
#include "rg_i2c.h"

#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>

static SemaphoreHandle_t i2cMutex = nullptr;
static bool initialized = false;

bool RG_I2C_Begin(void)
{
    // Call during setup(), before concurrent I2C tasks start
    if (initialized) {
        return true;
    }

    if (i2cMutex == nullptr) {
        i2cMutex = xSemaphoreCreateMutex();
    }

    if (i2cMutex == nullptr) {
        return false;
    }

    Wire.setPins(RG_I2C_SDA_PIN, RG_I2C_SCL_PIN);

    if (!Wire.begin()) {
        return false;
    }

    Wire.setClock(RG_I2C_CLOCK_HZ);

    initialized = true;
    return true;
}

bool RG_I2C_Lock(void)
{
    if (!initialized || i2cMutex == nullptr) {
        return false;
    }

    return xSemaphoreTake(
        i2cMutex,
        pdMS_TO_TICKS(RG_I2C_LOCK_MS)
    ) == pdTRUE;
}

void RG_I2C_Unlock(void)
{
    if (i2cMutex != nullptr) {
        xSemaphoreGive(i2cMutex);
    }
}
