
/*
 * Copyright 2016-2026 NXP
 * All rights reserved.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 *
 *
 * Sensors:
 *   KY-021 Reed Switch  - PTA12 (D3)
 *   KY-018 Photoresistor - PTB0 (A0 / ADC0_SE8)
 *   KY-015 DHT11        - PTA5 (D5)
 *
 * FreeRTOS:
 *   Door Task     - Interrupt + Binary Semaphore
 *   Light Task    - Periodic ADC Polling
 *   Climate Task  - Periodic DHT11 Polling
 *   Monitor Task  - Prints sensor readings
 */

#include <stdio.h>
#include <stdint.h>
#include <stdbool.h>

#include "board.h"
#include "peripherals.h"
#include "pin_mux.h"
#include "clock_config.h"
#include "fsl_debug_console.h"

#include "fsl_common.h"
#include "fsl_clock.h"
#include "fsl_gpio.h"
#include "fsl_port.h"
#include "fsl_adc16.h"

#include "FreeRTOS.h"
#include "task.h"
#include "semphr.h"

/* ============================================================
 * 1. CONFIGURATION
 * ============================================================ */

/* ---------- GPIO Pins ---------- */

// Reed Switch (KY-021) - D3 / J1 Pin 8
#define REED_GPIO           GPIOA
#define REED_PORT           PORTA
#define REED_PIN            12U     // PTA12 - J1 Pin 8

// Photoresistor (KY-018) - A0 / J4 Pin 2
#define LIGHT_PORT          PORTB
#define LIGHT_PIN           0U      // PTB0 - J4 Pin 2

// Temperature & Humidity Sensor (DHT11) - D5 / J1 Pin 12
#define DHT_GPIO            GPIOA
#define DHT_PORT            PORTA
#define DHT_PIN             5U      // PTA5 - J1 Pin 12

/* ---------- Sensor Settings ---------- */

/* Change this to 0 if your reed switch operates inverted. */
#define REED_OPEN_LEVEL     0U

#define REED_DEBOUNCE_MS    25U

#define LIGHT_SAMPLE_MS     100U
#define DHT_SAMPLE_MS       2000U
#define PRINT_SAMPLE_MS     1000U

/* ---------- ADC Settings ---------- */

#define LIGHT_ADC_BASE      ADC0
#define LIGHT_ADC_CHANNEL   8U
#define LIGHT_ADC_GROUP     0U

#define ADC_MAX_VALUE       4095U
#define ADC_TIMEOUT_LOOPS   100000U

/* ---------- DHT11 Timing ---------- */

#define DHT_START_MS        20U
#define DHT_RELEASE_US      30U
#define DHT_BIT_SAMPLE_US   40U
#define DHT_TIMEOUT_US      120U

/* ---------- Task Priorities ---------- */

#define DOOR_TASK_PRIORITY     4U
#define LIGHT_TASK_PRIORITY    2U
#define CLIMATE_TASK_PRIORITY  2U
#define MONITOR_TASK_PRIORITY  1U

/* ---------- Task Stack Sizes ---------- */
/* Stack sizes below are in FreeRTOS stack words, not bytes. */

#define DOOR_STACK_SIZE       256U
#define LIGHT_STACK_SIZE      256U
#define CLIMATE_STACK_SIZE    384U
#define MONITOR_STACK_SIZE    512U

/* ============================================================
 * 2. GLOBAL VARIABLES
 * ============================================================ */

typedef struct {
    bool doorOpen;
    bool doorValid;

    uint16_t lightRaw;
    uint8_t lightPercent;
    bool lightValid;

    int16_t temperatureX10;
    uint16_t humidityX10;
    bool climateValid;
} SensorData_t;

static SensorData_t sensorData = {0};

static SemaphoreHandle_t doorSemaphore = NULL;
static SemaphoreHandle_t dataMutex = NULL;

/* ============================================================
 * 3. FUNCTION DECLARATIONS
 * ============================================================ */

static void Reed_Init(void);
static bool Reed_IsOpen(void);

