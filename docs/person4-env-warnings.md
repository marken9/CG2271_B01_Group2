# RelicGuard - Person 4 environmental warnings

Environmental decisions run on the MCXC444 inside ControlTask, the existing
owner of system state. The logic is in `source/env_warning.c` (pure C, host
tested by `tests/test_env_warning.c`). Results are sent to the ESP32 in the
existing S frame fields `warningValid`, `warningMask`, `exposureValid` and
`exposure`. The OLED and website display these; they do not decide warnings.

## Wiring

Photoresistor (KY-018) on the MCXC444. **Our module's power labels do not
match its internal wiring.** Wired as labelled, S reads 0 V regardless of light;
with power reversed it works. Verified on 2 Nov 2026 (A0 read 0 with the
sensor attached; with the sensor moved to A1, A1 also read 0, while the free A0
pin floated near 1000, so the board and ADC were fine).

| KY-018 pin | MCXC444 | Header |
|---|---|---|
| S (signal) | A0 / PTB0 / ADC0_SE8 | J4 pin 2 |
| **"-" pin** | **3.3 V** | J3 pin 8 |
| **middle pin** | **GND** | J3 pin 12 |

Temperature and humidity come from the ESP32 (DHT11 data on GPIO4) over the
UART link: MCX PTE0 (J2 pin 18) -> ESP GPIO16, MCX PTE1 (J2 pin 20) <- ESP
GPIO17, GND <-> GND.

## warningMask bits (S frame, 0-255)

| Bit | Value | Meaning | Suggested text |
|---|---|---|---|
| 0 | 1 | Temperature above high limit | TEMP HIGH |
| 1 | 2 | Temperature below low limit | TEMP LOW |
| 2 | 4 | Humidity above high limit | HUMIDITY HIGH |
| 3 | 8 | Humidity below low limit | HUMIDITY LOW |
| 4 | 16 | Relative brightness above limit | TOO BRIGHT |
| 5 | 32 | Accumulated light exposure reached limit | EXPOSURE LIMIT |
| 6 | 64 | Climate data missing or stale (ESP offline or >15 s old) | CLIMATE UNAVAILABLE |
| 7 | 128 | Light reading unavailable | LIGHT UNAVAILABLE |

Bits 6 and 7 must be shown as "sensor unavailable", never as normal. With
`warningValid = 0` (MCX state unavailable), show nothing as normal either.

## Behaviour

- A reading must stay outside its limit for **10 s** before a warning is raised.
- Hysteresis: a warning clears once the reading is back inside by
  **1.0 C**, **3.0 %RH** or **5 % brightness**.
- Missing or stale climate data clears the climate warnings and sets bit 6.
- A newly raised warning increments a beep request at the marked
  `PERSON 1 INTEGRATION POINT (buzzer)`; the security alarm takes priority.

## Light reading

`lightPercent` is a **relative brightness (0-100 %)**, not lux or UV. Raw ADC
values are smoothed (moving average) and mapped between two calibration
points measured in the lab:

1. Cover the sensor fully: note `Light raw (filtered)` -> `LIGHT_DARK_RAW`.
2. Phone torch about 5 cm away: note the value -> `LIGHT_BRIGHT_RAW`.

Both are `#define`s near the top of the main C file. Either order works.

## Exposure

`exposure` is accumulated **percent-seconds** (brightness % x seconds), counted
only while the light reading is valid, capped at 2^31-1. Example: 360000 =
100 % for 1 hour, or 50 % for 2 hours. It resets when the MCX restarts (the MCX
has no real-time clock for a daily reset). Raising the limit above the total
clears the warning.

## Limits

The website's L command overrides these defaults (same order as the L frame).
The defaults match the illustrative L frame in `uart-sample-messages.txt` and
**still need group approval**:

| Limit | Default |
|---|---|
| Temperature | 18.0 - 30.0 C |
| Humidity | 30.0 - 65.0 %RH |
| Brightness | 80 % relative |
| Exposure | 360000 percent-seconds |

For the demo, lower `ENV_DEFAULT_EXPOSURE_LIMIT` (or send an L command) so the
exposure warning can be triggered with a phone torch in about a minute.

## Settings that can be tuned

| Setting | File | Default | Effect |
|---|---|---|---|
| `LIGHT_DARK_RAW` / `LIGHT_BRIGHT_RAW` | main C file | 0 / 4095 | Calibration points: raw ADC covered / under a torch |
| `LIGHT_SAMPLE_MS` | main C file | 100 | How often the light is read (ms) |
| Filter strength (`/ 4U` in `LightFilter_Update`) | env_warning.c | 1/4 | Larger divisor = smoother but slower |
| `ENV_PERSIST_MS` | env_warning.h | 10000 | Time a reading must stay out of range before warning |
| `ENV_TEMP_HYSTERESIS_X10` | env_warning.h | 10 (1.0 C) | Margin needed to clear a temperature warning |
| `ENV_HUMIDITY_HYSTERESIS_X10` | env_warning.h | 30 (3.0 %RH) | Margin needed to clear a humidity warning |
| `ENV_LIGHT_HYSTERESIS_PCT` | env_warning.h | 5 | Margin needed to clear a brightness warning |
| `ENV_DEFAULT_*` limits | env_warning.h | see Limits | Used until the website sends an L command |
| `ENV_DEFAULT_EXPOSURE_LIMIT` | env_warning.h | 360000 | Lower (e.g. 3000) to demo the exposure warning |
| `PRINT_SAMPLE_MS` | main C file | 1000 | Serial console refresh (ms) |

## Testing

Host tests:

```
gcc -std=c11 -Wall -Wextra -Werror -I MCXC/CG3201FinalProject_B01_Group2/source \
  tests/test_env_warning.c MCXC/CG3201FinalProject_B01_Group2/source/env_warning.c \
  -o test_env_warning && ./test_env_warning
```

On hardware, the MCX serial console prints the active limits, the decoded
warning mask, beep requests and accumulated exposure once per second.
