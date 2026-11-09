#include "rg_oled.h"
#include "rg_i2c.h"
#include "rg_esp_uart.h"
#include "rg_dht.h"

#include <stdio.h>
#include <stdlib.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

// ============================================================
// VALUES SENT BY THE MCXC444
// ============================================================

// warningMask bits, set by env_warning.c on the MCX.
// Must match env_warning.h and docs/person4-env-warnings.md.
#define ENV_WARN_TEMP_HIGH          (1U << 0)
#define ENV_WARN_TEMP_LOW           (1U << 1)
#define ENV_WARN_HUMIDITY_HIGH      (1U << 2)
#define ENV_WARN_HUMIDITY_LOW       (1U << 3)
#define ENV_WARN_LIGHT_HIGH         (1U << 4)
#define ENV_WARN_EXPOSURE           (1U << 5)
#define ENV_CLIMATE_UNAVAILABLE     (1U << 6)
#define ENV_LIGHT_UNAVAILABLE       (1U << 7)

// Alarm states, from alarm.h on the MCX (AlarmState).
#define MCX_ALARM_WAITING           0
#define MCX_ALARM_DOOR_CLOSED       1
#define MCX_ALARM_ACCESS_GRANTED    2
#define MCX_ALARM_UNAUTHORIZED_OPEN 3
#define MCX_ALARM_DISARMED          4

// ============================================================
// SCREEN LAYOUT (text size 1 = 6 x 8 pixels, 21 characters a line)
// ============================================================
//
// y  0-15  status band (yellow on yellow/blue modules)
//            line 1: ARMED / ACCESS GRANTED 23s / SECURITY ALARM / MCX LINK LOST
//            line 2: lid state
// y 18     temperature and humidity (local DHT11)
// y 28     light and exposure (from the MCX)
// y 40-56  environmental warnings, up to 3 lines

#define LINE_CHARS      22   // 21 characters + terminating zero
#define Y_STATUS_1      0
#define Y_STATUS_2      8
#define Y_CLIMATE       18
#define Y_LIGHT         28
#define Y_WARN_FIRST    40
#define WARN_LINES      3

// clkDuring = 400 kHz while drawing, clkAfter = the shared bus speed,
// so the MPU6050 still sees the speed rg_i2c.h configured.
static Adafruit_SSD1306 display(RG_OLED_WIDTH, RG_OLED_HEIGHT, &Wire, -1,
                                400000UL, RG_I2C_CLOCK_HZ);

static bool oledReady = false;
static uint32_t lastRefreshMs = 0;
static uint32_t framesShown = 0;
static uint32_t framesSkipped = 0;

// ============================================================
// SMALL HELPERS
// ============================================================

static void textAt(int16_t y, const char *text, bool inverted = false)
{
    if (inverted) {
        display.fillRect(0, y, RG_OLED_WIDTH, 8, SSD1306_WHITE);
        display.setTextColor(SSD1306_BLACK);
    } else {
        display.setTextColor(SSD1306_WHITE);
    }
    display.setCursor(0, y);
    display.print(text);
    display.setTextColor(SSD1306_WHITE);
}

static const char *lidText(const RG_ConfirmedState &st)
{
    if (!st.doorValid) return "Lid: --";
    return st.doorOpen ? "Lid: OPEN" : "Lid: CLOSED";
}

// Exposure in percent-seconds, shortened to fit (e.g. 12.8k).
static void formatExposure(char *out, size_t size, uint32_t value)
{
    if (value < 1000UL) {
        snprintf(out, size, "%lu", (unsigned long)value);
    } else if (value < 1000000UL) {
        snprintf(out, size, "%lu.%luk", (unsigned long)(value / 1000UL),
                 (unsigned long)((value % 1000UL) / 100UL));
    } else {
        snprintf(out, size, "%luM", (unsigned long)(value / 1000000UL));
    }
}

// ============================================================
// SCREEN SECTIONS
// ============================================================

static void drawStatus(const RG_ConfirmedState &st, uint32_t now)
{
    char line[LINE_CHARS];

    // No recent status from the MCX: never show old values as current.
    if (!st.stateValid) {
        textAt(Y_STATUS_1, "MCX LINK LOST", true);
        textAt(Y_STATUS_2, st.online ? "Waiting for status" : "Check UART wiring");
        return;
    }

    if (st.alarm == MCX_ALARM_DISARMED) {
        textAt(Y_STATUS_1, "DISARMED");
    } else if (st.accessGranted) {
        unsigned long secs = (st.accessRemainingMs + 999UL) / 1000UL;
        snprintf(line, sizeof(line), "ACCESS GRANTED %2lus", secs);
        textAt(Y_STATUS_1, line);
    } else if (st.alarm == MCX_ALARM_UNAUTHORIZED_OPEN) {
        // Flash the alarm line twice a second so it stands out.
        bool flashOn = ((now / 500UL) % 2UL) == 0UL;
        textAt(Y_STATUS_1, "!! SECURITY ALARM !!", flashOn);
    } else if (st.alarm == MCX_ALARM_DOOR_CLOSED) {
        textAt(Y_STATUS_1, "ARMED");
    } else {
        textAt(Y_STATUS_1, "STARTING...");
    }

    textAt(Y_STATUS_2, lidText(st));
}

