#include "rg_esp_uart.h"
#include "rg_protocol.h"
#include <esp_system.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <freertos/queue.h>
#include <freertos/semphr.h>

/* UART1 is independent of the board's USB-to-UART console (Serial/UART0).
 * Reserve GPIO16=RX and GPIO17=TX for Person 2. */
static HardwareSerial mcx(1);
static RG_Link linkState;
static RG_Parser parser;
static QueueHandle_t commands, climateQueue, motionQueue, resultQueue;
static SemaphoreHandle_t stateMutex;
static RG_ConfirmedState confirmed={};
struct Climate {bool valid;int16_t t;uint16_t h;uint32_t at;};
struct Motion {bool valid,moving;uint32_t at;};
struct Command {char type;char payload[RG_PAYLOAD_MAX+1];uint32_t queuedAt;};
static void discardQueuedCommands() {
    Command cmd;
    while (xQueueReceive(commands,&cmd,0)==pdTRUE) {
        RG_CommandResult r={cmd.type,0,-3};
        xQueueSend(resultQueue,&r,0);
    }
}
static bool sendFrame(void *,const RG_Frame *f) {
    char bytes[RG_WIRE_MAX];size_t n=RG_Encode(f,bytes,sizeof(bytes));
    if (!n || mcx.availableForWrite()<(int)n) return false;
    return mcx.write((const uint8_t *)bytes,n)==n;
}
static bool data(void *,const RG_Frame *f) {
    if (f->type!='S') return false;
    int32_t v[12];
    if (!RG_Numbers(f->payload,v,12)) return false;
    const unsigned flags[]={0,1,2,6,7,10};
    for (unsigned i:flags) if (v[i]<0||v[i]>1) return false;
    if (v[3]<0||v[3]>30000||v[4]<0||v[4]>3||v[5]<0||v[5]>255||
        v[8]<0||v[8]>4095||v[9]<0||v[9]>100||v[11]<0) return false;
    xSemaphoreTake(stateMutex,portMAX_DELAY);
    confirmed.stateValid=true;confirmed.receivedAt=millis();
    confirmed.doorValid=v[0];confirmed.doorOpen=v[1];confirmed.accessGranted=v[2];
    confirmed.accessRemainingMs=v[3];confirmed.alarm=v[4];confirmed.warningMask=v[5];
    confirmed.warningValid=v[6];confirmed.lightValid=v[7];confirmed.lightRaw=v[8];
    confirmed.lightPercent=v[9];confirmed.exposureValid=v[10];confirmed.exposure=v[11];
    xSemaphoreGive(stateMutex);return true;
}
static void result(void *,uint32_t seq,int code) {
    RG_CommandResult r={linkState.pending.type,seq,code};
    if (xQueueSend(resultQueue,&r,0)!=pdTRUE)
        Serial.println("UART result queue full: consumer must drain it");
    Serial.printf("UART command seq=%lu result=%d (0=applied, -1=ACK timeout/UNKNOWN, -2=link lost/UNKNOWN)\n",
                  (unsigned long)seq,code);
    /* A timeout is an UNKNOWN outcome: never create a fresh access request
     * automatically. The old command may have executed and its ACK been lost.
     * Website/OLED must use RG_ESP_GetConfirmed(), not this log, for access. */
}
static void communicationTask(void *) {
    Climate climate={};Motion motion={};
    uint32_t climateSent=0U-5000U,motionSent=0U-250U;
    for (;;) {
        uint32_t now=millis();
        unsigned budget=512;
        while (mcx.available()&&budget--) {
            RG_Frame f;
            if (RG_Feed(&parser,(uint8_t)mcx.read(),now,&f)) {
                bool wasOnline=linkState.online;uint32_t oldSession=linkState.peerSession;
                uint32_t oldUptime=linkState.peerUptime;
                RG_Receive(&linkState,&f,now);
                if (f.type=='H' && (!wasOnline || oldSession!=linkState.peerSession ||
                    (int32_t)(linkState.peerUptime-oldUptime)<0)) {
                    xSemaphoreTake(stateMutex,portMAX_DELAY);confirmed.stateValid=false;
                    xSemaphoreGive(stateMutex);
                    /* Never carry previously queued web commands into a new connection. */
                    discardQueuedCommands();
                }
            }
        }
        RG_Poll(&linkState,now);
        xSemaphoreTake(stateMutex,portMAX_DELAY);
        confirmed.online=linkState.online;
        if (!confirmed.online) confirmed.stateValid=false;
        xSemaphoreGive(stateMutex);
        Climate newClimate;Motion newMotion;
        if (xQueueReceive(climateQueue,&newClimate,0)==pdTRUE) {climate=newClimate;climateSent=now-5000U;}
        if (xQueueReceive(motionQueue,&newMotion,0)==pdTRUE) motion=newMotion;
        if ((uint32_t)(now-climateSent)>=5000U) {
            bool valid=climate.valid&&(uint32_t)(now-climate.at)<15000U;
            char p[40];snprintf(p,sizeof(p),"%u,%d,%u",valid,valid?climate.t:0,valid?climate.h:0);
            RG_SendData(&linkState,'C',p);climateSent=now;
        }
        if ((uint32_t)(now-motionSent)>=250U) {
            bool valid=motion.valid&&(uint32_t)(now-motion.at)<1500U;
            char p[12];snprintf(p,sizeof(p),"%u,%u",valid,valid&&motion.moving);
            RG_SendData(&linkState,'V',p);motionSent=now;
        }
        if (!linkState.pendingActive) {
            Command cmd;
            if (xQueueReceive(commands,&cmd,0)==pdTRUE) {
                if (linkState.online&&(uint32_t)(now-cmd.queuedAt)<2000U)
                    RG_Request(&linkState,cmd.type,cmd.payload,now);
                else {
                    RG_CommandResult r={cmd.type,0,-3};
                    xQueueSend(resultQueue,&r,0);
                    Serial.println("UART queued command discarded: offline or older than 2 s");
                }
            }
        }
        vTaskDelay(pdMS_TO_TICKS(5));
    }
}
bool RG_ESP_Begin() {
    commands=xQueueCreate(8,sizeof(Command));
    resultQueue=xQueueCreate(12,sizeof(RG_CommandResult));
    climateQueue=xQueueCreate(1,sizeof(Climate));motionQueue=xQueueCreate(1,sizeof(Motion));
    stateMutex=xSemaphoreCreateMutex();
    if (!commands||!climateQueue||!motionQueue||!stateMutex||!resultQueue) return false;
    mcx.setRxBufferSize(1024);mcx.setTxBufferSize(512);
    mcx.begin(115200,SERIAL_8N1,16,17);
    RG_LinkInit(&linkState,esp_random(),nullptr,sendFrame,data,nullptr,result);
    return xTaskCreate(communicationTask,"RG_UART",4096,nullptr,2,nullptr)==pdPASS;
}
bool RG_ESP_PublishClimate(bool valid,int16_t t,uint16_t h) {
    if (!climateQueue || (valid&&(t<-400||t>1000||h>1000))) return false;
    Climate c={valid,t,h,millis()};return xQueueOverwrite(climateQueue,&c)==pdTRUE;
}
bool RG_ESP_PublishMotion(bool valid,bool moving) {
    if (!motionQueue) return false;
    Motion m={valid,moving,millis()};return xQueueOverwrite(motionQueue,&m)==pdTRUE;
}
static bool enqueue(char type,const char *p) {
    if (!commands || strlen(p)>RG_PAYLOAD_MAX) return false;
    RG_ConfirmedState state;RG_ESP_GetConfirmed(&state);
    if (!state.online) return false;
    Command cmd={};cmd.type=type;strcpy(cmd.payload,p);cmd.queuedAt=millis();
    return xQueueSend(commands,&cmd,0)==pdTRUE;
}
bool RG_ESP_MovementEvent() {return enqueue('M',"1,1");}
bool RG_ESP_RequestAccess() {return enqueue('R',"30");}
bool RG_ESP_SetLimits(int tl,int th,int hl,int hh,int light,int exposure) {
    if (tl<-400||th>1000||tl>=th||hl<0||hh>1000||hl>=hh||light<1||light>100||exposure<1) return false;
    char p[RG_PAYLOAD_MAX+1];snprintf(p,sizeof(p),"%d,%d,%d,%d,%d,%d",tl,th,hl,hh,light,exposure);
    return enqueue('L',p);
}
void RG_ESP_GetConfirmed(RG_ConfirmedState *s) {
    if (!stateMutex) {*s={};return;}
    xSemaphoreTake(stateMutex,portMAX_DELAY);*s=confirmed;xSemaphoreGive(stateMutex);
    uint32_t age=(uint32_t)(millis()-s->receivedAt);
    s->stateValid=s->stateValid&&s->online&&age<1500U;
    if (s->stateValid && s->accessGranted) {
        s->accessRemainingMs=age<s->accessRemainingMs?s->accessRemainingMs-age:0;
        /* Keep accessGranted as the last MCX-confirmed value. A new MCX
         * status is required to confirm expiry or a renewed grant. */
    }
}
bool RG_ESP_TakeCommandResult(RG_CommandResult *r) {
    return resultQueue&&xQueueReceive(resultQueue,r,0)==pdTRUE;
}
