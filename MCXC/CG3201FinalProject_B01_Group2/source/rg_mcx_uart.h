#ifndef RG_MCX_UART_H
#define RG_MCX_UART_H
#include "rg_protocol.h"
#include "FreeRTOS.h"
#include "task.h"
typedef struct {
    bool doorValid, doorOpen, accessGranted;
    uint32_t accessRemainingMs;
    uint8_t alarm, warningMask;
    bool warningValid, lightValid;
    uint16_t lightRaw;
    uint8_t lightPercent;
    bool exposureValid;
    uint32_t exposure;
} RG_MCX_Status;
typedef struct {
    bool online, climateValid, motionValid, moving;
    int16_t temperatureX10;
    uint16_t humidityX10;
    uint32_t climateAt, motionAt;
    uint32_t session;
    uint32_t rxFrames, parseErrors, hardwareErrors, txErrors, txDropped;
} RG_ESP_State;
typedef struct {RG_Frame frame;uint8_t result;} RG_Reply;
typedef struct {
    int32_t tempLowX10, tempHighX10, humidityLowX10, humidityHighX10;
    int32_t lightHighPercent, exposureLimit;
} RG_Limits;
bool RG_MCX_Init(void);
void RG_MCX_Task(void *unused);
bool RG_MCX_Publish(const RG_MCX_Status *state);
void RG_MCX_GetESP(RG_ESP_State *state);
bool RG_MCX_TakeRequest(RG_Frame *frame);
bool RG_MCX_Reply(const RG_Frame *frame, uint8_t result);
bool RG_LimitsParse(const char *payload, RG_Limits *limits);
/* Climate expires after 15 s; motion after 1500 ms, independently of heartbeat. */
#endif
