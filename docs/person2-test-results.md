# Person 2 UART verification - 30 October 2026

## Software checks completed

- MCXC444 code compiled and linked using MCUXpresso; user build reported zero
  errors and zero warnings. ESP32-S2 sketch compiled and uploaded successfully
  using Arduino IDE 2.3.3 and Espressif core 3.1.3.
- Native C protocol tests passed against the implementation used by both
  boards: CRC known vector, encode/decode, corrupt frame rejection, partial
  frame timeout, overflow recovery, numeric validation, duplicate and deferred
  requests, old/reused sequences, bounded retries, ACK/session matching,
  peer restart, reconnection deduplication and millisecond wraparound.
- Shared protocol copies on MCX and ESP match. Sample CRCs were also generated
  using Python's independent CRC implementation.

## Hardware checks completed by the user

- MCX status received by ESP: `MCX ONLINE | confirmed state VALID`, with door,
  access, alarm and ADC values visible.
- Sending `a` from ESP Serial Monitor produced an R acknowledgement result 0,
  MCX access granted and blinking green LED. User confirmed access expired
  after 30 seconds and returned to no access.
- Removing the wire at ESP GPIO16 interrupted reception; reconnecting restored
  valid MCX status. Precise timeout durations were not measured.
- Sending `m` produced M acknowledgement result 0. Repeated during access,
  the event was acknowledged and access remained granted.
- User reported ESP reset/reconnection worked. The exact access-timer behavior
  across reset was not captured and remains unverified.
- With demo mode 1, MCX received temperatureX10=265 and humidityX10=600, and
  reported climate VALID and motion STATIONARY. These were explicitly simulated
  values, not real sensor measurements.
- Demo mode restored to 0 and uploaded again. Final MCX output:

```
ESP link: ONLINE | climate: UNAVAILABLE | motion: UNAVAILABLE
UART frames=5241 CRC/parse=0 hardware=0 txErrors=0
```

The final tested state has no simulated climate/motion data. A successful light
ADC conversion does not establish a connected or calibrated photoresistor.

## Remaining integration and hardware verification

- Real DHT11/MPU6050 readings, failed-read handling and stale readings while
  heartbeat remains alive; independently expiring climate and motion data.
- Reverse-direction wire removal (ESP TX to MCX RX), deliberate lost ACKs and
  retry/duplicate behavior on real boards. Logic tests passed on the host;
  those are not substitutes for the outstanding physical tests.
- Local joystick/door/alarm operation during communication failure, actual
  hardware receiver overflow/error recovery and task-stack high water marks.
- Environmental limit commands are implemented but not exercised on hardware.
- Precise restart/access-timer behavior and measured timeout durations.

Person 1 still implements buzzer/movement alarm policy. Person 3 supplies real
sensor readings; Person 4 supplies environmental warnings/exposure and OLED;
Person 5 supplies authenticated website controls and network integration.
A movement ACK currently confirms delivery to ControlTask, not activation of
an implemented movement alarm. Environmental limit ACKs confirm storage, not
execution of the future environmental warning controller.
