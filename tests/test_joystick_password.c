#include <assert.h>
#include <stdio.h>
#include "joystick_password.h"

static JoystickDirection settle(JoystickFilter *filter, uint16_t x, uint16_t y)
{
    JoystickDirection result = JOY_CENTER;
    for (unsigned i = 0; i < JOYSTICK_STABLE_SAMPLES; i++) {
        result = Joystick_Sample(filter, x, y);
    }
    return result;
}

int main(void)
{
    JoystickFilter filter = {0};
    /* Deflection at startup is ignored until the user centres the stick. */
    assert(settle(&filter, 2048, 0) == JOY_CENTER);
    assert(settle(&filter, 2048, 2048) == JOY_CENTER);
    assert(settle(&filter, 2048, 0) == JOY_UP);
    for (unsigned i = 0; i < 100; i++) {
        assert(Joystick_Sample(&filter, 2048, 0) == JOY_CENTER);
    }
    /* Crossing straight to another direction cannot add a second digit. */
    assert(settle(&filter, 4095, 2048) == JOY_CENTER);
    settle(&filter, 2048, 2048);
    /* A one-sample spike must not become a keypress. */
    assert(Joystick_Sample(&filter, 0, 2048) == JOY_CENTER);
    settle(&filter, 2048, 2048);
    assert(settle(&filter, 0, 0) == JOY_CENTER); /* Ignore diagonal. */
    assert(settle(&filter, 0, 2048) == JOY_LEFT);
    settle(&filter, 2048, 2048);
    assert(settle(&filter, 2048, 4095) == JOY_DOWN);
    settle(&filter, 2048, 2048);
    assert(settle(&filter, 4095, 2048) == JOY_RIGHT);
    assert(Joystick_Classify(1400, 2048) == JOY_DIAGONAL);

    PasswordEntry entry = {0};
    assert(!Password_Check(&entry));
    Password_Append(&entry, JOY_UP);
    Password_Append(&entry, JOY_DOWN);
    Password_Append(&entry, JOY_LEFT);
    assert(!Password_Check(&entry)); /* Incomplete. */
    Password_Append(&entry, JOY_RIGHT);
    assert(Password_Check(&entry));
    Password_Append(&entry, JOY_UP);
    assert(!Password_Check(&entry)); /* Correct prefix must not be accepted. */
    Password_Reset(&entry);
    Password_Append(&entry, JOY_CENTER);
    Password_Append(&entry, JOY_DIAGONAL);
    assert(entry.length == 0);
    Password_Append(&entry, JOY_UP);
    Password_Append(&entry, JOY_DOWN);
    Password_Append(&entry, JOY_RIGHT);
    Password_Append(&entry, JOY_LEFT);
    assert(!Password_Check(&entry)); /* Same directions, wrong order. */
    Password_Reset(&entry);
    assert(entry.length == 0 && !entry.overflow);
    /* The arm code is separate from the access passcode. */
    Password_Append(&entry, JOY_RIGHT);
    Password_Append(&entry, JOY_LEFT);
    Password_Append(&entry, JOY_DOWN);
    assert(!Password_CheckArmCode(&entry)); /* Incomplete. */
    Password_Append(&entry, JOY_UP);
    assert(Password_CheckArmCode(&entry));
    assert(!Password_Check(&entry));
    Password_Append(&entry, JOY_UP);
    assert(!Password_CheckArmCode(&entry)); /* Correct prefix must not be accepted. */
    Password_Reset(&entry);
    Password_Append(&entry, JOY_UP);
    Password_Append(&entry, JOY_DOWN);
    Password_Append(&entry, JOY_LEFT);
    Password_Append(&entry, JOY_RIGHT);
    assert(!Password_CheckArmCode(&entry)); /* The access passcode does not arm. */
    Password_Reset(&entry);
    /* Dashboard requests: "<0 disarm | 1 arm>,<four moves>". */
    bool arm = true;
    assert(Password_ParseRemote("0,RLDU", &entry, &arm));
    assert(!arm && Password_CheckArmCode(&entry) && !Password_Check(&entry));
    assert(Password_ParseRemote("1,RLDU", &entry, &arm) && arm);
    assert(Password_ParseRemote("0,UDLR", &entry, &arm));
    assert(!Password_CheckArmCode(&entry)); /* The access passcode does not disarm. */
    assert(!Password_ParseRemote("0,RLD", &entry, &arm));   /* Too short. */
    assert(!Password_ParseRemote("0,RLDUU", &entry, &arm)); /* Too long. */
    assert(!Password_ParseRemote("0,RLDX", &entry, &arm));  /* Not a move. */
    assert(!Password_ParseRemote("2,RLDU", &entry, &arm));  /* Not a state. */
    assert(!Password_ParseRemote("0RLDU", &entry, &arm));
    assert(!Password_ParseRemote("", &entry, &arm));
    Password_Reset(&entry);
    puts("Joystick filtering and passcode tests passed.");
    return 0;
}
