
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
 *   KY-023 Joystick     - PTB1 (A1), PTB2 (A2), PTA13 (D8)
 *   KY-015 DHT11        - PTA5 (D5), legacy test disabled by default
 *
 * FreeRTOS:
 *   Input Task    - Reed/button interrupts + binary semaphore, debounce
 *   ADC Task      - Sole ADC owner, joystick directions -> event queue
 *   Control Task  - Passcode verification and timed authorization
 *   Climate Task  - Optional legacy DHT11 test
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
#include "queue.h"
#include "joystick_password.h"
#include "alarm.h"

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

/* Joystick: power from 3.3 V, including modules labelled "+5V". */
#define JOY_X_PIN          1U      /* PTB1 / A1 / J4 pin 4 / ADC0_SE9 */
#define JOY_Y_PIN          2U      /* PTB2 / A2 / J4 pin 6 / ADC0_SE12 */
#define JOY_X_CHANNEL      9U
#define JOY_Y_CHANNEL      12U
#define JOY_BUTTON_PIN     13U     /* PTA13 / D8 / J2 pin 2 */
#define JOY_SWAP_AXES      0
#define JOY_INVERT_X       0
#define JOY_INVERT_Y       0

/* Sensor sampling options for the current bring-up session. */
#define ENABLE_LIGHT_SENSOR 1
#define ENABLE_MCX_DHT      0     /* Final design puts the DHT on ESP32. */
#define ADC_SAMPLE_MS       20U
#define ENTRY_TIMEOUT_MS    10000U
#define ACCESS_WINDOW_MS    30000U
#define INPUT_QUEUE_LENGTH  16U
#define ALARM_BLINK_HALF_MS 250U  /* 250 ms color on, 250 ms off. */

/* ---------- Sensor Settings ---------- */

/* Magnet near: LOW = lid closed. Magnet away: HIGH = lid open. */
#define REED_OPEN_LEVEL     1U

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

#define INPUT_TASK_PRIORITY    4U
#define ADC_TASK_PRIORITY      2U
#define CONTROL_TASK_PRIORITY  3U
#define CLIMATE_TASK_PRIORITY  2U
#define MONITOR_TASK_PRIORITY  1U

/* ---------- Task Stack Sizes ---------- */
/* Stack sizes below are in FreeRTOS stack words, not bytes. */

#define INPUT_STACK_SIZE      256U
#define ADC_STACK_SIZE        256U
#define CONTROL_STACK_SIZE    256U
#define CLIMATE_STACK_SIZE    384U
#define MONITOR_STACK_SIZE    512U

/* ============================================================
 * 2. GLOBAL VARIABLES
 * ============================================================ */

typedef enum {
    ENTRY_IDLE, ENTRY_TYPING, ENTRY_ACCEPTED, ENTRY_REJECTED,
    ENTRY_EXPIRED, ENTRY_TOO_LONG, ENTRY_ACCESS_ENDED
} EntryStatus;

typedef enum { EVENT_DIRECTION, EVENT_SUBMIT, EVENT_INPUT_FAULT, EVENT_DOOR_CHANGED } InputEventType;
typedef struct {
    InputEventType type;
    JoystickDirection direction;
    TickType_t timestamp;
    bool doorOpen;
} InputEvent;

typedef struct {
    bool doorOpen;
    bool doorValid;

    uint16_t lightRaw;
    uint8_t lightPercent;
    bool lightValid;

    int16_t temperatureX10;
    uint16_t humidityX10;
    bool climateValid;

    uint16_t joystickX;
    uint16_t joystickY;
    bool joystickValid;
    bool buttonPressed;
    JoystickDirection joystickDirection;
    uint8_t entryLength;
    EntryStatus entryStatus;
    bool accessGranted;
    AlarmState alarmState;
} SensorData_t;

static SensorData_t sensorData = {0};

static SemaphoreHandle_t inputSemaphore = NULL;
static SemaphoreHandle_t dataMutex = NULL;
static QueueHandle_t inputQueue = NULL;

/* Diagnostic counter: only the GPIO ISR writes it. The monitor task
 * reads the aligned 32-bit value without modifying it.
 */
static volatile uint32_t reedInterruptCount = 0U;
static volatile uint32_t buttonInterruptCount = 0U;

/* ============================================================
 * 3. FUNCTION DECLARATIONS
 * ============================================================ */

static void Reed_Init(void);
static bool Reed_IsOpen(void);

static bool ADC_Init(void);
static bool ADC_Read(uint8_t channel, uint16_t *value);
static void JoystickButton_Init(void);
static void RGB_Init(void);
static void RGB_Write(uint8_t colors);

