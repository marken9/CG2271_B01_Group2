#ifndef JOYSTICK_PASSWORD_H
#define JOYSTICK_PASSWORD_H

#include <stdbool.h>
#include <stdint.h>

#define PASSWORD_LENGTH 4U
#define JOYSTICK_STABLE_SAMPLES 3U

typedef enum {
    JOY_CENTER = 0, JOY_UP, JOY_DOWN, JOY_LEFT, JOY_RIGHT,
    JOY_DIAGONAL
} JoystickDirection;

typedef struct {
    JoystickDirection candidate;
    uint8_t stableSamples;
    bool ready;
} JoystickFilter;

typedef struct {
    JoystickDirection digits[PASSWORD_LENGTH];
    uint8_t length;
    bool overflow;
} PasswordEntry;

/* Pure logic: no hardware or RTOS calls, so it can be tested on a host. */
JoystickDirection Joystick_Classify(uint16_t x, uint16_t y);
JoystickDirection Joystick_Sample(JoystickFilter *filter, uint16_t x, uint16_t y);
void Password_Reset(PasswordEntry *entry);
void Password_Append(PasswordEntry *entry, JoystickDirection direction);
bool Password_Check(const PasswordEntry *entry);
const char *Joystick_DirectionName(JoystickDirection direction);

#endif
