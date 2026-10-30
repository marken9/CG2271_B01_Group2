# RelicGuard - Person 2 UART handover

This adds transport and integration interfaces to the supplied MCXC444 project.
The door/password/RGB behavior is retained. Person 1 still implements movement
alarm latching and the buzzer. Person 4 still implements environmental decisions.
No real ESP sensors are assumed to be present.

## Repository layout and setup

- `MCXC/CG3201FinalProject_B01_Group2`: existing MCUXpresso project with UART additions.
- `RelicGuard_ESP32_UART`: Arduino sketch; keep all five files together.
- `tests/test_uart_protocol.c`: host tests for the shared protocol.
- `docs/person2-test-results.md`: completed checks and remaining verification.
- `docs/uart-sample-messages.txt`: framed examples with calculated CRCs.

Import the existing MCX project; the FreeRTOS heap is 14336 bytes. Select
**ESP32S2 Dev Module** in Arduino and open the ESP sketch. Use Espressif
Arduino core 3.1.3 (tested). This board uses a CP2102N USB-to-UART bridge;
install its Silicon Labs VCP driver if it appears as an unknown device.
The tested user's ports were ESP COM6 and MCU-Link COM3, but other computers
may assign different numbers. Keep USB CDC on boot disabled for UART0 Serial
if that option is shown. `RG_DEMO_SENSORS` must remain **0** for handover.

## Wiring (when the Micro-USB data cable is available)

Power OFF before adding the three signal wires. Power each development board
from its own laptop USB cable. Do not connect their 5 V or 3.3 V power pins.

| MCXC444 | ESP32-S2 board |
|---|---|
| PTE0 / J2 pin 18 / D18: LPUART1 TX | GPIO16: UART1 RX |
| PTE1 / J2 pin 20 / D19: LPUART1 RX | GPIO17: UART1 TX |
| GND (e.g. J2 pin 14, or a labelled GND header) | G / GND |

These are the physical **J2 header pin numbers**, not Arduino D18/D19 numbers
counted along a single row. Confirm header orientation from the board markings
before connecting. PTE0 and PTE1 are also available on the mikroBUS TX/RX header.
Use the ESP header labels **16** and **17**, not the board's default RX/TX labels.
Baud rate: **115200, 8 data bits, no parity, 1 stop bit**, no flow control.
All signal levels are 3.3 V. MCX debug messages stay on LPUART0 / MCU-Link VCOM.

Pin reference: https://www.nxp.com/docs/en/quick-reference-guide/MCX-C444-QSG.pdf
The existing project's pin_mux.c independently identifies PTE0/PTE1 as ALT3.

## What runs where

MCX has an additional UART task at priority 2, with a 512-word task stack.
Its RX ISR only fills a 512-byte ring buffer; parsing is outside the ISR.
UART task owns LPUART1 and the protocol state. A one-slot TX queue keeps the
latest status snapshot (new snapshots replace old ones instead of building up).
ControlTask remains the sole owner of access decisions and RGB output. Requests
pass through a request queue; the result queue returns completion to UARTTask.
Transmit polling has a 30 ms frame deadline, so a stalled transmitter cannot
wait forever; higher-priority input/control tasks can still preempt it.

ESP has one communication task (priority 2, 4096-byte stack). Sensor tasks use
thread-safe queue APIs. Only the communication task accesses UART1. The state
mutex here protects status snapshots; it is separate from the shared **I2C**
mutex that Persons 3 and 4 need for MPU6050/OLED access.

## Protocol v1

ASCII frame:

```
@RG1,SSSSSSSS,QQQQQQQQ,T,LL:payload*CCCC\n
```

`S`: sender's 32-bit boot/session tag in uppercase hex. `Q`: sequence number,
32-bit uppercase hex. `T`: one-letter type. `LL`: payload byte length in hex,
maximum 80. `CCCC`: CRC-16/CCITT-FALSE (polynomial 0x1021, initial 0xFFFF,
no reflection, no final XOR). CRC covers bytes after `@` through the payload,
excluding `*`, CRC text and newline. All numeric payload fields are decimal
except H's uptime and A's target session, which are eight hex digits.