static bool Light_Init(void);
static bool Light_Read(uint16_t *value);

static void DHT_Init(void);
static bool DHT_Read(int16_t *temperatureX10,
                     uint16_t *humidityX10);
static void DHT_SetOutput(void);
static void DHT_SetInput(void);
static bool DHT_WaitForLevel(uint8_t level,
                             uint32_t timeoutUs);

static void DoorTask(void *params);
static void LightTask(void *params);
static void ClimateTask(void *params);
static void MonitorTask(void *params);

/* ============================================================
 * 4. REED SWITCH
 * ============================================================ */

static void Reed_Init(void) {
    gpio_pin_config_t gpioConfig = {
        .pinDirection = kGPIO_DigitalInput,
        .outputLogic = 0U
    };

    CLOCK_EnableClock(kCLOCK_PortA);

    PORT_SetPinMux(REED_PORT,
                   REED_PIN,
                   kPORT_MuxAsGpio);

    GPIO_PinInit(REED_GPIO,
                 REED_PIN,
                 &gpioConfig);

    PORT_SetPinInterruptConfig(
        REED_PORT,
        REED_PIN,
        kPORT_InterruptEitherEdge
    );

    PORT_ClearPinsInterruptFlags(
        REED_PORT,
        (1UL << REED_PIN)
    );

    /* Keep the ISR at the lowest implemented NVIC priority
     * because it calls a FreeRTOS FromISR API.
     */
    NVIC_SetPriority(
        PORTA_IRQn,
        (1U << __NVIC_PRIO_BITS) - 1U
    );

    EnableIRQ(PORTA_IRQn);
}

static bool Reed_IsOpen(void) {
    uint32_t value = GPIO_PinRead(
        REED_GPIO,
        REED_PIN
    );

    return (value == REED_OPEN_LEVEL);
}

/*
 * Reed switch GPIO interrupt.
 *
 * Keep ISR short:
 * 1. Check interrupt flag
 * 2. Clear flag
 * 3. Give semaphore
 * 4. Yield if necessary
 */

void PORTA_IRQHandler(void) {
    BaseType_t higherPriorityTaskWoken = pdFALSE;

    uint32_t flags =
        PORT_GetPinsInterruptFlags(REED_PORT);

    if ((flags & (1UL << REED_PIN)) != 0U) {
        PORT_ClearPinsInterruptFlags(
            REED_PORT,
            (1UL << REED_PIN)
        );

        if (doorSemaphore != NULL) {
            xSemaphoreGiveFromISR(
                doorSemaphore,
                &higherPriorityTaskWoken
            );
        }
    }

    portYIELD_FROM_ISR(higherPriorityTaskWoken);
}

/* ============================================================
 * 5. PHOTORESISTOR / ADC
 * ============================================================ */

static bool Light_Init(void) {
    adc16_config_t adcConfig;

    CLOCK_EnableClock(kCLOCK_PortB);

    /* Put PTB0 into analog mode. */
    PORT_SetPinMux(
        LIGHT_PORT,
        LIGHT_PIN,
        kPORT_PinDisabledOrAnalog
    );

    ADC16_GetDefaultConfig(&adcConfig);

    adcConfig.resolution =
        kADC16_ResolutionSE12Bit;

    adcConfig.enableContinuousConversion = false;

    ADC16_Init(LIGHT_ADC_BASE, &adcConfig);

    ADC16_EnableHardwareTrigger(
        LIGHT_ADC_BASE,
        false
    );

    if (ADC16_DoAutoCalibration(LIGHT_ADC_BASE)
        != kStatus_Success) {
        return false;
    }

    return true;
}