#if ENABLE_MCX_DHT
static void DHT_Init(void);
static bool DHT_Read(int16_t *temperatureX10,
                     uint16_t *humidityX10);
static void DHT_SetOutput(void);
static void DHT_SetInput(void);
static bool DHT_WaitForLevel(uint8_t level,
                             uint32_t timeoutUs);

static void ClimateTask(void *params);
#endif
static void InputTask(void *params);
static void ADCTask(void *params);
static void ControlTask(void *params);
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

    /* GPIO input with an internal pull-up: an unconnected input reads
     * HIGH, while a contact to GND reads LOW. Configure before enabling
     * the interrupt so floating inputs do not obscure reed diagnostics.
     */
    REED_PORT->PCR[REED_PIN] = PORT_PCR_MUX(1U)
                             | PORT_PCR_PE_MASK
                             | PORT_PCR_PS_MASK;

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

    /* Low interrupt urgency is sufficient for these mechanical inputs. */
    NVIC_SetPriority(
        PORTA_IRQn,
        (1U << __NVIC_PRIO_BITS) - 1U
    );

    /* InputTask enables the IRQ after the scheduler has started. */
}

static bool Reed_IsOpen(void) {
    uint32_t value = GPIO_PinRead(
        REED_GPIO,
        REED_PIN
    );

    return (value == REED_OPEN_LEVEL);
}

static void JoystickButton_Init(void) {
    CLOCK_EnableClock(kCLOCK_PortA);
    PORTA->PCR[JOY_BUTTON_PIN] = PORT_PCR_MUX(1U)
                               | PORT_PCR_PE_MASK | PORT_PCR_PS_MASK;
    GPIOA->PDDR &= ~(1UL << JOY_BUTTON_PIN);
    PORT_SetPinInterruptConfig(PORTA, JOY_BUTTON_PIN, kPORT_InterruptEitherEdge);
    PORTA->ISFR = (1UL << JOY_BUTTON_PIN); /* Write-one-to-clear. */
}

/* Onboard RGB: active LOW; set a bit to turn that channel OFF.
 * Preload the output latches before enabling outputs to avoid a startup flash.
 * After init, only ControlTask writes these pins.
 */
static void RGB_Init(void) {
    SIM->SCGC5 |= SIM_SCGC5_PORTD_MASK | SIM_SCGC5_PORTE_MASK;
    GPIOE->PSOR = (1UL << BOARD_LED_RED_GPIO_PIN) | (1UL << BOARD_LED_BLUE_GPIO_PIN);
    GPIOD->PSOR = (1UL << BOARD_LED_GREEN_GPIO_PIN);
    PORTE->PCR[BOARD_LED_RED_GPIO_PIN] = PORT_PCR_MUX(1U);
    PORTE->PCR[BOARD_LED_BLUE_GPIO_PIN] = PORT_PCR_MUX(1U);
    PORTD->PCR[BOARD_LED_GREEN_GPIO_PIN] = PORT_PCR_MUX(1U);
    GPIOE->PDDR |= (1UL << BOARD_LED_RED_GPIO_PIN) | (1UL << BOARD_LED_BLUE_GPIO_PIN);
    GPIOD->PDDR |= (1UL << BOARD_LED_GREEN_GPIO_PIN);
}

static void RGB_Write(uint8_t colors) {
    uint32_t eOn = 0U;
    if ((colors & ALARM_LED_RED) != 0U) eOn |= 1UL << BOARD_LED_RED_GPIO_PIN;
    if ((colors & ALARM_LED_BLUE) != 0U) eOn |= 1UL << BOARD_LED_BLUE_GPIO_PIN;
    uint32_t eMask = (1UL << BOARD_LED_RED_GPIO_PIN) | (1UL << BOARD_LED_BLUE_GPIO_PIN);
    GPIOE->PSOR = eMask & ~eOn;
    GPIOE->PCOR = eOn;
    if ((colors & ALARM_LED_GREEN) != 0U) {
        GPIOD->PCOR = 1UL << BOARD_LED_GREEN_GPIO_PIN;
    } else {
        GPIOD->PSOR = 1UL << BOARD_LED_GREEN_GPIO_PIN;
    }
}

