
#ifndef RG_I2C_H
#define RG_I2C_H

#include <Arduino.h>
#include <Wire.h>

// Shared MPU6050 + OLED I2C pins
#define RG_I2C_SDA_PIN       8
#define RG_I2C_SCL_PIN       9

#define RG_I2C_CLOCK_HZ      100000U
#define RG_I2C_LOCK_MS       100U

// Initialize shared bus (only once)
bool RG_I2C_Begin(void);

// Lock before using Wire / OLED / MPU6050
bool RG_I2C_Lock(void);

// Unlock after transaction
void RG_I2C_Unlock(void);

#endif
