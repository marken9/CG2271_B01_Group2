#ifndef RG_PROTOCOL_H
#define RG_PROTOCOL_H
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
#define RG_PAYLOAD_MAX 80U
#define RG_WIRE_MAX 120U
#define RG_HEARTBEAT_MS 1000U
#define RG_LINK_TIMEOUT_MS 3500U
#define RG_RETRY_MS 400U
#define RG_MAX_ATTEMPTS 4U
enum { RG_OK=0, RG_BAD_PAYLOAD=1, RG_UNSUPPORTED=2, RG_BUSY=3,
       RG_OLD=4, RG_DEFER=255 };
typedef struct {
    uint32_t session, seq;
    char type;
    char payload[RG_PAYLOAD_MAX+1];
} RG_Frame;
typedef struct {
    char bytes[RG_WIRE_MAX];
    size_t used;
    uint32_t lastByte;
    uint32_t errors;
} RG_Parser;
uint16_t RG_CRC(const uint8_t *data, size_t len);
size_t RG_Encode(const RG_Frame *frame, char *out, size_t capacity);
bool RG_ParseLine(const char *line, size_t len, RG_Frame *frame);
bool RG_Feed(RG_Parser *parser, uint8_t byte, uint32_t now, RG_Frame *frame);
bool RG_Numbers(const char *payload, int32_t *values, size_t count);

/* Every function below runs in ONE communication task, never an ISR.
 * request() may return RG_DEFER; call RG_Complete after the control task
 * actually processes it. One outstanding request in each direction.
 */
typedef bool (*RG_SendFn)(void *ctx, const RG_Frame *frame);
typedef bool (*RG_DataFn)(void *ctx, const RG_Frame *frame);
typedef uint8_t (*RG_RequestFn)(void *ctx, const RG_Frame *frame);
typedef void (*RG_ResultFn)(void *ctx, uint32_t seq, int result);
typedef struct {
    void *ctx;
    RG_SendFn send;
    RG_DataFn data;
    RG_RequestFn request;
    RG_ResultFn result;
    uint32_t session, nextSeq, peerSession, lastRx, lastHeartbeat;
    uint32_t peerUptime, lastHelloRx;
    bool online, haveHello;
    RG_Frame pending, incoming, lastRequest;
    bool pendingActive, incomingActive, haveReply;
    uint8_t attempts, lastResult;
    uint32_t sentAt;
    uint32_t timeouts, duplicates;
} RG_Link;
void RG_LinkInit(RG_Link *link, uint32_t session, void *ctx,
                 RG_SendFn send, RG_DataFn data, RG_RequestFn request,
                 RG_ResultFn result);
bool RG_SendData(RG_Link *link, char type, const char *payload);
bool RG_Request(RG_Link *link, char type, const char *payload, uint32_t now);
void RG_Receive(RG_Link *link, const RG_Frame *frame, uint32_t now);
void RG_Complete(RG_Link *link, const RG_Frame *request, uint8_t result);
void RG_Poll(RG_Link *link, uint32_t now);
#ifdef __cplusplus
}
#endif
#endif
