\# RelicGuard



RelicGuard is an IoT-enabled smart display case for collectibles.

## MCXC reed switch and joystick bring-up

The current firmware tests the reed switch and a KY-023-style analog joystick.
It verifies a directional passcode and grants a 30-second authorization window.
Door state and authorization control the onboard RGB LED and KY-006 passive
buzzer. UART and ESP integration are documented in `docs/person2-uart.md`;
environmental warnings are documented in `docs/person4-env-warnings.md`.

| Door | Authorization | Onboard RGB LED | Buzzer |
| --- | --- | --- | --- |
| Closed | Not granted | Solid blue | Silent |
| Either | Granted | Green blinking: 250 ms on, 250 ms off | Silent |
| Open | Not granted | Red blinking: 250 ms on, 250 ms off | Continuous 2 kHz tone |

Closing the door clears the alarm immediately after debounce. A correct
passcode also clears an ongoing alarm and starts green blinking, whether the
door is open or closed. If the 30-second grant expires while open, red blinking
starts again; if closed, the LED returns to solid blue. Closing does not
cancel the remaining grant: reopening within that window stays authorized.

### Passive buzzer wiring and test

Disconnect USB power before wiring the KY-006:

| Buzzer pin | MCU connection | Header |
| --- | --- | --- |
| S | D10 / PTD4 / TPM0 channel 4 | J2 pin 6 |
| − | GND | J3 pin 12 (or pin 14) |
| Middle | Leave unconnected for the standard KY-006 | — |

