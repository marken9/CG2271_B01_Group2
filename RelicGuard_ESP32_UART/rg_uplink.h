#ifndef RG_UPLINK_H
#define RG_UPLINK_H

#include <Arduino.h>

// ============================================================
// DASHBOARD UPLINK (Wi-Fi -> RelicGuard dashboard)
// ============================================================
//
// Every RG_UPLINK_SEND_MS, combines the MCX-confirmed state
// (lid, light) with the ESP32's own DHT reading and POSTs it to
// the dashboard's /api/readings as JSON.
//
// Runs in its own low-priority FreeRTOS task, so a slow Wi-Fi
// connect or TLS handshake never stalls the UART link, DHT or OLED.
//
// Wi-Fi name/password, dashboard URL and token live in
// rg_secrets.h (not committed). Copy rg_secrets.example.h to
// rg_secrets.h and fill it in. Without it, the uplink is disabled
// and the rest of the sketch runs as before.

// Send interval; the dashboard marks data stale after 10 s
#define RG_UPLINK_SEND_MS        2000U

// Retry interval while Wi-Fi is down
#define RG_UPLINK_WIFI_RETRY_MS  15000U

// Print each upload result to the Serial Monitor
#define RG_UPLINK_DEBUG          1

// Starts the uplink task. Call after RG_ESP_Begin() and RG_DHT_Begin().
// Returns false if the uplink is disabled or the task can't start.
bool RG_Uplink_Begin(void);

#endif