The parser checks exact length, CRC, delimiters and numeric ranges. It rejects
overlong frames and restarts at `@`; a partial frame expires after 250 ms between
bytes. CRLF is accepted as well as LF. Unknown types do not update liveness.

| Type | Direction | Payload |
|---|---|---|
| H | Both, every 1 s | `uptimeMsHex` |
| S | MCX -> ESP, every 500 ms | `doorValid,doorOpen,access,remainingMs,alarm,warningMask,warningValid,lightValid,lightRaw,lightPercent,exposureValid,exposure` |
| C | ESP -> MCX | `valid,temperatureX10,humidityX10` |
| V | ESP -> MCX, every 250 ms | `valid,moving` current motion state |
| M | ESP -> MCX, reliable | `1,1` qualifying movement event |
| R | ESP -> MCX, reliable | `30` request 30-second access |
| L | ESP -> MCX, reliable | `tempLowX10,tempHighX10,humidityLowX10,humidityHighX10,lightHighPercent,exposureLimit` |
| A | Both, response | `originalSenderSessionHex,result`; header sequence echoes request sequence |

Alarm values currently match alarm.h: 0 waiting, 1 door closed, 2 access
granted, 3 unauthorised open. Keep these stable or update both sides together.
Warnings and exposure currently have validity=false. They are **unavailable**,
not normal. Light percentage is an uncalibrated ADC percentage at present.

Results: 0 processed/applied, 1 bad payload, 2 unsupported, 3 busy, 4 old/reused
sequence. One reliable request may be outstanding per direction. Retry after
400 ms, at most **4 total transmissions** (initial + 3 retries). A duplicate
receives its cached ACK; an in-progress duplicate is not executed again. Old
sequences are rejected. Application effects happen in ControlTask before ACK.
For M, success means the event was delivered to ControlTask; it does not claim
that Person 1's movement alarm has already been implemented.

Heartbeat silence for 3500 ms marks the peer offline. Climate is independently
stale after 15000 ms without a valid source update; motion after 1500 ms.
MCX state on ESP is unavailable after 1500 ms without an S frame, even if H
continues. Historical values may remain in memory; validity gates their use.

Deduplication is scoped to the current boot/session and retained across a link
timeout. Session changes or uptime rollback cancel pending work. It is not
durable across power loss. If an ACK is lost after execution, the final result
can be UNKNOWN; never automatically turn that into a new access request with
a new sequence. Queued ESP commands expire after 2 s and are discarded on
reconnect rather than being replayed later. Use confirmed MCX status for UI.

## Person 3: sensor integration

Include `rg_esp_uart.h`. Call `RG_ESP_Begin()` once from setup before tasks use
the API (the supplied sketch already does this). Keep its communication task.

```cpp
// DHT task, once per 5 seconds, after validating sensor read/checksum:
RG_ESP_PublishClimate(true, 265, 600); // 26.5 C, 60.0 %RH
// Failed read:
RG_ESP_PublishClimate(false, 0, 0);   // zeros are ignored because invalid

// MPU task, publish current state at least every 250 ms:
RG_ESP_PublishMotion(mpuReadOK, significantMovement);
// For each newly qualified movement event (including during access):
bool queued = RG_ESP_MovementEvent();
```

Check boolean returns; false means offline, invalid arguments or a full queue.
Do not emit M for every raw sample; filter/debounce events and publish ongoing
stability via V. Continue sampling/reporting during access. MCX owns policy.
Your I2C sensor/OLED tasks must not hold the I2C mutex while waiting for UART.
Keep `RG_DEMO_SENSORS=0` for the real handover. Setting it to 1 generates clearly
logged simulated readings, which must not be mixed with real sensor tasks.

## Person 1: alarm integration

