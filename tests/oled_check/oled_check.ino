// OLED wiring check (Person 4). Not part of the main program.
//
// Wire the OLED: GND -> G, VCC -> 3V3, SCL -> GPIO9, SDA -> GPIO8.
// Upload to the ESP32-S2 (ESP32S2 Dev Module), open Serial Monitor at 115200,
// press RST. It lists every I2C device found, then writes "OLED OK" on the screen.
// Expected: 0x3C (or 0x3D) for the OLED, plus 0x68 once the MPU6050 is wired.

#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

#define SDA_PIN 8
#define SCL_PIN 9

Adafruit_SSD1306 display(128, 64, &Wire, -1);

void setup()
{
    Serial.begin(115200);
    delay(500);

    Wire.setPins(SDA_PIN, SCL_PIN);
    Wire.begin();

    Serial.println("\nI2C scan on SDA=GPIO8, SCL=GPIO9:");
    uint8_t found = 0;
    uint8_t oledAddress = 0;
    for (uint8_t address = 1; address < 127; address++) {
        Wire.beginTransmission(address);
        if (Wire.endTransmission() == 0) {
            Serial.printf("  device at 0x%02X\n", address);
            if (address == 0x3C || address == 0x3D) oledAddress = address;
            found++;
        }
    }
    if (found == 0) {
        Serial.println("  nothing found: check the 4 wires and that VCC is on 3V3");
        return;
    }
    if (oledAddress == 0) {
        Serial.println("  no OLED at 0x3C or 0x3D");
        return;
    }

    if (!display.begin(SSD1306_SWITCHCAPVCC, oledAddress, true, false)) {
        Serial.println("OLED found but failed to start");
        return;
    }
    display.clearDisplay();
    display.setTextSize(1);
    display.setTextColor(SSD1306_WHITE);
    display.setCursor(0, 0);
    display.println("OLED OK");
    display.printf("Address 0x%02X\n", oledAddress);
    display.println("RelicGuard");
    display.display();
    Serial.printf("OLED started at 0x%02X: the screen should say OLED OK\n", oledAddress);
    if (oledAddress != 0x3C) {
        Serial.println("Set RG_OLED_ADDRESS to this address in rg_oled.h");
    }
}

void loop()
{
}
