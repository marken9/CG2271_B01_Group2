#include "alarm.h"

uint8_t Alarm_Update(Alarm *alarm, bool doorValid, bool doorOpen,
                     bool accessGranted, uint32_t now, uint32_t halfPeriod)
{
    AlarmState next = accessGranted ? ALARM_ACCESS_GRANTED :
                      !doorValid ? ALARM_WAITING :
                      !doorOpen ? ALARM_DOOR_CLOSED : ALARM_UNAUTHORIZED_OPEN;
    if (next != alarm->state) {
        alarm->state = next;
        alarm->phaseStarted = now;
        alarm->blinkOn = true;
    }
    if (next == ALARM_DOOR_CLOSED) return ALARM_LED_BLUE;
    if (next != ALARM_UNAUTHORIZED_OPEN && next != ALARM_ACCESS_GRANTED) return ALARM_LED_OFF;

    /* Tick arithmetic replaces delays so control continues during blinking.
     * Catch up if a task iteration was delayed, including across tick wrap.
     */
    if (halfPeriod != 0U) {
        uint32_t phases = (uint32_t)(now - alarm->phaseStarted) / halfPeriod;
        if ((phases & 1U) != 0U) alarm->blinkOn = !alarm->blinkOn;
        alarm->phaseStarted += phases * halfPeriod;
    }
    uint8_t color = next == ALARM_ACCESS_GRANTED ? ALARM_LED_GREEN : ALARM_LED_RED;
    return alarm->blinkOn ? color : ALARM_LED_OFF;
}

const char *Alarm_StateName(AlarmState state)
{
    switch (state) {
        case ALARM_DOOR_CLOSED: return "DOOR CLOSED - BLUE";
        case ALARM_ACCESS_GRANTED: return "ACCESS GRANTED - GREEN BLINKING";
        case ALARM_UNAUTHORIZED_OPEN: return "ALARM - RED BLINKING";
        default: return "WAITING FOR DOOR INPUT";
    }
}
