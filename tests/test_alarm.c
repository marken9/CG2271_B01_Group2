#include <assert.h>
#include <stdio.h>
#include "alarm.h"

int main(void)
{
    Alarm alarm = {0};
    assert(Alarm_Update(&alarm, false, false, false, 0, 250) == ALARM_LED_OFF);
    assert(Alarm_Update(&alarm, true, false, false, 10, 250) == ALARM_LED_BLUE);
    assert(Alarm_Update(&alarm, true, false, true, 20, 250) == ALARM_LED_GREEN);
    assert(Alarm_Update(&alarm, true, true, true, 30, 250) == ALARM_LED_GREEN);
    /* Grant expiry while open must start the alarm immediately, initially ON. */
    assert(Alarm_Update(&alarm, true, true, false, 40, 250) == ALARM_LED_RED);
    assert(alarm.state == ALARM_UNAUTHORIZED_OPEN);
    assert(Alarm_Update(&alarm, true, true, false, 289, 250) == ALARM_LED_RED);
    assert(Alarm_Update(&alarm, true, true, false, 290, 250) == ALARM_LED_OFF);
    assert(Alarm_Update(&alarm, true, true, false, 540, 250) == ALARM_LED_RED);
    /* Closing the lid clears the alarm; reopening starts a fresh ON phase. */
    assert(Alarm_Update(&alarm, true, false, false, 600, 250) == ALARM_LED_BLUE);
    assert(Alarm_Update(&alarm, true, true, false, 620, 250) == ALARM_LED_RED);
    /* Correct passcode silences the alarm while the lid remains open. */
    assert(Alarm_Update(&alarm, true, true, true, 630, 250) == ALARM_LED_GREEN);
    /* Do not retain the prior alarm's blink phase. */
    assert(Alarm_Update(&alarm, true, true, false, 700, 250) == ALARM_LED_RED);
    assert(Alarm_Update(&alarm, true, true, false, 1450, 250) == ALARM_LED_OFF);
    alarm = (Alarm){0};
    uint32_t start = UINT32_MAX - 100U;
    assert(Alarm_Update(&alarm, true, true, false, start, 250) == ALARM_LED_RED);
    assert(Alarm_Update(&alarm, true, true, false, start + 250U, 250) == ALARM_LED_OFF);
    assert(Alarm_Update(&alarm, true, true, false, start + 500U, 250) == ALARM_LED_RED);

    /* Access overrides door position; door changes must not restart blinking. */
    alarm = (Alarm){0};
    assert(Alarm_Update(&alarm, true, false, true, 0, 250) == ALARM_LED_GREEN);
    assert(alarm.state == ALARM_ACCESS_GRANTED);
    assert(Alarm_Update(&alarm, true, false, true, 250, 250) == ALARM_LED_OFF);
    assert(Alarm_Update(&alarm, true, true, true, 300, 250) == ALARM_LED_OFF);
    assert(Alarm_Update(&alarm, true, true, true, 500, 250) == ALARM_LED_GREEN);
    assert(Alarm_Update(&alarm, true, false, true, 750, 250) == ALARM_LED_OFF);
    /* Access expiry while closed returns to blue, while open goes to red. */
    assert(Alarm_Update(&alarm, true, false, false, 800, 250) == ALARM_LED_BLUE);
    assert(Alarm_Update(&alarm, true, true, true, 900, 250) == ALARM_LED_GREEN);
    assert(Alarm_Update(&alarm, true, true, false, 1000, 250) == ALARM_LED_RED);
    alarm = (Alarm){0};
    assert(Alarm_Update(&alarm, true, false, true, start, 250) == ALARM_LED_GREEN);
    assert(Alarm_Update(&alarm, true, false, true, start + 250U, 250) == ALARM_LED_OFF);
    assert(Alarm_Update(&alarm, true, false, true, start + 500U, 250) == ALARM_LED_GREEN);
    puts("Alarm transitions, timing and tick-wrap tests passed.");
    return 0;
}
