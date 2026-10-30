#include "rg_mcx_uart.h"
#include "fsl_lpuart.h"
#include "fsl_port.h"
#include "fsl_clock.h"
#include "semphr.h"
#include "queue.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define RX_SIZE 512U
static volatile uint8_t rx[RX_SIZE];
static volatile uint16_t rxHead, rxTail;
static volatile uint32_t hardwareErrors;
static QueueHandle_t txQueue, requestQueue, replyQueue;
static SemaphoreHandle_t peerMutex;
static RG_ESP_State peer;
static RG_Link linkState;
static RG_Parser parser;
static uint32_t txErrors, txDropped, rxFrames;
static uint32_t millisNow(void) {return (uint32_t)xTaskGetTickCount()*portTICK_PERIOD_MS;}

void LPUART1_IRQHandler(void) {
    uint32_t flags=LPUART_GetStatusFlags(LPUART1);
    uint32_t errors=flags&(kLPUART_RxOverrunFlag|kLPUART_NoiseErrorFlag|
                          kLPUART_FramingErrorFlag|kLPUART_ParityErrorFlag);
    if (flags&kLPUART_RxDataRegFullFlag) {
        uint8_t byte=LPUART_ReadByte(LPUART1);
        uint16_t next=(uint16_t)((rxHead+1U)&(RX_SIZE-1U));
        if (next==rxTail || errors) hardwareErrors++;
        else {rx[rxHead]=byte;__DMB();rxHead=next;}
    }
    if (errors) {hardwareErrors++;LPUART_ClearStatusFlags(LPUART1,errors);}
    /* No FreeRTOS calls in this ISR. */
}
static bool sendFrame(void *ctx,const RG_Frame *f) {
    (void)ctx;
    char bytes[RG_WIRE_MAX];size_t n=RG_Encode(f,bytes,sizeof(bytes));
    if (!n) {txErrors++;return false;}
    TickType_t started=xTaskGetTickCount();
    for (size_t i=0;i<n;i++) {
        while (!(LPUART_GetStatusFlags(LPUART1)&kLPUART_TxDataRegEmptyFlag)) {
            if ((TickType_t)(xTaskGetTickCount()-started)>=pdMS_TO_TICKS(30)) {
                txErrors++;return false;
            }
        }
        LPUART_WriteByte(LPUART1,(uint8_t)bytes[i]);
    }
    return true;
}
static bool receiveData(void *ctx,const RG_Frame *f) {
    (void)ctx;int32_t v[3];uint32_t now=millisNow();
    if (f->type=='C') {
        if (!RG_Numbers(f->payload,v,3) || v[0]<0 || v[0]>1 ||
            v[1]<-400 || v[1]>1000 || v[2]<0 || v[2]>1000) return false;
        xSemaphoreTake(peerMutex,portMAX_DELAY);
        peer.climateValid=v[0]!=0;peer.climateAt=now;
        if (v[0]) {peer.temperatureX10=(int16_t)v[1];peer.humidityX10=(uint16_t)v[2];}
        xSemaphoreGive(peerMutex);return true;
    }
    if (f->type=='V') {
        if (!RG_Numbers(f->payload,v,2) || v[0]<0 || v[0]>1 || v[1]<0 || v[1]>1) return false;
        xSemaphoreTake(peerMutex,portMAX_DELAY);
        peer.motionValid=v[0]!=0;peer.moving=v[1]!=0;peer.motionAt=now;
        xSemaphoreGive(peerMutex);return true;
    }
    return false;
}
bool RG_LimitsParse(const char *p,RG_Limits *limits) {
    int32_t v[6];
    if (!RG_Numbers(p,v,6) || v[0]<-400 || v[1]>1000 || v[0]>=v[1] ||
        v[2]<0 || v[3]>1000 || v[2]>=v[3] || v[4]<1 || v[4]>100 || v[5]<1) return false;
    *limits=(RG_Limits){v[0],v[1],v[2],v[3],v[4],v[5]};return true;
}
static uint8_t receiveRequest(void *ctx,const RG_Frame *f) {
    (void)ctx;int32_t v[2];RG_Limits limits;
    if (f->type=='R' && strcmp(f->payload,"30")) return RG_BAD_PAYLOAD;
    if (f->type=='L' && !RG_LimitsParse(f->payload,&limits)) return RG_BAD_PAYLOAD;
    if (f->type=='M' && (!RG_Numbers(f->payload,v,2) || v[0]!=1 || v[1]!=1)) return RG_BAD_PAYLOAD;
    return xQueueSend(requestQueue,f,0)==pdTRUE?RG_DEFER:RG_BUSY;
}
bool RG_MCX_Init(void) {
    txQueue=xQueueCreate(1,sizeof(RG_MCX_Status));
    requestQueue=xQueueCreate(2,sizeof(RG_Frame));
    replyQueue=xQueueCreate(2,sizeof(RG_Reply));
    peerMutex=xSemaphoreCreateMutex();
    if (!txQueue||!requestQueue||!replyQueue||!peerMutex) return false;
    CLOCK_EnableClock(kCLOCK_PortE);
    /* PTE0 = LPUART1_TX, PTE1 = LPUART1_RX; ALT3. */
    PORTE->PCR[0]=PORT_PCR_MUX(3U);
    PORTE->PCR[1]=PORT_PCR_MUX(3U)|PORT_PCR_PE_MASK|PORT_PCR_PS_MASK;
    CLOCK_SetLpuart1Clock(1U); /* IRC48M, same source as debug LPUART0. */
    SIM->SOPT5 &= ~(SIM_SOPT5_LPUART1TXSRC_MASK|SIM_SOPT5_LPUART1RXSRC_MASK|SIM_SOPT5_LPUART1ODE_MASK);
    lpuart_config_t config;LPUART_GetDefaultConfig(&config);
    config.baudRate_Bps=115200;config.enableTx=true;config.enableRx=true;
    if (LPUART_Init(LPUART1,&config,CLOCK_GetFreq(kCLOCK_McgIrc48MClk))!=kStatus_Success) return false;
    NVIC_SetPriority(LPUART1_IRQn,(1U<<__NVIC_PRIO_BITS)-1U);
    /* Best-effort boot tag, plus uptime rollback detection in heartbeats.
     * Command replay protection is RAM scoped, not persistent across reset. */
    RG_LinkInit(&linkState,SIM->UIDL ^ SysTick->VAL ^ ADC0->R[0] ^ 0x52474d43U,
                NULL,sendFrame,receiveData,receiveRequest,NULL);
    return true;
}
bool RG_MCX_Publish(const RG_MCX_Status *s) {return xQueueOverwrite(txQueue,s)==pdTRUE;}
void RG_MCX_GetESP(RG_ESP_State *s) {
    uint32_t now=millisNow();
    xSemaphoreTake(peerMutex,portMAX_DELAY);*s=peer;xSemaphoreGive(peerMutex);
    s->climateValid=s->climateValid&&s->online&&(uint32_t)(now-s->climateAt)<15000;
    s->motionValid=s->motionValid&&s->online&&(uint32_t)(now-s->motionAt)<1500;
}
bool RG_MCX_TakeRequest(RG_Frame *f) {return xQueueReceive(requestQueue,f,0)==pdTRUE;}
bool RG_MCX_Reply(const RG_Frame *f,uint8_t result) {
    RG_Reply reply;reply.frame=*f;reply.result=result;
    return xQueueSend(replyQueue,&reply,0)==pdTRUE;
}
void RG_MCX_Task(void *unused) {
    (void)unused;uint32_t previousErrors=0;
    LPUART_EnableInterrupts(LPUART1,kLPUART_RxDataRegFullInterruptEnable);
    EnableIRQ(LPUART1_IRQn);
    for (;;) {
        uint32_t now=millisNow();
        if (hardwareErrors!=previousErrors) {
            taskENTER_CRITICAL();rxTail=rxHead;previousErrors=hardwareErrors;taskEXIT_CRITICAL();
            parser.used=0;
        }
        unsigned budget=RX_SIZE;
        while (rxTail!=rxHead && budget--) {
            uint8_t b=rx[rxTail];__DMB();rxTail=(uint16_t)((rxTail+1U)&(RX_SIZE-1U));
            RG_Frame f;
            if (RG_Feed(&parser,b,now,&f)) {
                rxFrames++;
                if (f.type=='H' && (f.session!=linkState.peerSession || !linkState.online ||
                    (linkState.haveHello && strlen(f.payload)==8 &&
                     (int32_t)((uint32_t)strtoul(f.payload,NULL,16)-linkState.peerUptime)<0))) {
                    xSemaphoreTake(peerMutex,portMAX_DELAY);
                    peer.climateValid=false;peer.motionValid=false;
                    xSemaphoreGive(peerMutex);
                    xQueueReset(requestQueue);
                    xQueueReset(replyQueue);
                }
                RG_Receive(&linkState,&f,now);
            }
        }
        RG_Reply reply;
        if (xQueueReceive(replyQueue,&reply,0)==pdTRUE) RG_Complete(&linkState,&reply.frame,reply.result);
        RG_Poll(&linkState,now);
        RG_MCX_Status s;
        if (xQueueReceive(txQueue,&s,0)==pdTRUE) {
            char p[RG_PAYLOAD_MAX+1];
            snprintf(p,sizeof(p),"%u,%u,%u,%lu,%u,%u,%u,%u,%u,%u,%u,%lu",
                s.doorValid,s.doorOpen,s.accessGranted,(unsigned long)s.accessRemainingMs,
                s.alarm,s.warningMask,s.warningValid,s.lightValid,s.lightRaw,s.lightPercent,
                s.exposureValid,(unsigned long)s.exposure);
            if (!RG_SendData(&linkState,'S',p)) txDropped++;
        }
        xSemaphoreTake(peerMutex,portMAX_DELAY);
        peer.online=linkState.online;
        peer.session=linkState.peerSession;
        if (!peer.online) {peer.climateValid=false;peer.motionValid=false;}
        peer.rxFrames=rxFrames;peer.parseErrors=parser.errors;
        peer.hardwareErrors=hardwareErrors;peer.txErrors=txErrors;peer.txDropped=txDropped;
        xSemaphoreGive(peerMutex);
        vTaskDelay(pdMS_TO_TICKS(5));
    }
}