static bool Light_Read(uint16_t *value) {
    adc16_channel_config_t channelConfig = {
        .channelNumber = LIGHT_ADC_CHANNEL,
        .enableInterruptOnConversionCompleted = false,
        .enableDifferentialConversion = false
    };

    if (value == NULL) {
        return false;
    }

    /* Start ADC conversion. */
    ADC16_SetChannelConfig(
        LIGHT_ADC_BASE,
        LIGHT_ADC_GROUP,
        &channelConfig
    );

    uint32_t timeout = ADC_TIMEOUT_LOOPS;

    while ((ADC16_GetChannelStatusFlags(
                LIGHT_ADC_BASE,
                LIGHT_ADC_GROUP
            ) & kADC16_ChannelConversionDoneFlag) == 0U) {

        if (--timeout == 0U) {
            return false;
        }
    }

    *value = (uint16_t)
        ADC16_GetChannelConversionValue(
            LIGHT_ADC_BASE,
            LIGHT_ADC_GROUP
        );

    return true;
}

/* ============================================================
 * 6. DHT11 TEMPERATURE + HUMIDITY
 * ============================================================ */

/*
 * DHT11 communication uses microsecond pulses.
 *
 * This initial driver uses SDK_DelayAtLeastUs()
 * for short timing intervals.
 *
 * It is suitable for bring-up, but the timing must
 * be validated on the actual MCXC444 board.
 */

static void DHT_SetOutput(void) {
    gpio_pin_config_t config = {
        .pinDirection = kGPIO_DigitalOutput,
        .outputLogic = 0U
    };

    GPIO_PinInit(DHT_GPIO, DHT_PIN, &config);
}

static void DHT_SetInput(void) {
    gpio_pin_config_t config = {
        .pinDirection = kGPIO_DigitalInput,
        .outputLogic = 0U
    };

    GPIO_PinInit(DHT_GPIO, DHT_PIN, &config);
}

static void DHT_Init(void) {
    CLOCK_EnableClock(kCLOCK_PortA);

    PORT_SetPinMux(
        DHT_PORT,
        DHT_PIN,
        kPORT_MuxAsGpio
    );

    DHT_SetInput();
}

static bool DHT_WaitForLevel(uint8_t level,
                             uint32_t timeoutUs) {
    while (timeoutUs > 0U) {
        if (GPIO_PinRead(DHT_GPIO, DHT_PIN)
            == level) {
            return true;
        }

        SDK_DelayAtLeastUs(1U, SystemCoreClock);
        timeoutUs--;
    }

    return false;
}

static bool DHT_Read(int16_t *temperatureX10,
                     uint16_t *humidityX10) {
    uint8_t data[5] = {0};

    if ((temperatureX10 == NULL) ||
        (humidityX10 == NULL)) {
        return false;
    }

    /* Step 1: Send start signal. */
    DHT_SetOutput();

    GPIO_PinWrite(DHT_GPIO, DHT_PIN, 0U);

    vTaskDelay(pdMS_TO_TICKS(DHT_START_MS));

    /* Release the data line. */
    DHT_SetInput();

    SDK_DelayAtLeastUs(
        DHT_RELEASE_US,
        SystemCoreClock
    );

    /* Step 2: Wait for DHT11 response.
     * Expected sequence:
     * LOW -> HIGH -> LOW
     */
    if (!DHT_WaitForLevel(0U, DHT_TIMEOUT_US)) {
        return false;
    }

    if (!DHT_WaitForLevel(1U, DHT_TIMEOUT_US)) {
        return false;
    }

    if (!DHT_WaitForLevel(0U, DHT_TIMEOUT_US)) {
        return false;
    }

    /* Step 3: Read 40 bits. */
    for (uint32_t bit = 0U; bit < 40U; bit++) {

        /* Wait for the beginning of the HIGH pulse. */
        if (!DHT_WaitForLevel(1U, DHT_TIMEOUT_US)) {
            return false;
        }

        /*
         * DHT11:
         * 0 -> HIGH for about 26-28 us
         * 1 -> HIGH for about 70 us
         *
         * Sample around 40 us after HIGH begins.
         */
        SDK_DelayAtLeastUs(
            DHT_BIT_SAMPLE_US,
            SystemCoreClock
        );

        uint8_t bitValue =
            (uint8_t)GPIO_PinRead(DHT_GPIO, DHT_PIN);

        data[bit / 8U] <<= 1U;
        data[bit / 8U] |= bitValue;

        /* Wait for the HIGH pulse to finish. */
        if (bitValue != 0U) {
            if (!DHT_WaitForLevel(
                    0U, DHT_TIMEOUT_US)) {
                return false;
            }
        }
    }

    /* Step 4: Verify checksum. */
    uint8_t checksum =
        (uint8_t)(data[0] + data[1] +
                  data[2] + data[3]);

    if (checksum != data[4]) {
        return false;
    }

    /* Step 5: Convert DHT11 reading to x10 units. */
    *humidityX10 =
        (uint16_t)data[0] * 10U + data[1];

    int16_t temp =
        (int16_t)data[2] * 10 + (int16_t)data[3];

    if ((data[2] & 0x80U) != 0U) {
        temp = -((int16_t)(data[2] & 0x7FU) * 10
                 + (int16_t)data[3]);
    }

    *temperatureX10 = temp;

    return true;
}

