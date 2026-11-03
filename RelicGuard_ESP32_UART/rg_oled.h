#ifndef RG_OLED_H
#define RG_OLED_H

#include <Arduino.h>

// ============================================================
// OLED DISPLAY (Person 4)
// ============================================================
//
// 0.96" SSD1306, 128 x 64, I2C, on the shared bus from rg_i2c.h
// (SDA = GPIO8, SCL = GPIO9, also used by the MPU6050).
//
// Shows what the MCXC444 has CONFIRMED (lid, access, alarm, light,
// environmental warnings) plus the local DHT11 reading. The ESP32
// never decides alarms or warnings itself; it only displays them.
//
// Needs the Arduino libraries "Adafruit SSD1306" and "Adafruit GFX Library".

// 0 = skip the OLED completely (e.g. if it is not connected yet)
#define RG_OLED_ENABLED         1

#define RG_OLED_WIDTH           128
#define RG_OLED_HEIGHT          64

// Most modules are 0x3C. If the screen stays blank and an I2C scan
// shows 0x3D, change this.
#define RG_OLED_ADDRESS         0x3C

// How often the screen is redrawn
#define RG_OLED_REFRESH_MS      500U

// Serial messages about the OLED
#define RG_OLED_DEBUG           1

// Call once in setup(), after RG_ESP_Begin() and RG_DHT_Begin().
bool RG_OLED_Begin(void);

// Call every loop(); it redraws only every RG_OLED_REFRESH_MS.
void RG_OLED_Update(void);

#endif
