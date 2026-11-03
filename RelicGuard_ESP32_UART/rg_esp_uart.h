#ifndef RG_ESP_UART_H
#define RG_ESP_UART_H
#include <Arduino.h>
struct RG_ConfirmedState {
    bool online, stateValid, doorValid, doorOpen, accessGranted;
    uint32_t receivedAt, accessRemainingMs;
    uint8_t alarm, warningMask;
    bool warningValid, lightValid;
    uint16_t lightRaw;
    uint8_t lightPercent;
    bool exposureValid;
    uint32_t exposure;
};
struct RG_CommandResult {
    char type;
    uint32_t sequence;
    int result; /* 0=applied; 1..4=rejected; -1/-2=unknown; -3=not sent. */
};
bool RG_ESP_Begin();
/* Thread safe, nonblocking queue writes. False means caller must handle failure.
 * Temperatures and humidity are integers in tenths (e.g. 265 = 26.5 C).
 * invalid readings use valid=false, not a fabricated zero reading.
 */
bool RG_ESP_PublishClimate(bool valid,int16_t temperatureX10,uint16_t humidityX10);
bool RG_ESP_PublishMotion(bool valid,bool moving);
bool RG_ESP_MovementEvent();
bool RG_ESP_RequestAccess();
bool RG_ESP_SetLimits(int tempLowX10,int tempHighX10,int humidityLowX10,
                     int humidityHighX10,int lightHighPercent,int exposureLimit);
void RG_ESP_GetConfirmed(RG_ConfirmedState *state);
bool RG_ESP_TakeCommandResult(RG_CommandResult *result);
#endif