/* ============================================================
 * 7. FREERTOS TASKS
 * ============================================================ */

/* ---------- Door Task ---------- */

static void DoorTask(void *params) {
    (void)params;

    bool previousState = Reed_IsOpen();

    xSemaphoreTake(dataMutex, portMAX_DELAY);
    sensorData.doorOpen = previousState;
    sensorData.doorValid = true;
    xSemaphoreGive(dataMutex);

    for (;;) {
        /* Sleep until an interrupt signals the semaphore. */
        xSemaphoreTake(
            doorSemaphore,
            portMAX_DELAY
        );

        /* Debounce mechanical contact changes. */
        vTaskDelay(
            pdMS_TO_TICKS(REED_DEBOUNCE_MS)
        );

        bool currentState = Reed_IsOpen();

        if (currentState != previousState) {
            previousState = currentState;

            xSemaphoreTake(dataMutex, portMAX_DELAY);
            sensorData.doorOpen = currentState;
            xSemaphoreGive(dataMutex);
        }
    }
}

/* ---------- Light Task ---------- */

static void LightTask(void *params) {
    (void)params;

    TickType_t lastWake = xTaskGetTickCount();

    for (;;) {
        uint16_t adcValue = 0U;

        if (Light_Read(&adcValue)) {
            /* Relative ADC percentage, not calibrated lux. */
            uint8_t percentage =
                (uint8_t)(((uint32_t)adcValue * 100U)
                          / ADC_MAX_VALUE);

            xSemaphoreTake(dataMutex, portMAX_DELAY);

            sensorData.lightRaw = adcValue;
            sensorData.lightPercent = percentage;
            sensorData.lightValid = true;

            xSemaphoreGive(dataMutex);
        }

        vTaskDelayUntil(
            &lastWake,
            pdMS_TO_TICKS(LIGHT_SAMPLE_MS)
        );
    }
}

/* ---------- Climate Task ---------- */

static void ClimateTask(void *params) {
    (void)params;

    TickType_t lastWake = xTaskGetTickCount();

    for (;;) {
        int16_t temperature = 0;
        uint16_t humidity = 0U;

        bool success = DHT_Read(
            &temperature,
            &humidity
        );

        xSemaphoreTake(dataMutex, portMAX_DELAY);

        if (success) {
            sensorData.temperatureX10 = temperature;
            sensorData.humidityX10 = humidity;
        }

        sensorData.climateValid = success;

        xSemaphoreGive(dataMutex);

        vTaskDelayUntil(
            &lastWake,
            pdMS_TO_TICKS(DHT_SAMPLE_MS)
        );
    }
}

/* ---------- Monitor Task ---------- */

