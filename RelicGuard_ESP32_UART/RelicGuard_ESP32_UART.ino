
#include "rg_esp_uart.h"
#include "rg_dht.h"
#include "rg_mpu.h"

// ============================================================
// CONFIGURATION
// ============================================================

// 0 = Use real sensors
// 1 = Use simulated sensor readings for UART testing
#define RG_DEMO_SENSORS 0

// Serial Monitor baud rate
#define RG_SERIAL_BAUD 115200

// Interval for printing MCXC444 state
#define RG_STATUS_PRINT_MS 1000U

// Main loop delay
#define RG_LOOP_DELAY_MS 10U

// ============================================================
// SETUP
// ============================================================

void setup()
{
    Serial.begin(RG_SERIAL_BAUD);
    delay(300);

    Serial.println("\n========== RELICGUARD ESP32-S2 ==========");
    Serial.println("UART: RX=GPIO16, TX=GPIO17, 115200 8N1");

    // Initialize UART communication with MCXC444
    if (!RG_ESP_Begin()) {
        Serial.println("[ERROR] UART startup failed");

        for (;;) {
            delay(1000);
        }
    }

    Serial.println("[UART] Initialized successfully");

    // Initialize DHT11 temperature/humidity sensor
    RG_DHT_Begin();

    // Initialize MPU6050 movement sensor
    // Currently disabled in rg_mpu.h:
    // #define RG_MPU_ENABLED 0
    RG_MPU_Begin();

    // Serial Monitor commands
    Serial.println("\nTest controls:");
    Serial.println("  a = Request 30s authorized access");
    Serial.println("  m = Send test movement event");

#if RG_DEMO_SENSORS
    Serial.println("[MODE] SIMULATED SENSOR DATA");
#else
    Serial.println("[MODE] REAL SENSOR DATA");
#endif

    Serial.println("==========================================");
}

// ============================================================
// MAIN LOOP
// ============================================================

void loop()
{
    // ========================================================
    // 1. SENSOR UPDATES
    // ========================================================

    // DHT11: Reads every 5 seconds
    // Also updates shared readings and UART climate queue
    RG_DHT_Update();

    // MPU6050: Reads every 100 ms when enabled
    // Currently disabled; returns immediately
    RG_MPU_Update();

    // ========================================================
    // 2. PROCESS UART COMMAND RESULTS
    // ========================================================

    RG_CommandResult commandResult;

    while (RG_ESP_TakeCommandResult(&commandResult)) {
        Serial.printf(
            "[UART] Command %c seq=%lu finished: %d\n",
            commandResult.type,
            (unsigned long)commandResult.sequence,
            commandResult.result
        );
    }

    // ========================================================
    // 3. SIMULATED SENSOR DATA (OPTIONAL)
    // ========================================================

#if RG_DEMO_SENSORS

    static uint32_t lastDemoSample = 0;

    if ((uint32_t)(millis() - lastDemoSample) >= 5000U) {
        lastDemoSample = millis();

        // Simulated temperature: 26.5 C
        // Simulated humidity: 60.0 %RH
        RG_ESP_PublishClimate(true, 265, 600);

        Serial.println("[DEMO] SIMULATED climate: 26.5 C, 60.0 %RH");
    }

    // Simulated stationary movement state
    RG_ESP_PublishMotion(true, false);

#endif

    // ========================================================
    // 4. SERIAL MONITOR TEST COMMANDS
    // ========================================================

    if (Serial.available()) {
        char key = (char)Serial.read();

        switch (key) {

            case 'a':
                Serial.println(
                    RG_ESP_RequestAccess()
                    ? "[TEST] Access REQUEST QUEUED; wait for MCX confirmation"
                    : "[TEST] Access request not queued: offline/full"
                );
                break;

            case 'm':
                Serial.println(
                    RG_ESP_MovementEvent()
                    ? "[TEST] Movement event queued"
                    : "[TEST] Movement event not queued: offline/full"
                );
                break;

            default:
                break;
        }
    }

    // ========================================================
    // 5. PRINT CONFIRMED MCXC444 STATE
    // ========================================================

    static uint32_t lastStatusPrint = 0;

    if ((uint32_t)(millis() - lastStatusPrint)
        >= RG_STATUS_PRINT_MS) {

        lastStatusPrint = millis();

        RG_ConfirmedState state;
        RG_ESP_GetConfirmed(&state);

        Serial.printf(
            "\n[MCX] Link: %s | State: %s\n",
            state.online ? "ONLINE" : "OFFLINE",
            state.stateValid ? "VALID" : "UNAVAILABLE"
        );

        if (state.stateValid) {

            Serial.printf(
                "[MCX] Door: %s | Access: %s | Remaining: %lu ms\n",
                state.doorValid
                    ? (state.doorOpen ? "OPEN" : "CLOSED")
                    : "UNAVAILABLE",
                state.accessGranted ? "GRANTED" : "NOT GRANTED",
                (unsigned long)state.accessRemainingMs
            );

            Serial.printf(
                "[MCX] Alarm: %u | Light: %s | Warnings: %s\n",
                (unsigned int)state.alarm,
                state.lightValid ? "VALID" : "UNAVAILABLE",
                state.warningValid ? "VALID" : "UNAVAILABLE"
            );
        }
    }

    // ========================================================
    // 6. ALLOW OTHER FREERTOS TASKS TO RUN
    // ========================================================

    delay(RG_LOOP_DELAY_MS);
}