/*
 * Shared Port A ISR: reed and joystick button each wake InputTask.
 * InputTask reads both pins; the binary semaphore carries no payload.
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

        reedInterruptCount++;

        if (inputSemaphore != NULL) {
            xSemaphoreGiveFromISR(
                inputSemaphore,
                &higherPriorityTaskWoken
            );
        }
    }

    if ((flags & (1UL << JOY_BUTTON_PIN)) != 0U) {
        PORTA->ISFR = (1UL << JOY_BUTTON_PIN);
        buttonInterruptCount++;
        xSemaphoreGiveFromISR(inputSemaphore, &higherPriorityTaskWoken);
    }
    portYIELD_FROM_ISR(higherPriorityTaskWoken);
}

/* ============================================================
 * 5. PHOTORESISTOR / ADC
 * ============================================================ */

static bool ADC_Init(void) {
    adc16_config_t adcConfig;

    CLOCK_EnableClock(kCLOCK_PortB);

    /* Put PTB0 into analog mode. */
    PORT_SetPinMux(
        LIGHT_PORT,
        LIGHT_PIN,
        kPORT_PinDisabledOrAnalog
    );

    PORTB->PCR[JOY_X_PIN] = PORT_PCR_MUX(0U);
    PORTB->PCR[JOY_Y_PIN] = PORT_PCR_MUX(0U);

    ADC16_GetDefaultConfig(&adcConfig);

    /* Match Lab 2: SC2[REFSEL] = 01 selects the alternate reference.
     * The SDK default selects VREFH/VREFL, which must not be assumed to
     * provide the board's 3.3 V analog supply reference.
     * Set this before initialization and calibration, for every ADC channel.
     */
    adcConfig.referenceVoltageSource = kADC16_ReferenceVoltageSourceValt;

    adcConfig.resolution =
        kADC16_ResolutionSE12Bit;

    adcConfig.enableContinuousConversion = false;
    /* Allow the potentiometer output to settle at the ADC sample capacitor. */
    adcConfig.longSampleMode = kADC16_LongSampleCycle24;

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

static bool ADC_Read(uint8_t channel, uint16_t *value) {
    adc16_channel_config_t channelConfig = {
        .channelNumber = channel,
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

#if ENABLE_MCX_DHT
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

#endif /* ENABLE_MCX_DHT */

/* ============================================================
 * 7. FREERTOS TASKS
 * ============================================================ */

/* ---------- Input task: debounce reed and button outside the ISR ---------- */

static void InputTask(void *params) {
    (void)params;
    bool previousDoor = Reed_IsOpen();
    bool previousButton = GPIO_PinRead(GPIOA, JOY_BUTTON_PIN) == 0U;
    /* A button held at boot must be released before it can submit. */
    bool buttonReady = !previousButton;

    xSemaphoreTake(dataMutex, portMAX_DELAY);
    sensorData.buttonPressed = previousButton;
    xSemaphoreGive(dataMutex);

    InputEvent initialDoor = {
        .type = EVENT_DOOR_CHANGED, .timestamp = xTaskGetTickCount(), .doorOpen = previousDoor
    };
    xQueueSend(inputQueue, &initialDoor, portMAX_DELAY);
    EnableIRQ(PORTA_IRQn);
    for (;;) {
        xSemaphoreTake(inputSemaphore, portMAX_DELAY);
        vTaskDelay(pdMS_TO_TICKS(REED_DEBOUNCE_MS));
        bool door = Reed_IsOpen();
        bool button = GPIO_PinRead(GPIOA, JOY_BUTTON_PIN) == 0U;
        if (door != previousDoor) {
            InputEvent event = {
                .type = EVENT_DOOR_CHANGED, .timestamp = xTaskGetTickCount(), .doorOpen = door
            };
            xQueueSend(inputQueue, &event, portMAX_DELAY);
        }
        if (button != previousButton) {
            xSemaphoreTake(dataMutex, portMAX_DELAY);
            sensorData.buttonPressed = button;
            xSemaphoreGive(dataMutex);
        }
        if (!button) buttonReady = true;
        if (button && !previousButton && buttonReady) {
            buttonReady = false;
            InputEvent event = {.type = EVENT_SUBMIT, .timestamp = xTaskGetTickCount()};
            /* ControlTask drains this queue; never silently drop passcode input. */
            xQueueSend(inputQueue, &event, portMAX_DELAY);
        }
        previousDoor = door;
        previousButton = button;
    }
}

/* ---------- ADC task: all channels share one owner ---------- */

static void ADCTask(void *params) {
    (void)params;
    TickType_t lastWake = xTaskGetTickCount();
    JoystickFilter filter = {0};
    bool previouslyValid = false;
#if ENABLE_LIGHT_SENSOR
    unsigned lightDivider = 0U;
#endif
    for (;;) {
        uint16_t x = 0U, y = 0U;
        bool valid = ADC_Read(JOY_X_CHANNEL, &x) && ADC_Read(JOY_Y_CHANNEL, &y);
        JoystickDirection eventDirection = JOY_CENTER;
        JoystickDirection position = JOY_DIAGONAL;
        if (valid) {
#if JOY_SWAP_AXES
            uint16_t swap = x; x = y; y = swap;
#endif
#if JOY_INVERT_X
            x = ADC_MAX_VALUE - x;
#endif
#if JOY_INVERT_Y
            y = ADC_MAX_VALUE - y;
#endif
            position = Joystick_Classify(x, y);
            if (GPIO_PinRead(GPIOA, JOY_BUTTON_PIN) == 0U) {
                /* Pushing down can deflect the stick; require centre afterwards. */
                filter = (JoystickFilter){0};
            } else {
                eventDirection = Joystick_Sample(&filter, x, y);
            }
        } else {
            filter = (JoystickFilter){0};
        }
        xSemaphoreTake(dataMutex, portMAX_DELAY);
        sensorData.joystickX = x;
        sensorData.joystickY = y;
        sensorData.joystickValid = valid;
        sensorData.joystickDirection = position;
        xSemaphoreGive(dataMutex);
        if (eventDirection != JOY_CENTER) {
            InputEvent event = {.type = EVENT_DIRECTION, .direction = eventDirection, .timestamp = xTaskGetTickCount()};
            xQueueSend(inputQueue, &event, portMAX_DELAY);
        } else if (!valid && previouslyValid) {
            InputEvent event = {.type = EVENT_INPUT_FAULT, .timestamp = xTaskGetTickCount()};
            xQueueSend(inputQueue, &event, portMAX_DELAY);
        }
        previouslyValid = valid;
#if ENABLE_LIGHT_SENSOR
        if (++lightDivider >= LIGHT_SAMPLE_MS / ADC_SAMPLE_MS) {
            lightDivider = 0U;
            uint16_t raw = 0U;
            bool lightValid = ADC_Read(LIGHT_ADC_CHANNEL, &raw);
            xSemaphoreTake(dataMutex, portMAX_DELAY);
            sensorData.lightValid = lightValid;
            sensorData.lightRaw = raw;
            sensorData.lightPercent = (uint8_t)(((uint32_t)raw * 100U) / ADC_MAX_VALUE);
            xSemaphoreGive(dataMutex);
        }
#endif
        vTaskDelayUntil(&lastWake, pdMS_TO_TICKS(ADC_SAMPLE_MS));
    }
}

/* ---------- Control task: owns passcode, door state and alarm output ---------- */

static void ControlTask(void *params) {
    (void)params;
    PasswordEntry entry = {0};
    EntryStatus status = ENTRY_IDLE;
    TickType_t lastInput = 0U, acceptedAt = 0U;
    bool granted = false;
    bool doorValid = false, doorOpen = false;
    Alarm alarm = {0};
    for (;;) {
        InputEvent event;
        bool received = xQueueReceive(inputQueue, &event, pdMS_TO_TICKS(50U)) == pdTRUE;
        TickType_t now = xTaskGetTickCount();
        /* Unsigned subtraction also handles scheduler tick wraparound. */
        if (entry.length != 0U && (TickType_t)(now - lastInput) >= pdMS_TO_TICKS(ENTRY_TIMEOUT_MS)) {
            Password_Reset(&entry);
            status = ENTRY_EXPIRED;
        }
        if (granted && (TickType_t)(now - acceptedAt) >= pdMS_TO_TICKS(ACCESS_WINDOW_MS)) {
            granted = false;
            status = ENTRY_ACCESS_ENDED;
        }
        if (received) {
            if (event.type == EVENT_DOOR_CHANGED) {
                doorValid = true;
                doorOpen = event.doorOpen;
            } else if (event.type == EVENT_DIRECTION) {
                Password_Append(&entry, event.direction);
                lastInput = event.timestamp;
                status = entry.overflow ? ENTRY_TOO_LONG : ENTRY_TYPING;
            } else if (event.type == EVENT_SUBMIT) {
                /* Empty button presses do not overwrite the last result. */
                if (entry.length != 0U) {
                    granted = Password_Check(&entry);
                    status = granted ? ENTRY_ACCEPTED : ENTRY_REJECTED;
                    if (granted) acceptedAt = now;
                    Password_Reset(&entry);
                }
            } else {
                Password_Reset(&entry);
                granted = false;
                status = ENTRY_REJECTED;
            }
        }
        uint8_t colors = Alarm_Update(&alarm, doorValid, doorOpen, granted,
                                      (uint32_t)now, (uint32_t)pdMS_TO_TICKS(ALARM_BLINK_HALF_MS));
        RGB_Write(colors);
        xSemaphoreTake(dataMutex, portMAX_DELAY);
        sensorData.doorValid = doorValid;
        sensorData.doorOpen = doorOpen;
        sensorData.alarmState = alarm.state;
        sensorData.entryLength = entry.length;
        sensorData.entryStatus = status;
        sensorData.accessGranted = granted;
        xSemaphoreGive(dataMutex);
    }
}

#if ENABLE_MCX_DHT
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

#endif /* ENABLE_MCX_DHT */

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

        /* Read the physical pin independently of the interrupt/debounce
         * path so wiring faults can be distinguished from task faults.
         */
        PRINTF("Reed raw PTA12: %u | IRQ count: %lu\r\n",
               (unsigned int)GPIO_PinRead(REED_GPIO, REED_PIN),
               (unsigned long)reedInterruptCount);

        static const char *const entryNames[] = {
            "READY", "ENTERING", "ACCEPTED", "REJECTED",
            "ENTRY TIMED OUT", "TOO MANY DIRECTIONS - PRESS TO CLEAR", "ACCESS EXPIRED"
        };
        PRINTF("Joystick X: %u | Y: %u | %s | %s\r\n",
               (unsigned)snapshot.joystickX, (unsigned)snapshot.joystickY,
               snapshot.joystickValid ? Joystick_DirectionName(snapshot.joystickDirection) : "ADC ERROR",
               snapshot.buttonPressed ? "PRESSED" : "RELEASED");
        PRINTF("Button IRQ count: %lu\r\n", (unsigned long)buttonInterruptCount);
        char masked[PASSWORD_LENGTH + 1U] = {0};
        for (unsigned i = 0; i < snapshot.entryLength; i++) masked[i] = '*';
        PRINTF("Passcode: [%s] %u/4 | %s\r\n", masked,
               (unsigned)snapshot.entryLength, entryNames[snapshot.entryStatus]);
        PRINTF("Authorization: %s\r\n", snapshot.accessGranted ? "GRANTED (30 s)" : "NOT GRANTED");
        PRINTF("Security: %s\r\n", Alarm_StateName(snapshot.alarmState));

#if ENABLE_LIGHT_SENSOR
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

#else
        PRINTF("Light sensor: PAUSED\r\n");
#endif
#if ENABLE_MCX_DHT
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

#endif
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

    PRINTF("\r\nRelicGuard Door Alarm + Joystick Starting...\r\n");
    PRINTF("Return to centre between directions; press the stick to submit.\r\n");

    /* Create synchronization objects. */
    inputSemaphore = xSemaphoreCreateBinary();
    dataMutex = xSemaphoreCreateMutex();
    inputQueue = xQueueCreate(INPUT_QUEUE_LENGTH, sizeof(InputEvent));

    if ((inputSemaphore == NULL) ||
        (dataMutex == NULL) || (inputQueue == NULL)) {
        PRINTF("ERROR: Semaphore/Mutex creation failed\r\n");

        for (;;) {
        }
    }

    /* Initialize hardware. */
    DisableIRQ(PORTA_IRQn);
    Reed_Init();
    JoystickButton_Init();
    RGB_Init();

    if (!ADC_Init()) {
        PRINTF("ERROR: ADC calibration failed\r\n");

        for (;;) {
        }
    }

#if ENABLE_MCX_DHT
    DHT_Init();
#endif

    /* Compare each result explicitly: bitwise &= can hide allocation failures. */
    if (xTaskCreate(InputTask, "Input", INPUT_STACK_SIZE, NULL, INPUT_TASK_PRIORITY, NULL) != pdPASS ||
        xTaskCreate(ADCTask, "ADC", ADC_STACK_SIZE, NULL, ADC_TASK_PRIORITY, NULL) != pdPASS ||
        xTaskCreate(ControlTask, "Control", CONTROL_STACK_SIZE, NULL, CONTROL_TASK_PRIORITY, NULL) != pdPASS ||
        xTaskCreate(MonitorTask, "Monitor", MONITOR_STACK_SIZE, NULL, MONITOR_TASK_PRIORITY, NULL) != pdPASS
#if ENABLE_MCX_DHT
        || xTaskCreate(ClimateTask, "Climate", CLIMATE_STACK_SIZE, NULL, CLIMATE_TASK_PRIORITY, NULL) != pdPASS
#endif
    ) {
        PRINTF("ERROR: Task creation failed\r\n");
        for (;;) {}
    }

    PRINTF("Starting FreeRTOS Scheduler...\r\n");

    vTaskStartScheduler();

    /* Only reached if scheduler fails to start. */
    for (;;) {
    }

    return 0;
}