static void MonitorTask(void *params) {
    (void)params;

    TickType_t lastWake = xTaskGetTickCount();

    for (;;) {
        SensorData_t snapshot;

        /* Copy shared data under mutex protection. */
        xSemaphoreTake(dataMutex, portMAX_DELAY);
        snapshot = sensorData;
        xSemaphoreGive(dataMutex);

        PRINTF("\r\n========== RELICGUARD ==========\r\n");

        /* Reed switch */
        if (snapshot.doorValid) {
            PRINTF(
                "Door: %s\r\n",
                snapshot.doorOpen ? "OPEN" : "CLOSED"
            );
        } else {
            PRINTF("Door: WAITING\r\n");
        }

        /* Photoresistor */
        if (snapshot.lightValid) {
            PRINTF(
                "Light ADC: %u / %u\r\n",
                (unsigned int)snapshot.lightRaw,
                (unsigned int)ADC_MAX_VALUE
            );

            PRINTF(
                "Light ADC percentage: %u%%\r\n",
                (unsigned int)snapshot.lightPercent
            );
        } else {
            PRINTF("Light: WAITING\r\n");
        }

        /* DHT11 */
        if (snapshot.climateValid) {
            int32_t temp = snapshot.temperatureX10;

            if (temp < 0) {
                PRINTF("Temperature: -%ld.%ld C\r\n",
                       (long)(-temp / 10),
                       (long)(-temp % 10));
            } else {
                PRINTF("Temperature: %ld.%ld C\r\n",
                       (long)(temp / 10),
                       (long)(temp % 10));
            }

            PRINTF(
                "Humidity: %u.%u %%RH\r\n",
                (unsigned int)(snapshot.humidityX10 / 10U),
                (unsigned int)(snapshot.humidityX10 % 10U)
            );
        } else {
            PRINTF("DHT11: NO VALID READING\r\n");
        }

        PRINTF("================================\r\n");

        vTaskDelayUntil(
            &lastWake,
            pdMS_TO_TICKS(PRINT_SAMPLE_MS)
        );
    }
}

/* ============================================================
 * 8. MAIN
 * ============================================================ */

int main(void) {
    BOARD_InitBootPins();
    BOARD_InitBootClocks();
    BOARD_InitBootPeripherals();

#ifndef BOARD_INIT_DEBUG_CONSOLE_PERIPHERAL
    BOARD_InitDebugConsole();
#endif

    PRINTF("\r\nRelicGuard Sensor Test Starting...\r\n");

    /* Create synchronization objects. */
    doorSemaphore = xSemaphoreCreateBinary();
    dataMutex = xSemaphoreCreateMutex();

    if ((doorSemaphore == NULL) ||
        (dataMutex == NULL)) {
        PRINTF("ERROR: Semaphore/Mutex creation failed\r\n");

        for (;;) {
        }
    }

    /* Initialize hardware. */
    Reed_Init();

    if (!Light_Init()) {
        PRINTF("ERROR: ADC calibration failed\r\n");

        for (;;) {
        }
    }

    DHT_Init();

    /* Create FreeRTOS tasks. */
    BaseType_t result = pdPASS;

    result &= xTaskCreate(
        DoorTask,
        "Door",
        DOOR_STACK_SIZE,
        NULL,
        DOOR_TASK_PRIORITY,
        NULL
    );

    result &= xTaskCreate(
        LightTask,
        "Light",
        LIGHT_STACK_SIZE,
        NULL,
        LIGHT_TASK_PRIORITY,
        NULL
    );

    result &= xTaskCreate(
        ClimateTask,
        "Climate",
        CLIMATE_STACK_SIZE,
        NULL,
        CLIMATE_TASK_PRIORITY,
        NULL
    );

    result &= xTaskCreate(
        MonitorTask,
        "Monitor",
        MONITOR_STACK_SIZE,
        NULL,
        MONITOR_TASK_PRIORITY,
        NULL
    );

    if (result != pdPASS) {
        PRINTF("ERROR: Task creation failed\r\n");

        for (;;) {
        }
    }

    PRINTF("Starting FreeRTOS Scheduler...\r\n");

    vTaskStartScheduler();

    /* Only reached if scheduler fails to start. */
    for (;;) {
    }

    return 0;
}
