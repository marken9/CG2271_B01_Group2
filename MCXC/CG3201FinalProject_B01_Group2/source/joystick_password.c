#include "joystick_password.h"

/* Adjust these after checking raw axis readings on the physical joystick.
 * Convention: low X = LEFT, low Y = UP. Rotate the module or invert an axis
 * in ADCTask if its physical orientation does not match these labels.
 */
#define JOY_LOW 1000U
#define JOY_HIGH 3000U
#define JOY_CENTER_LOW 1500U
#define JOY_CENTER_HIGH 2600U

static const JoystickDirection password[PASSWORD_LENGTH] = {
    JOY_UP, JOY_DOWN, JOY_LEFT, JOY_RIGHT
};

JoystickDirection Joystick_Classify(uint16_t x, uint16_t y)
{
    bool xCenter = x >= JOY_CENTER_LOW && x <= JOY_CENTER_HIGH;
    bool yCenter = y >= JOY_CENTER_LOW && y <= JOY_CENTER_HIGH;
    if (xCenter && yCenter) return JOY_CENTER;
    if (xCenter && y < JOY_LOW) return JOY_UP;
    if (xCenter && y > JOY_HIGH) return JOY_DOWN;
    if (yCenter && x < JOY_LOW) return JOY_LEFT;
    if (yCenter && x > JOY_HIGH) return JOY_RIGHT;
    /* Includes diagonals and the gaps between centre/activation thresholds. */
    return JOY_DIAGONAL;
}

JoystickDirection Joystick_Sample(JoystickFilter *filter, uint16_t x, uint16_t y)
{
    JoystickDirection direction = Joystick_Classify(x, y);
    if (direction != filter->candidate) {
        filter->candidate = direction;
        filter->stableSamples = 1U;
    } else if (filter->stableSamples < JOYSTICK_STABLE_SAMPLES) {
        filter->stableSamples++;
    }
    if (filter->stableSamples < JOYSTICK_STABLE_SAMPLES) return JOY_CENTER;
    if (direction == JOY_CENTER) {
        filter->ready = true;
    } else if (direction != JOY_DIAGONAL && filter->ready) {
        filter->ready = false;
        return direction;
    }
    return JOY_CENTER;
}

void Password_Reset(PasswordEntry *entry)
{
    *entry = (PasswordEntry){0};
}

void Password_Append(PasswordEntry *entry, JoystickDirection direction)
{
    if (direction < JOY_UP || direction > JOY_RIGHT) return;
    if (entry->length >= PASSWORD_LENGTH) {
        entry->overflow = true; /* Never accept a correct prefix plus extras. */
        return;
    }
    entry->digits[entry->length++] = direction;
}

bool Password_Check(const PasswordEntry *entry)
{
    if (entry->overflow || entry->length != PASSWORD_LENGTH) return false;
    for (uint8_t i = 0; i < PASSWORD_LENGTH; i++) {
        if (entry->digits[i] != password[i]) return false;
    }
    return true;
}

const char *Joystick_DirectionName(JoystickDirection direction)
{
    switch (direction) {
        case JOY_CENTER: return "CENTER";
        case JOY_UP: return "UP";
        case JOY_DOWN: return "DOWN";
        case JOY_LEFT: return "LEFT";
        case JOY_RIGHT: return "RIGHT";
        default: return "DIAGONAL/TRANSITION";
    }
}