static void drawReadings(const RG_ConfirmedState &st,
                         const RG_DHT_Reading &dht, bool dhtValid)
{
    char line[LINE_CHARS];

    // Temperature and humidity: the local DHT11 reading (Person 3's store).
    if (dhtValid) {
        int t = dht.temperatureX10;
        const char *sign = (t < 0) ? "-" : "";
        t = abs(t);
        snprintf(line, sizeof(line), "Temp %s%d.%dC Hum %u.%u%%",
                 sign, t / 10, t % 10,
                 (unsigned)(dht.humidityX10 / 10U), (unsigned)(dht.humidityX10 % 10U));
    } else {
        snprintf(line, sizeof(line), "Temp --    Hum --");
    }
    textAt(Y_CLIMATE, line);

    // Light and exposure: values the MCX confirmed.
    char light[8];
    char exposure[10];
    if (st.stateValid && st.lightValid) {
        snprintf(light, sizeof(light), "%u%%", (unsigned)st.lightPercent);
    } else {
        snprintf(light, sizeof(light), "--");
    }
    if (st.stateValid && st.exposureValid) {
        formatExposure(exposure, sizeof(exposure), st.exposure);
    } else {
        snprintf(exposure, sizeof(exposure), "--");
    }
    snprintf(line, sizeof(line), "Light %-4s Exp %s", light, exposure);
    textAt(Y_LIGHT, line);
}

static void drawWarnings(const RG_ConfirmedState &st)
{
    // MCX state or warnings missing: say so, never "OK".
    if (!st.stateValid || !st.warningValid) {
        textAt(Y_WARN_FIRST, "Env: UNAVAILABLE");
        return;
    }

    static const struct { uint8_t bit; const char *text; } items[] = {
        { ENV_WARN_TEMP_HIGH,       "! TEMP HIGH" },
        { ENV_WARN_TEMP_LOW,        "! TEMP LOW" },
        { ENV_WARN_HUMIDITY_HIGH,   "! HUMIDITY HIGH" },
        { ENV_WARN_HUMIDITY_LOW,    "! HUMIDITY LOW" },
        { ENV_WARN_LIGHT_HIGH,      "! TOO BRIGHT" },
        { ENV_WARN_EXPOSURE,        "! EXPOSURE LIMIT" },
        { ENV_CLIMATE_UNAVAILABLE,  "CLIMATE UNAVAILABLE" },
        { ENV_LIGHT_UNAVAILABLE,    "LIGHT UNAVAILABLE" },
    };
    const size_t itemCount = sizeof(items) / sizeof(items[0]);

    size_t active = 0;
    for (size_t i = 0; i < itemCount; i++) {
        if ((st.warningMask & items[i].bit) != 0U) active++;
    }

    if (active == 0) {
        textAt(Y_WARN_FIRST, "Env: OK");
        return;
    }

    // Show up to 3 lines; if there are more, the last line says how many.
    size_t shown = 0;
    for (size_t i = 0; i < itemCount && shown < WARN_LINES; i++) {
        if ((st.warningMask & items[i].bit) == 0U) continue;
        int16_t y = Y_WARN_FIRST + (int16_t)(8 * shown);
        if (shown == WARN_LINES - 1 && active > WARN_LINES) {
            char more[LINE_CHARS];
            snprintf(more, sizeof(more), "+%u more", (unsigned)(active - shown));
            textAt(y, more);
        } else {
            textAt(y, items[i].text);
        }
        shown++;
    }
}

// ============================================================
// PUBLIC FUNCTIONS
// ============================================================

bool RG_OLED_Begin(void)
{
#if !RG_OLED_ENABLED
    return false;
#else
    // Start the shared bus. Safe if the MPU6050 code already started it.
    if (!RG_I2C_Begin()) {
        Serial.println("[OLED] I2C bus start failed");
        return false;
    }

    if (!RG_I2C_Lock()) {
        Serial.println("[OLED] I2C bus busy at startup");
        return false;
    }

    // periphBegin = false: Wire is already started on GPIO8/9 by rg_i2c.
    bool ok = display.begin(SSD1306_SWITCHCAPVCC, RG_OLED_ADDRESS, true, false);
    if (ok) {
        display.clearDisplay();
        display.setTextSize(1);
        display.setTextColor(SSD1306_WHITE);
        display.setCursor(0, 0);
        display.println("RelicGuard");
        display.println("Starting...");
        display.display();
    }

    RG_I2C_Unlock();

    oledReady = ok;
    if (ok) {
        Serial.println("[OLED] Ready");
    } else {
        Serial.printf("[OLED] Not found at 0x%02X: check wiring or address\n",
                      RG_OLED_ADDRESS);
    }
    return ok;
#endif
}

void RG_OLED_Update(void)
{
    if (!oledReady) return;

    uint32_t now = millis();
    if ((uint32_t)(now - lastRefreshMs) < RG_OLED_REFRESH_MS) return;
    lastRefreshMs = now;

    // 1. Copy the data first (each getter takes its own lock briefly).
    RG_ConfirmedState st;
    RG_ESP_GetConfirmed(&st);

    RG_DHT_Reading dht = {};
    bool dhtValid = RG_DHT_GetReading(&dht) && dht.valid;

    // 2. Draw into the screen buffer in RAM (no I2C traffic yet).
    display.clearDisplay();
    drawStatus(st, now);
    drawReadings(st, dht, dhtValid);
    drawWarnings(st);

    // 3. Send the buffer over I2C, holding the shared bus lock only for
    //    the transfer itself so the MPU6050 is never blocked for long.
    if (RG_I2C_Lock()) {
        display.display();
        RG_I2C_Unlock();
        framesShown++;
    } else {
        framesSkipped++;   // try again on the next refresh
    }

#if RG_OLED_DEBUG
    static uint32_t lastReport = 0;
    if ((uint32_t)(now - lastReport) >= 10000UL) {
        lastReport = now;
        Serial.printf("[OLED] frames shown=%lu skipped=%lu\n",
                      (unsigned long)framesShown, (unsigned long)framesSkipped);
    }
#endif
}