Use the printed S and − markings, not an assumed left/right orientation.
The standard passive KY-006 uses signal and ground, as shown in the
[Joy-IT Arduino wiring](https://sensorkit.joy-it.net/en/sensors/ky-006).
The [NXP pinout](https://www.nxp.com/docs/en/quick-reference-guide/MCX-C444-QSG.pdf)
identifies D10 as PTD4 on J2 pin 6.

Refresh/build the MCX project, debug and resume. With no access granted, open
the lid: red should blink and the buzzer should sound continuously, including
the LED's dark intervals. Close the lid: blue and silence. Open again and enter
the correct passcode: green blinking and silence. Leave it open until access
expires after 30 seconds: red blinking and sound should return. An incorrect
passcode must not silence an ongoing alarm. Startup before the first valid door
reading is silent. Verify joystick and UART still respond while sounding.

`Buzzer_Init` configures hardware PWM at 2 kHz, 50% duty when enabled, using
the existing 8 MHz MCGIRCLK with /8 prescaling (MOD=499, CnV=250). Zero duty
silences it. `ControlTask` enables it from `ALARM_UNAUTHORIZED_OPEN`, independently
of blink phase. No extra task, ISR or delay is used. TPM0 is reserved for this
output; the RGB pins remain GPIO, including the red pin which has an unused
alternate TPM0 channel 4 function. Environmental beep requests and movement
alarm latching remain separate integration work.
This alarm follows the current condition and does not latch past incidents.
The LED is off during each blink's off phase and while waiting for the initial
door-state event without access. Door movement does not reset the green blink.

The onboard LED uses PTE31 (red), PTD5 (green), and PTE29 (blue), active low.
No extra LED wiring is needed. These pins are reserved for the RGB actuator.

Disconnect USB before changing wiring. Power the joystick from **3.3 V**, even
if its supply pin is marked `+5V`, so its analog outputs stay within the MCX
input range. Follow printed pin names rather than physical pin order.

| Module pin | MCU connection | Header |
| --- | --- | --- |
| Joystick GND | GND | J3 pin 12 (or pin 14) |
| Joystick VCC / +5V | 3.3 V | J3 pin 8 |
| Joystick VRx | A1 / PTB1 / ADC0_SE9 | J4 pin 4 |
| Joystick VRy | A2 / PTB2 / ADC0_SE12 | J4 pin 6 |
| Joystick SW / button | D8 / PTA13, internal pull-up | J2 pin 2 |
| Reed S | D3 / PTA12 | J1 pin 8 |
| Reed supply | 3.3 V | J3 pin 8 |
| Reed ground | GND | J3 pin 12 (or pin 14) |

References: [NXP board pinout, page 3](https://www.nxp.com/docs/en/quick-reference-guide/MCX-C444-QSG.pdf)
and [Joy-IT joystick documentation](https://sensorkit.joy-it.net/en/sensors/ky-023).

### Flash and verify

1. Terminate the existing debug session, unplug USB and wire the joystick.
2. Reconnect USB. Refresh the nested `CG3201FinalProject_B01_Group2` project in
   MCUXpresso so the new `source/joystick_password.c` file is discovered. Build,
   launch its LinkServer debug configuration and resume.
3. Leave the stick centred initially. The serial output should show both axes
   near 2048, `CENTER`, and `RELEASED`. Values vary between modules; the centre
   band is 1500–2600. Conversion success does not prove a sensor is connected.
4. Move each axis separately, holding long enough to observe the one-second
   serial update. Check the reported direction and return to centre each time.
   The default convention is low X = LEFT, high X = RIGHT, low Y = UP, high Y =
   DOWN. Physical orientation may differ; `JOY_SWAP_AXES`, `JOY_INVERT_X` and
   `JOY_INVERT_Y` in the main C file allow correction without rewiring.
5. Wait 10 seconds for any partial test entry to clear. Enter **UP, DOWN, LEFT,
   RIGHT**, returning to centre between directions. Press the stick straight
   down to submit. Expect `ACCEPTED` and `GRANTED (30 s)`.
6. Try an incorrect sequence and submit: expect `REJECTED`. An incomplete
   sequence is rejected too. More than four directions marks the entry invalid;
   submit to reject and clear it. Ten seconds without another direction clears
   an unfinished entry. A held stick must add only one character; a held button
   must submit only once. Check authorization expires after 30 seconds.
7. Without access, move the reed magnet near/away: expect CLOSED/blue and
   OPEN/blinking red. Enter the correct code while open: expect blinking green.
   Keep the door open for 30 seconds: expect blinking red again. Close it:
   expect blue. Also test granting access while closed: green blinking should
   start immediately and continue when opening or closing within 30 seconds.
   Let the grant expire while closed and confirm it returns to solid blue.

`Passcode: [***]` masks the entered sequence, but the current live direction/raw
axis diagnostics are intentionally visible for wiring tests. The test passcode
is fixed in firmware; this is not a hardened authentication implementation.

### Code organization and RTOS flow

- `source/CG3201FinalProject_B01_Group2.c`: hardware setup and RTOS tasks.
- `source/joystick_password.c` and `.h`: direction filtering and passcode logic.
- `source/alarm.c` and `.h`: door/access state decisions and blink timing.
- `tests/test_joystick_password.c`: host tests, outside the MCU source directory.
- `tests/test_alarm.c`: alarm transitions and blink timing, including tick wrap.

The former `DoorTask` is now `InputTask` (priority 4). Both PTA12 and PTA13
interrupts give one binary `inputSemaphore`; InputTask waits 25 ms, reads both
pins, publishes button diagnostics and queues the initial door state, subsequent
door changes and new button presses.
This is not a counting semaphore: it wakes the task to inspect current levels.
The Port A IRQ is enabled only after the scheduler starts.

`ADCTask` (priority 2) owns ADC0 and samples both axes every 20 ms. Three matching
samples qualify a direction or centre. A stable centre is required before the
first direction and between subsequent directions. Diagonals are ignored. The
button suppresses directional entry while pressed. The ADC uses long sample
mode to allow the potentiometer output to settle.

`ControlTask` (priority 3) receives direction, submit and door events through an
event queue and owns the passcode, authorization, door and alarm states. It is
the sole runtime writer of the RGB and buzzer outputs. A queue wait of at most 50 ms allows
it to check grant expiry and blink timing even without input; blinking never
adds a blocking delay or an extra task. Producers block if
the queue is full rather than silently losing characters. `MonitorTask`
(priority 1) prints snapshots once per second. A mutex protects shared snapshots;
printing occurs after releasing the mutex. Pre-emption and time slicing are
enabled. A different password submission can revoke an existing authorization.

Light sampling is enabled with `ENABLE_LIGHT_SENSOR = 1`, using A0 / PTB0
(J4 pin 2) every 100 ms in the same ADC task as the joystick. The ADC reference
is explicitly set to the alternate reference, matching the lab code. The legacy MCX DHT
test is disabled with `ENABLE_MCX_DHT = 0`; the final design places that sensor
on ESP32. The disabled code remains available for later work. There are four
application tasks with these defaults; UART will replace/restructure diagnostic
work during the later integration stage.

### Automated validation

Run from the repository root on a host with a C compiler:

```sh
cc -std=c11 -Wall -Wextra -Werror \
  -I MCXC/CG3201FinalProject_B01_Group2/source \
  tests/test_joystick_password.c \
  MCXC/CG3201FinalProject_B01_Group2/source/joystick_password.c \
  -o /tmp/relicguard-joystick-tests
/tmp/relicguard-joystick-tests
cc -std=c11 -Wall -Wextra -Werror \
  -I MCXC/CG3201FinalProject_B01_Group2/source \
  tests/test_alarm.c MCXC/CG3201FinalProject_B01_Group2/source/alarm.c \
  -o /tmp/relicguard-alarm-tests
/tmp/relicguard-alarm-tests
```

The host tests cover startup/held-stick suppression, return-to-centre, transient
noise, diagonals, all directions, exact passcode matching, wrong order, partial
entries and overlong entries. These do not replace the physical wiring, button,
RTOS timing and authorization-expiry checks above.

