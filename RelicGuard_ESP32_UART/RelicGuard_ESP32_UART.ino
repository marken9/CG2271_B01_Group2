#include "rg_esp_uart.h"

/* Keep 0 for handover. Person 3 replaces these calls with real sensor data.
 * To exercise transport without sensors, set 1 and recompile; every log of
 * generated climate data will explicitly say SIMULATED. */
#define RG_DEMO_SENSORS 0

void setup() {
    Serial.begin(115200);
    delay(300);
    Serial.println("RelicGuard Person 2 UART: ESP32-S2, RX=16 TX=17, 115200 8N1");
    if (!RG_ESP_Begin()) {
        Serial.println("UART startup failed");
        for (;;) delay(1000);
    }
    Serial.println("Test controls: a=request 30s access, m=motion event.");
    Serial.println("No real sensors connected; sensor data is UNAVAILABLE by default.");
}
void loop() {
    static uint32_t printed=0;
    RG_CommandResult commandResult;
    while (RG_ESP_TakeCommandResult(&commandResult)) {
        Serial.printf("Command %c seq=%lu finished: %d\n",commandResult.type,
                      (unsigned long)commandResult.sequence,commandResult.result);
    }
#if RG_DEMO_SENSORS
    static uint32_t sampled=0;
    if ((uint32_t)(millis()-sampled)>=5000U) {
        sampled=millis();
        RG_ESP_PublishClimate(true,265,600);
        Serial.println("SIMULATED climate: 26.5 C, 60.0 %RH");
    }
    RG_ESP_PublishMotion(true,false);
#endif
    if (Serial.available()) {
        char key=(char)Serial.read();
        if (key=='a') Serial.println(RG_ESP_RequestAccess()?"Access REQUEST QUEUED; wait for MCX state":"Not queued: offline/full");
        if (key=='m') Serial.println(RG_ESP_MovementEvent()?"TEST movement event queued":"Not queued: offline/full");
    }
    if ((uint32_t)(millis()-printed)>=1000U) {
        printed=millis();RG_ConfirmedState s;RG_ESP_GetConfirmed(&s);
        Serial.printf("MCX %s | confirmed state %s\n",s.online?"ONLINE":"OFFLINE",s.stateValid?"VALID":"UNAVAILABLE");
        if (s.stateValid) {
            Serial.printf("door=%s access=%s remaining=%lu ms alarm=%u light=%s warnings=%s\n",
                s.doorValid?(s.doorOpen?"OPEN":"CLOSED"):"UNAVAILABLE",
                s.accessGranted?"GRANTED":"NO",(unsigned long)s.accessRemainingMs,s.alarm,
                s.lightValid?"VALID":"UNAVAILABLE",s.warningValid?"VALID":"UNAVAILABLE");
        }
    }
    delay(10);
}