In main's ControlTask, find `PERSON 1 INTEGRATION POINT`. The M branch is reached
once per accepted reliable event and currently increments `g_rgMotionEventCount`.
Latch the movement alarm there when access is not granted. Current movement and
its validity are available via `RG_MCX_GetESP()`. Check validity before calling
the case stationary. Keep security alarms and access decisions in ControlTask;
do not move alarm policy into UARTTask. Publish the final alarm state through
`wire.alarm`. Extend status codes on both sides if adding distinct alarm states.

## Persons 4 and 5

MCX: `RG_MCX_GetESP()` supplies climate/motion plus independent validity flags.
`g_rgLimits` and `g_rgLimitsConfigured` hold validated received limits. Only
ControlTask writes them. Add environmental logic there, or synchronize any
additional readers. Group-approved initial limits are still needed; none have
been silently adopted. Fill `wire.warningValid`, `wire.warningMask`,
`wire.exposureValid` and `wire.exposure` when those features exist. Exposure
uses an agreed relative-unit total, capped to signed 32-bit positive range
for protocol v1. Keep thresholds and reset policy documented by the group.

ESP OLED/website: call `RG_ESP_GetConfirmed()` and first test `stateValid`.
Use `doorValid`, `lightValid`, `warningValid`, `exposureValid` individually.
Get local sensor readings from Person 3's shared sensor store; this module does
not own the DHT/MPU readings for display. Never grant access based on a web click
or an ACK alone; display the MCX-confirmed access state.

After authenticating a website user, Person 5 may call `RG_ESP_RequestAccess()`
or `RG_ESP_SetLimits(...)`. A true return means QUEUED, not applied. Drain
`RG_ESP_TakeCommandResult()` regularly for type, sequence and result. Keep one
user command awaiting completion at a time to correlate results. Sequence 0 /
result -3 means discarded before transmission; -1 means ACK timeout (unknown
execution outcome); -2 means connection lost (unknown outcome). Results 0..4
are protocol ACKs. The UART protocol itself does not authenticate web users.

## Tests to perform with boards

1. Upload ESP sketch; MCX Debug/Resume. Open both serial consoles at 115200.
2. Both should report ONLINE within about 1 second. With sensors disconnected,
   climate/motion show UNAVAILABLE. A disconnected reed reads OPEN because of
   the configured pull-up; red blinking is expected with that input.
3. In ESP Serial Monitor send `a`. See command result 0 and MCX-confirmed access
   granted; RGB green blinks for 30 seconds. Test a wrong-length R via sample
   tooling if available: it must be rejected, without granting access.
4. Send `m` to exercise event delivery. Until Person 1 merges their code, this
   only records receipt; it cannot trigger a movement alarm yet.
5. Enable simulated sensor mode only for a labelled test: MCX should report
   265 temperatureX10 and 600 humidityX10. Disable again for handover.
6. Remove only one UART signal wire. Peer timeout should appear after 3.5 s,
   while local door/password/RGB processing continues. Reconnect and check
   recovery. Repeat with each wire separately (keep GND connected).
7. Later, with real sensors, stop publishing climate/motion while leaving UART
   alive: validity must expire rather than displaying old readings as current.
8. Test lost ACKs/duplicate requests and verify access is not extended by a
   retry. Host protocol tests cover this logic; repeat on hardware during
   integration, along with receiver error/overflow counters and task stack use.

Host test source is `tests/test_uart_protocol.c`; it runs against the same C protocol
used by both boards. Example with a host GCC installation:

```
gcc -std=c11 -Wall -Wextra -Werror -I MCXC/CG3201FinalProject_B01_Group2/source MCXC/CG3201FinalProject_B01_Group2/source/rg_protocol.c tests/test_uart_protocol.c -o test_uart_protocol
```

Sample frames with computed CRCs are in `docs/uart-sample-messages.txt`. An H frame with
the sender's session must precede data/commands for a newly connected peer.
