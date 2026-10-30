#ifndef RELICGUARD_ALARM_H
#define RELICGUARD_ALARM_H

#include <stdbool.h>
#include <stdint.h>

typedef enum {
    ALARM_WAITING, ALARM_DOOR_CLOSED, ALARM_ACCESS_GRANTED, ALARM_UNAUTHORIZED_OPEN
} AlarmState;

enum { ALARM_LED_OFF = 0, ALARM_LED_RED = 1, ALARM_LED_GREEN = 2, ALARM_LED_BLUE = 4 };

typedef struct {
    AlarmState state;
    uint32_t phaseStarted;
    bool blinkOn;
} Alarm;

/* now and halfPeriod use the same unsigned tick units. halfPeriod must be > 0. */
uint8_t Alarm_Update(Alarm *alarm, bool doorValid, bool doorOpen,
                     bool accessGranted, uint32_t now, uint32_t halfPeriod);
const char *Alarm_StateName(AlarmState state);

#endif
