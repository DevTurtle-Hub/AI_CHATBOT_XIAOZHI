// =========================================================================
// ROBOT XIAOXI AI CLIENT - GOLD MASTER v6
// ESP32-S3-WROOM-1 N16R8 (16MB Flash + 8MB OPI PSRAM) + PROTOCOL V2
// =========================================================================
// KIẾN TRÚC:
//   1. Boot lần đầu (hoặc giữ nút BOOT khi cấp nguồn):
//      ESP32 phát Wi-Fi  "XiaoXi-Setup"  (không mật khẩu)
//      -> Điện thoại kết nối vào, chờ 3 giây: TRANG CẤU HÌNH tự bật lên
//         (hoặc mở trình duyệt gõ http://192.168.4.1)
//      -> Trên trang: chọn Wi-Fi nhà (list quét tự động), nhập mật khẩu,
//         nhập IP máy chạy server.js + Port -> bấm LƯU
//   2. ESP32 lưu cấu hình vào Flash (NVS), khởi động lại, kết nối đúng WiFi,
//      mở WebSocket tới server và chạy như bình thường.
//   3. Muốn đổi Wi-Fi/IP: mở http://IP-robot/reset hoặc giữ nút BOOT khi boot.
//      (Nhấn giữ BOOT 5 giây khi đang chạy cũng vào lại Setup)
//
// PHẦN CỨNG MẶC ĐỊNH ESP32-S3-WROOM-1 N16R8:
//   - I2C OLED SSD1306 128x64 : SDA=1, SCL=2, địa chỉ 0x3C
//   - TFT ILI9341 320x240 SPI: SCLK=12, MOSI=11, MISO=13, CS=4, DC=15, RST=9, BL=14
//   - Touch XPT2046           : CS=5 (dùng chung SPI với TFT: SCLK=12, MOSI=11, MISO=13)
//   - I2S Mic INMP441         : SCK=10, WS=8, SD=6   (I2S_NUM_1) [Dời khỏi 4, 5 để nhường cho TFT_CS & TOUCH_CS]
//   - I2S Loa MAX98357A       : BCLK=7, LRC=16, DIN=17 (I2S_NUM_0)
//   - Servo head=18, leg=21
//   - Nút BOOT=0, USB CDC native của S3
//
//   KHÔNG dùng các chân sau trên N16R8:
//     GPIO19/20 = USB-JTAG; GPIO26-32 = SPI flash; GPIO33-37 = OPI PSRAM;
//     GPIO43/44 = UART0; GPIO0/3/45/46 = strapping (chỉ dùng cẩn thận).
//
//   Code vẫn compile cho ESP32 DevKit cũ bằng env:esp32dev; khi đó tự dùng
//   pin legacy (32/33/25, 27/26/22, 12/14, 21/17, 19/23/18/15/2).
//
// THƯ VIỆN CẦN CÀI (Arduino IDE → Library Manager):
//   Adafruit SSD1306, Adafruit GFX, TFT_eSPI, ESP32Servo,
//   XPT2046_Touchscreen, WebSockets (by Markus Sabel / links2004)
//   (WebServer + DNSServer + Preferences có sẵn trong core ESP32)
// =========================================================================
// FIX lỗi "'FS' was not declared in this scope" (ESP32 core 3.x + TFT_eSPI):
// TFT_eSPI include FS.h với FS_NO_GLOBALS (khi bật SMOOTH_FONT) làm tắt alias
// global FS -> phải include FS.h SẠCH TRƯỚC TFT_eSPI như dưới đây.
#include <FS.h>       // PHẢI đứng trước TFT_eSPI.h!
#include <Arduino.h>  // để CONFIG_IDF_TARGET_ESP32S3 có sẵn trước #if

// =========================================================================
// 0. PIN MAP - TỰ CHỌN THEO CHIP
// =========================================================================
#if defined(CONFIG_IDF_TARGET_ESP32S3)
  #define XIAOXI_TARGET_S3 1
  #define XIAOXI_BOARD_NAME "ESP32-S3-WROOM-1 N16R8"

  #define PIN_I2C_SDA       1
  #define PIN_I2C_SCL       2

  #define PIN_TFT_MISO      13
  #define PIN_TFT_MOSI      11
  #define PIN_TFT_SCLK      12
  #define PIN_TFT_CS         4
  #define PIN_TFT_DC        15
  #define PIN_TFT_RST        9
  #define PIN_TFT_BL        14
  #define PIN_TOUCH_CS       5

  // Dời Mic sang GPIO 10 và GPIO 8 để tránh xung đột với TFT_CS (4) và TOUCH_CS (5)
  #define PIN_MIC_SCK       10
  #define PIN_MIC_WS         8
  #define PIN_MIC_SD         6

  #define PIN_AMP_BCLK       7
  #define PIN_AMP_LRC       16
  #define PIN_AMP_DIN       17

  #define PIN_SERVO_HEAD    18
  #define PIN_SERVO_LEG     21
  #define PIN_BOOT_BUTTON    0
#else
  #define XIAOXI_BOARD_NAME "ESP32 DevKit (legacy)"
  #define PIN_I2C_SDA       21
  #define PIN_I2C_SCL       17
  #define PIN_TFT_MISO      19
  #define PIN_TFT_MOSI      23
  #define PIN_TFT_SCLK      18
  #define PIN_TFT_CS        15
  #define PIN_TFT_DC         2
  #define PIN_TFT_RST       -1
  #define PIN_TOUCH_CS      13
  #define PIN_MIC_SCK       32
  #define PIN_MIC_WS        33
  #define PIN_MIC_SD        25
  #define PIN_AMP_BCLK      27
  #define PIN_AMP_LRC       26
  #define PIN_AMP_DIN       22
  #define PIN_SERVO_HEAD    12
  #define PIN_SERVO_LEG     14
  #define PIN_BOOT_BUTTON    0
#endif

// =========================================================================
// 0.1 TFT_eSPI SETUP
//     PlatformIO: cấu hình trong build_flags của platformio.ini.
//     Arduino IDE: cấu hình trong User_Setup.h của thư viện TFT_eSPI.
//     Không #define TFT_* ở đây để tránh lệch cấu hình giữa sketch và thư viện.
// =========================================================================
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <TFT_eSPI.h>
#include <ESP32Servo.h>
#include <XPT2046_Touchscreen.h>
#include <WiFi.h>
#include <WebServer.h>
#include <DNSServer.h>
#include <Preferences.h>
#include <WiFiUdp.h>
#include <WebSocketsClient.h>
#include <driver/i2s.h>
#include <esp_heap_caps.h>
#include "freertos/queue.h"

// =========================================================================
// 0. CẤU HÌNH HỆ THỐNG (không cần sửa WiFi/IP ở đây nữa!)
// =========================================================================
const char *AP_SSID    = "XiaoXi-Setup";   // Wi-Fi phát ra cho điện thoại ghép
const uint32_t AP_PASS = -1;               // (mở - không cần mật khẩu)
const uint16_t AP_TIMEOUT_MIN = 8;         // tự thoát Setup sau 8 phút nếu bỏ quên

// IPv4 auto-discovery: server.js phát UDP broadcast mỗi 3 giây -> ESP32 bắt
// và tự lưu IP. Nhờ vậy trên trang cấu hình anh có thể BỎ TRỐNG IP.
const uint16_t UDP_DISCOVERY_PORT = 34567;
const char *UDP_DISCOVERY_MAGIC = "XIAOXI_DISCOVERY";
const char *UDP_ROBOT_REPLY     = "XIAOXI_ROBOT";

Preferences prefs;      // lưu WiFi + IP server vào flash
WebServer portal(80);   // captive portal web server 192.168.4.1
DNSServer dnsServer;
WiFiUDP udpDiscovery;   // nghe UDP broadcast để tự tìm IP server

// Cấu hình runtime nạp từ flash
String cfgSSID = "";
String cfgPass = "";
String cfgSrvIP = "";
uint16_t cfgSrvPort = 8765;
bool cfgLoaded = false;
unsigned long lastDiscoveryReplyAt = 0;   // chống spam reply UDP

// =========================================================================
// 1. DISPLAY HARDWARE
// =========================================================================
#define OLED_WIDTH 128
#define OLED_HEIGHT 64
Adafruit_SSD1306 display(OLED_WIDTH, OLED_HEIGHT, &Wire, -1);
bool oledOk = false;
TFT_eSPI tft = TFT_eSPI();

// XPT2046 dùng chung bus SPI với TFT; CS riêng để không đụng OLED I2C.
// Mặc định ENABLE_TOUCH 0 nếu chưa cắm 5 dây cảm ứng để tránh xung đột SPI làm treo màn hình.
#define ENABLE_TOUCH 0

#if ENABLE_TOUCH
#ifndef TOUCH_CS
#define TOUCH_CS PIN_TOUCH_CS
#endif
XPT2046_Touchscreen touch(TOUCH_CS);   // polled mode (không dùng IRQ)
#endif

// =========================================================================
// 2. SERVO CONFIG - CẢ HAI ĐỀU LÀ SERVO QUAY LIÊN TỤC (continuous-rotation)
//   head (GPIO18 trên S3): nhịp nhanh | leg (GPIO21 trên S3): quay chậm
// =========================================================================
Servo headServo;   // quay liên tục (đã cân)
Servo legServo;    // quay liên tục (mô hình giống head)
const int HEAD_PIN = PIN_SERVO_HEAD;
const int LEG_PIN  = PIN_SERVO_LEG;

const int STOP_VALUE  = 94;   // điểm dừng (0 tốc độ) - dùng chung 2 servo
const int SPEED_DIFF  = 10;   // tốc độ nhịp nhanh của chân 12 (đã cân)
const int LEFT_MS     = 135; // thời gian 1 nhịp nhanh trái
const int RIGHT_MS    = 145; // bù lệch cơ khí nhịp nhanh phải
const int SETTLE_MS   = 150;  // nghỉ cho servo dừng hẳn giữa các nhịp
const int MAX_STEPS   = 3;    // tối đa lệch bao nhiêu nhịp mỗi bên

// Chân 14: XOAY CHẬM - đẩy tín hiệu tốc độ gần điểm dừng, chạy ĐỀU LIÊN TỤC
// (không tăng từng độ nên servo êm; thời gian quyết định góc quay)
const int LEG_SLOW_DIFF = 4;       // tốc độ chậm (STOP±4). Không quay? tăng 5-6
const int LEG_SLOW_L_MS = 450;     // 1 "hiệp" quay chậm trái
const int LEG_SLOW_R_MS = 480;     // bù lệch cơ khí bên phải
const int LEG_MAX_STEPS = 3;       // tối đa 3 hiệp mỗi bên (đối xứng chân 12)

// =========================================================================
// 2.1 MÔ HÌNH SERVO Hiện đại: queue + FreeRTOS task, KHÔNG bao giờ delay
//     trong luồng chính -> WS/audio/màn hình luôn mượt
// =========================================================================
enum ServoWhich : uint8_t { SERVO_HEAD, SERVO_LEG };

struct ServoMove {
    ServoWhich which;
    int8_t a;   // head: -1 down / +1 up / 0 center | leg: -1 trái / +1 phải / 0 giữa
};

struct ServoCalib {
    Servo *servo;
    int stopVal;
    int speedDiff;                 // tốc độ nhịp nhanh
    int leftMs, rightMs;           // ms một nhịp nhanh
    int settleMs;
    int slowDiff;                  // tốc độ quay chậm
    int slowLeftMs, slowRightMs;   // ms một hiệp quay chậm
    int maxSteps;
    int pos;                       // vị trí hiện tại (số nhịp lệch)
};

ServoCalib headCal = { &headServo, STOP_VALUE, SPEED_DIFF, LEFT_MS, RIGHT_MS,
                       SETTLE_MS, SPEED_DIFF, LEFT_MS, RIGHT_MS, MAX_STEPS, 0 };
ServoCalib legCal  = { &legServo,  STOP_VALUE, SPEED_DIFF, LEFT_MS, RIGHT_MS,
                       SETTLE_MS, LEG_SLOW_DIFF, LEG_SLOW_L_MS, LEG_SLOW_R_MS, LEG_MAX_STEPS, 0 };

int headPos = 0;   // giữ tên cũ cho phần điều khiển head
int legPos  = 0;

QueueHandle_t servoQueue;
const int SERVO_QUEUE_MAX = 16;

// =========================================================================
// 3. I2S MICRO INMP441 (S3: SCK=4, WS=5, SD=6 | legacy: 32/33/25)
// =========================================================================
#define I2S_MIC_PORT        I2S_NUM_1
#define I2S_MIC_SCK         PIN_MIC_SCK
#define I2S_MIC_WS          PIN_MIC_WS
#define I2S_MIC_SD          PIN_MIC_SD
#define MIC_SAMPLE_RATE     16000
#define MIC_CHUNK_SAMPLES   256       // 16ms mỗi frame

// =========================================================================
// 4. I2S LOA MAX98357A (S3: BCLK=7, LRC=16, DIN=17 | legacy: 27/26/22)
// =========================================================================
#define I2S_AMP_PORT        I2S_NUM_0
#define I2S_AMP_BCLK        PIN_AMP_BCLK
#define I2S_AMP_LRC         PIN_AMP_LRC
#define I2S_AMP_DIN         PIN_AMP_DIN
#define AMP_SAMPLE_RATE     16000

// Hai core: audio dồn về core 0, UI/network/servo ở core 1 trên S3.
#if defined(XIAOXI_TARGET_S3)
  #define MIC_TASK_CORE      0
  #define SPEAKER_TASK_CORE  0
  #define SERVO_TASK_CORE    1
#else
  #define MIC_TASK_CORE      1
  #define SPEAKER_TASK_CORE  0
  #define SERVO_TASK_CORE    1
#endif

// =========================================================================
// 5. UI STATE
// =========================================================================
enum Page { MAIN_PAGE, SETTING_PAGE };
Page currentPage = MAIN_PAGE;

enum ScreenMode {
    SCREEN_DISCONNECTED,
    SCREEN_READY,
    SCREEN_USER,
    SCREEN_AI,
    SCREEN_SETTING,
    SCREEN_MUSIC
};
ScreenMode currentScreen = SCREEN_DISCONNECTED;
unsigned long returnToReadyAt = 0;

QueueHandle_t cmdQueue;
const int CMD_QUEUE_MAX = 16;
// Queue chứa char[] raw (an toàn RAM hơn String); 1 lệnh tối đa 383 ký tự (chứa trọn câu trả lời)
const size_t CMD_MSG_LEN = 384;

String currentFace = "__FACE_HAPPY__";
unsigned long lastBlinkTime = 0;
unsigned long lastEyeMoveTime = 0;

// ===================== [TFT PRO] MÀN HÌNH SỐNG =====================
// Chat bubbles + music player + đồng hồ/thời tiết (server gửi __TIME__/__WX__)
#define CHAT_MAX 6
String chatTxt[CHAT_MAX];
uint8_t chatKind[CHAT_MAX];   // 0 = AI, 1 = User
uint8_t chatLen = 0;          // số bong bóng hợp lệ trong mảng

String tftClockLine = "";     // "18:24"
String tftClockDow = "";      // "CN"
String tftWxLine = "";        // "25C tro nang 70%"

String musicTitle = "";
String musicPosStr = "", musicDurStr = "";
int    musicDurS = 0;
float  musicPosPct = 0;

#define BOOT_BUTTON_PIN PIN_BOOT_BUTTON

// =========================================================================
// 6. AUDIO RING STATE
// =========================================================================
// Trên S3 N16R8: ring 512KB nằm trong PSRAM (16s @ PCM 16k mono).
// Fallback ESP32 legacy: 64KB trong SRAM để tương thích firmware cũ.
static uint8_t *speakerBuffer = NULL;
static size_t speakerBufferSize = 0;
static bool speakerBufferInPsram = false;
volatile size_t speakerWriteIdx = 0;
volatile size_t speakerReadIdx  = 0;
volatile uint32_t speakerDropTotal = 0;   // tổng bytes bị NPCs (debug baum)
SemaphoreHandle_t speakerMutex = NULL;
bool ttsPlaying = false;
bool micPausedByServer = false;
volatile unsigned long micWindowEndMs = 0;   // >0: đang mở "cửa sổ nghe lệnh" (nhạc đang phát)

// =========================================================================
// 7. NETWORK STATE
// =========================================================================
WebSocketsClient webSocket;
bool wsConnected = false;
bool wifiConnected = false;
String serverStatusText = "Cho ket noi";

// Protocol v2 (JSON) - bat sau khi server tra hello_ack; legacy van hoat dong
bool protocolV2 = false;
String deviceId = "";
String protocolState = "IDLE";
String deviceSessionId = "";
bool musicPlaying = false;
unsigned long ignoreAudioUntil = 0;
unsigned long lastMetricsAt = 0;

// =========================================================================
// 8. FORWARD DECLARATIONS
// =========================================================================
void drawEyes(String emotion);
void drawMainPage(String text);
void drawSettingPage();
void handleTouch();
void showDisconnectedUI(const String &reason = "");
void showReadyUI();
void showUserSpeechUI(const String &text);
void showAIReplyUI(const String &reply);
void drawReadyAmbient();
void renderChatFrame(const char *heading, uint16_t accent);
void showMusicUI();
void drawMusicProgress();
void drawWrappedText(const String &text, int x, int y, int maxWidth, int maxLines, uint16_t color, uint8_t size = 2);
void executeHeadMove(int dir);
void executeLegMove(int pos);
static void servoTask(void *param);
void onWebSocketEvent(WStype_t type, uint8_t *payload, size_t length);
void handleProtocolMessage(const String &msg);
void sendProtocolHello();
void sendProtocolMetrics();
void sendBargeIn(const char *reason);
void flushSpeakerRing();
void speakerTask(void *param);
void micTask(void *param);
void networkLoop();
bool loadConfig();
bool tryConnectWiFi(uint32_t timeoutMs);
void runSetupPortal(bool allowExit);

// =========================================================================
// 9. SERVO DRIVER (FreeRTOS - non-blocking - luồng chính không bao giờ bị chặn)
//    - Mọi lệnh vào queue, servoTask xử lý tuần tự => WS/audio/OLED luôn mượt
//    - CHÂN 12: nhịp NHANH đã cân (giữ nguyên hiệu chuẩn cũ, HEAD)
//    - CHÂN 14: XOAY CHẬM - tốc độ STOP±4 chạy ĐỀU LIÊN TỤC, tăng/giảm tốc mềm
//      (không nhảy từng độ nên servo êm; thời gian quyết định góc quay)
// =========================================================================

// 1 hiệp XOAY CHẬM: tăng tốc dần - chạy đều chậm - giảm dần - dừng giữ tín hiệu
static void servoSlowTurn(ServoCalib &c, int dir) {
    const int rampSteps = 3;                              // số mức tăng/giảm tốc
    const int rampUnit  = (c.slowDiff > rampSteps) ? (c.slowDiff / rampSteps) : 1;
    const int rampMs    = (dir < 0 ? c.slowLeftMs : c.slowRightMs) / 6;
    const int runMs     = (dir < 0 ? c.slowLeftMs : c.slowRightMs);

    // Tăng dần tốc độ (chống giật khi khởi động)
    for (int s = 1; s <= rampSteps; s++) {
        c.servo->write(c.stopVal + (dir < 0 ? -s : s) * rampUnit);
        vTaskDelay(pdMS_TO_TICKS(rampMs));
    }
    // Chạy ĐỀU với tốc độ chậm chính xác
    c.servo->write(c.stopVal + (dir < 0 ? -c.slowDiff : c.slowDiff));
    vTaskDelay(pdMS_TO_TICKS(runMs));
    // Giảm dần tốc độ (chống dội khi phanh)
    for (int s = rampSteps; s >= 1; s--) {
        c.servo->write(c.stopVal + (dir < 0 ? -s : s) * rampUnit);
        vTaskDelay(pdMS_TO_TICKS(rampMs));
    }
    // Dừng hẳn, giữ tín hiệu dừng liên tục
    c.servo->write(c.stopVal);
    vTaskDelay(pdMS_TO_TICKS(c.settleMs));
}

void executeHeadMove(int dir) {
    ServoMove m = { SERVO_HEAD, (int8_t)(dir > 0 ? 1 : (dir < 0 ? -1 : 0)) };
    xQueueSend(servoQueue, &m, 0);
}

void executeLegMove(int pos) {
    // Mapping cũ giữ nguyên: 0 = trái, 1 = giữa, 2 = phải
    int8_t a = (pos == 0) ? -1 : (pos == 2) ? 1 : 0;
    ServoMove m = { SERVO_LEG, a };
    xQueueSend(servoQueue, &m, 0);
}

static void servoTask(void *param) {
    ServoMove m;
    for ( ;; ) {
        if (xQueueReceive(servoQueue, &m, pdMS_TO_TICKS(100)) != pdTRUE) continue;

        if (m.which == SERVO_HEAD) {
            ServoCalib &c = headCal;
            if (m.a == 1 && headPos < c.maxSteps) {
                c.servo->write(c.stopVal + c.speedDiff);          // nhịp nhanh phải
                vTaskDelay(pdMS_TO_TICKS(c.rightMs));
                headPos++;
            } else if (m.a == -1 && headPos > -c.maxSteps) {
                c.servo->write(c.stopVal - c.speedDiff);          // nhịp nhanh trái
                vTaskDelay(pdMS_TO_TICKS(c.leftMs));
                headPos--;
            } else if (m.a == 0) {
                int guard = 0;                                    // về giữa, từng nhịp
                while (headPos != 0 && guard++ < 2 * c.maxSteps + 2) {
                    c.servo->write(headPos > 0 ? c.stopVal - c.speedDiff
                                               : c.stopVal + c.speedDiff);
                    vTaskDelay(pdMS_TO_TICKS(headPos > 0 ? c.leftMs : c.rightMs));
                    headPos += (headPos > 0) ? -1 : 1;
                    c.servo->write(c.stopVal);
                    vTaskDelay(pdMS_TO_TICKS(c.settleMs));
                }
            }
            c.servo->write(c.stopVal);
            vTaskDelay(pdMS_TO_TICKS(c.settleMs));
            Serial.printf("[SERVO] HEAD move=%d pos=%d\n", m.a, headPos);
        } else {
            ServoCalib &c = legCal;
            if (m.a == 1 && legPos < c.maxSteps) {
                servoSlowTurn(c, 1);                              // XOAY CHẬM phải
                legPos++;
            } else if (m.a == -1 && legPos > -c.maxSteps) {
                servoSlowTurn(c, -1);                             // XOAY CHẬM trái
                legPos--;
            } else if (m.a == 0) {
                int guard = 0;                                    // về giữa, từng hiệp chậm
                while (legPos != 0 && guard++ < 2 * c.maxSteps + 2) {
                    servoSlowTurn(c, (legPos > 0) ? -1 : 1);
                    legPos += (legPos > 0) ? -1 : 1;
                }
            }
            c.servo->write(c.stopVal);
            Serial.printf("[SERVO] LEG move=%d pos=%d\n", m.a, legPos);
        }
    }
}

// =========================================================================
// 10. FACE
// =========================================================================
void drawEyes(String emotion) {
    if (!oledOk) { currentFace = emotion; return; }
    display.clearDisplay();
    if (emotion == "__FACE_HAPPY__") {
        display.fillRoundRect(30, 20, 20, 10, 5, SSD1306_WHITE);
        display.fillRoundRect(80, 20, 20, 10, 5, SSD1306_WHITE);
    } else if (emotion == "__FACE_SAD__") {
        display.fillRect(30, 30, 20, 4, SSD1306_WHITE);
        display.fillRect(80, 30, 20, 4, SSD1306_WHITE);
    } else if (emotion == "__FACE_LISTEN__") {
        display.fillCircle(40, 32, 12, SSD1306_WHITE);
        display.fillCircle(90, 32, 12, SSD1306_WHITE);
    } else if (emotion == "__FACE_THINK__") {
        display.fillCircle(40, 32, 10, SSD1306_WHITE);
        display.fillCircle(90, 32, 5, SSD1306_WHITE);
    } else if (emotion == "__FACE_ANGRY__") {
        // Lông mày nghiêng vào trong (giận) + mắt thu nhỏ
        display.drawLine(28, 18, 48, 24, SSD1306_WHITE);
        display.drawLine(48, 18, 28, 24, SSD1306_WHITE);
        display.drawLine(80, 24, 100, 18, SSD1306_WHITE);
        display.drawLine(80, 18, 100, 24, SSD1306_WHITE);
        display.fillCircle(38, 34, 7, SSD1306_WHITE);
        display.fillCircle(90, 34, 7, SSD1306_WHITE);
    } else if (emotion == "__FACE_LOVE__") {
        // Hai trái tim (yêu thương)
        display.fillCircle(32, 24, 7, SSD1306_WHITE);
        display.fillCircle(46, 24, 7, SSD1306_WHITE);
        display.fillTriangle(25, 29, 53, 29, 39, 46, SSD1306_WHITE);
        display.fillCircle(82, 24, 7, SSD1306_WHITE);
        display.fillCircle(96, 24, 7, SSD1306_WHITE);
        display.fillTriangle(75, 29, 103, 29, 89, 46, SSD1306_WHITE);
    } else {
        display.fillRoundRect(30, 25, 20, 15, 4, SSD1306_WHITE);
        display.fillRoundRect(80, 25, 20, 15, 4, SSD1306_WHITE);
    }
    display.display();
    currentFace = emotion;
}

// =========================================================================
// 10.1 TFT MODERN UI ENGINE (SAD/HAPPY ICONS, CHAT BUBBLES, WRAPPED TEXT)
// =========================================================================

void drawSadFaceIcon(int cx, int cy, int r, uint16_t color) {
    tft.fillCircle(cx, cy, r, 0x18C3);       // Nền xám đen sâu
    tft.drawCircle(cx, cy, r, color);        // Viền ngoài
    tft.drawCircle(cx, cy, r - 1, color);

    // Hai mắt buồn (mắt chấm tròn có mí cụp)
    int ex = r * 0.38;
    int ey = r * 0.22;
    tft.fillCircle(cx - ex, cy - ey, 3, color);
    tft.fillCircle(cx + ex, cy - ey, 3, color);
    // Chân mày buồn (úp chéo ra ngoài)
    tft.drawLine(cx - ex - 6, cy - ey - 5, cx - ex + 4, cy - ey - 2, color);
    tft.drawLine(cx - ex - 6, cy - ey - 6, cx - ex + 4, cy - ey - 3, color);
    tft.drawLine(cx + ex + 6, cy - ey - 5, cx + ex - 4, cy - ey - 2, color);
    tft.drawLine(cx + ex + 6, cy - ey - 6, cx + ex - 4, cy - ey - 3, color);

    // Miệng mếu buồn (vòm cong úp xuống: giữa cao hơn mép)
    int mw = r * 0.45;
    int my = cy + r * 0.45;
    for (int i = -mw; i <= mw; i++) {
        int dy = -(int)((1.0f - (float)(i * i) / (mw * mw)) * (r * 0.32f));
        tft.drawPixel(cx + i, my + dy, color);
        tft.drawPixel(cx + i, my + dy + 1, color);
    }
}

void drawHappyFaceIcon(int cx, int cy, int r, uint16_t color) {
    tft.fillCircle(cx, cy, r, 0x0183);       // Nền xanh ngọc đậm
    tft.drawCircle(cx, cy, r, color);
    tft.drawCircle(cx, cy, r - 1, color);

    // Hai mắt cười cong lên
    int ex = r * 0.38;
    int ey = r * 0.22;
    for (int i = -5; i <= 5; i++) {
        int dy = -(int)((1.0f - (float)(i * i) / 25.0f) * 3);
        tft.drawPixel(cx - ex + i, cy - ey + dy, color);
        tft.drawPixel(cx - ex + i, cy - ey + dy + 1, color);
        tft.drawPixel(cx + ex + i, cy - ey + dy, color);
        tft.drawPixel(cx + ex + i, cy - ey + dy + 1, color);
    }

    // Miệng cười tươi (vòm cong trũng xuống: giữa thấp hơn mép)
    int mw = r * 0.42;
    int my = cy + r * 0.15;
    for (int i = -mw; i <= mw; i++) {
        int dy = (int)((1.0f - (float)(i * i) / (mw * mw)) * (r * 0.30f));
        tft.drawPixel(cx + i, my + dy, color);
        tft.drawPixel(cx + i, my + dy + 1, color);
    }
}

void drawWrappedText(const String &text, int x, int y, int maxWidth, int maxLines, uint16_t color, uint8_t size) {
    tft.setTextColor(color);
    tft.setTextSize(size);
    tft.setTextDatum(TL_DATUM);
    int charWidth = 6 * size;
    int lineHeight = 8 * size + 4;
    int maxCharsPerLine = maxWidth / charWidth;

    int start = 0;
    int line = 0;
    int len = text.length();

    while (start < len && line < maxLines) {
        int end = start + maxCharsPerLine;
        if (end >= len) {
            end = len;
        } else {
            int space = text.lastIndexOf(' ', end);
            if (space > start) end = space;
        }
        String sub = text.substring(start, end);
        sub.trim();
        tft.drawString(sub, x, y + line * lineHeight);
        start = (end < len && text.charAt(end) == ' ') ? end + 1 : end;
        line++;
    }
}

// ==== [TFT PRO] hàm dựng mànchat/ nhạc/ ambient ====
uint16_t moodColorTft() {
    if (currentFace == "__FACE_SAD__") return 0x31A6;
    if (currentFace == "__FACE_ANGRY__") return TFT_RED;
    if (currentFace == "__FACE_LOVE__") return 0xFD20;
    if (currentFace == "__FACE_SURPRISE__") return TFT_YELLOW;
    return TFT_CYAN;
}

void addChatBubble(const String &text, bool isUser) {
    int idx;
    if (chatLen < CHAT_MAX) {
        idx = chatLen++;
    } else {
        for (int i = 1; i < CHAT_MAX; i++) { chatTxt[i - 1] = chatTxt[i]; chatKind[i - 1] = chatKind[i]; }
        idx = CHAT_MAX - 1;
    }
    chatTxt[idx] = text;
    chatKind[idx] = isUser ? 1 : 0;
}

// Vẽ khung hội thoại: heading nhỏ hàng đầu + các bubble xếp từ dưới lên
// (User bên phải nền cam; AI bên trái nền teal, viền màu theo mood hiện tại)
void renderChatFrame(const char *heading, uint16_t accent) {
    tft.fillScreen(TFT_BLACK);
    showTopStatusBar();
    tft.setTextDatum(TL_DATUM);
    tft.setTextColor(accent);
    tft.setTextSize(2);
    tft.drawString(heading, 16, 28);
    tft.drawFastHLine(0, 48, 320, accent);

    int yBottom = 216;
    for (int i = (int)chatLen - 1; i >= 0 && yBottom > 54; i--) {
        String txt = chatTxt[i];
        uint8_t size = (txt.length() > 64) ? 1 : 2;
        int charW = 6 * size;
        int lineH = 8 * size + 4;
        int maxW = chatKind[i] ? 210 : 232;
        int perLine = maxW / charW;
        int countLines = (txt.length() + perLine - 1) / perLine;
        if (countLines < 1) countLines = 1;
        if (countLines > 4) countLines = 4;
        int h = countLines * lineH + 10;
        int w = perLine * charW + 14;
        int y = yBottom - h;
        if (y < 52) break;
        int x = chatKind[i] ? (312 - w) : 14;
        uint16_t bg = chatKind[i] ? 0x10A2 : 0x0622;
        tft.fillRoundRect(x, y, w, h, 6, bg);
        if (!chatKind[i]) tft.drawRoundRect(x, y, w, h, 6, moodColorTft());
        drawWrappedText(txt, x + 7, y + 5, perLine * charW, countLines, TFT_WHITE, size);
        yBottom = y - 6;
    }
}

// Đồng hồ + thời tiết trên màn Sẵn sàng (tô đè 1 dòng nhỏ phía dưới mặt cười)
void drawReadyAmbient() {
    if (currentScreen != SCREEN_READY) return;
    tft.fillRect(50, 110, 220, 12, TFT_BLACK);
    String line = "";
    if (tftClockLine.length()) line = tftClockLine + (tftClockDow.length() ? " " + tftClockDow : "");
    if (tftWxLine.length()) line += (line.length() ? " | " : "") + tftWxLine;
    if (line.length()) {
        tft.setTextDatum(MC_DATUM);
        tft.setTextColor(0xFDA0);
        tft.setTextSize(1);
        tft.drawString(line, 160, 116);
    }
}

// Tiến trình bài nhạc: thanh bar + 2 nhãn thời gian pos/dur
void drawMusicProgress() {
    tft.fillRoundRect(26, 148, 268, 12, 6, 0x2104);
    tft.drawRoundRect(26, 148, 268, 12, 6, 0x45FD);
    int filled = (int)(musicPosPct * 266.0f / 100.0f);
    if (filled > 0) tft.fillRoundRect(28, 150, filled > 260 ? 260 : filled, 8, 4, TFT_GREENYELLOW);
    tft.setTextDatum(MC_DATUM);
    tft.setTextColor(TFT_CYAN);
    tft.setTextSize(2);
    tft.drawString(musicPosStr.length() ? musicPosStr : "0:00", 78, 176);
    tft.setTextColor(TFT_LIGHTGREY);
    tft.drawString(musicDurStr.length() ? ("/" + musicDurStr) : "-:--", 246, 176);
}

// Màn hình đang phát nhạc: tên bài + bar tiến trình + gợi ý lệnh giọng
void showMusicUI() {
    currentScreen = SCREEN_MUSIC;
    musicPosStr = ""; musicDurStr = ""; musicPosPct = 0;
    tft.fillScreen(TFT_BLACK);
    showTopStatusBar();
    tft.fillRoundRect(10, 30, 300, 192, 10, 0x1904);
    tft.drawRoundRect(10, 30, 300, 192, 10, 0x45FD);

    tft.setTextDatum(TC_DATUM);
    tft.setTextColor(TFT_CYAN);
    tft.setTextSize(2);
    tft.drawString("DANG PHAT NHAC", 160, 42);

    // Tên bài: đếm lại vùng viết mới sạch -> wrap tối đa 3 dòng size1
    uint8_t size = (musicTitle.length() > 44) ? 1 : 2;
    int charW = 6 * size, lineH = 8 * size + 4;
    int perLine = 278 / charW;
    int countLines = (musicTitle.length() + perLine - 1) / perLine;
    if (countLines < 1) countLines = 1;
    if (countLines > 3) countLines = 3;
    int titleY = 92 - countLines * lineH / 2;
    drawWrappedText(musicTitle, 22, titleY, perLine * charW, countLines, TFT_WHITE, size);

    // Nốt nhạc chấm bên trái
    tft.fillCircle(30, 44, 4, TFT_GREENYELLOW);
    tft.fillRect(34, 24, 2, 20, TFT_GREENYELLOW);

    drawMusicProgress();

    tft.setTextDatum(MC_DATUM);
    tft.setTextColor(TFT_GREENYELLOW);
    tft.setTextSize(1);
    tft.drawString("Noi: 'tam dung' 'tiep tuc' 'bai khac' 'tat nhac'", 160, 204);
}

void showTopStatusBar() {
    tft.fillRect(0, 0, 320, 24, 0x08A3);
    tft.fillCircle(12, 12, 4, TFT_GREEN);
    tft.setTextDatum(TL_DATUM);
    tft.setTextColor(TFT_WHITE);
    tft.setTextSize(1);
    tft.drawString("XIAOXI AI ROBOT", 22, 8);

    tft.setTextDatum(TR_DATUM);
    tft.setTextColor(TFT_CYAN);
    String ipStr = (WiFi.status() == WL_CONNECTED) ? WiFi.localIP().toString() : "No Wi-Fi";
    tft.drawString(ipStr, 312, 8);
    tft.drawFastHLine(0, 24, 320, 0x1966);
}

void showDisconnectedUI(const String &reason) {
    currentScreen = SCREEN_DISCONNECTED;
    tft.fillScreen(TFT_BLACK);

    bool isWifiLost = (WiFi.status() != WL_CONNECTED);

    if (isWifiLost) {
        // --- 1. MẤT KẾT NỐI WIFI ---
        tft.drawRoundRect(8, 8, 304, 224, 8, TFT_RED);
        drawSadFaceIcon(160, 48, 26, TFT_RED);

        tft.setTextDatum(MC_DATUM);
        tft.setTextColor(TFT_RED);
        tft.setTextSize(2);
        tft.drawString("MAT KET NOI WI-FI!", 160, 90);

        tft.setTextDatum(TL_DATUM);
        tft.fillRoundRect(18, 108, 284, 114, 6, 0x1000); // Khung nền đỏ tối
        tft.drawRoundRect(18, 108, 284, 114, 6, 0x8000);

        tft.setTextSize(1);
        tft.setTextColor(TFT_WHITE);
        tft.drawString("1. Tinh trang: Khong ket noi duoc Wi-Fi", 26, 118);

        tft.setTextColor(TFT_YELLOW);
        String ssidShow = "2. Wi-Fi nha: " + (cfgSSID.length() ? cfgSSID : "<Chua cai dat>");
        tft.drawString(ssidShow, 26, 138);

        tft.setTextColor(TFT_CYAN);
        tft.drawString("3. Dang tu dong thu ket noi lai...", 26, 158);

        tft.setTextColor(TFT_LIGHTGREY);
        tft.drawString("-> Neu doi Wi-Fi: Giu nut BOOT 5 giay", 26, 182);
        tft.drawString("   hoac khoi dong lai de cai qua phone", 26, 198);
    } else {
        // --- 2. CÓ WIFI NHƯNG MẤT KẾT NỐI SERVER ---
        tft.drawRoundRect(8, 8, 304, 224, 8, TFT_ORANGE);
        drawSadFaceIcon(160, 48, 26, TFT_ORANGE);

        tft.setTextDatum(MC_DATUM);
        tft.setTextColor(TFT_ORANGE);
        tft.setTextSize(2);
        tft.drawString("MAT KET NOI SERVER!", 160, 90);

        tft.setTextDatum(TL_DATUM);
        tft.fillRoundRect(18, 108, 284, 114, 6, 0x1860); // Khung nền cam tối
        tft.drawRoundRect(18, 108, 284, 114, 6, 0xB340);

        tft.setTextSize(1);
        tft.setTextColor(TFT_GREEN);
        tft.drawString("1. Wi-Fi: DA KET NOI", 26, 116);

        tft.setTextColor(TFT_WHITE);
        tft.drawString("   IP Robot: " + WiFi.localIP().toString(), 26, 132);

        tft.setTextColor(TFT_RED);
        String srvShow = "2. Server: CHUA BAT (" + (cfgSrvIP.length() ? cfgSrvIP : "Tu tim UDP") + ":" + String(cfgSrvPort) + ")";
        tft.drawString(srvShow, 26, 152);

        tft.setTextColor(TFT_YELLOW);
        tft.drawString("3. Hay mo file 'run_xiaoxi.bat' tren may tinh!", 26, 172);

        tft.setTextColor(TFT_CYAN);
        tft.drawString("-> Robot dang tu dong quet tim lai server...", 26, 194);
    }
}

void showReadyUI() {
    currentScreen = SCREEN_READY;
    chatLen = 0; // bắt đầu cuộc trò chuyện mới
    musicTitle = ""; musicPosStr = ""; musicDurStr = ""; musicPosPct = 0;
    tft.fillScreen(TFT_BLACK);
    showTopStatusBar();

    // Khung Card sẵn sàng
    tft.drawRoundRect(12, 34, 296, 196, 10, 0x21E8);
    drawHappyFaceIcon(160, 85, 26, TFT_CYAN);

    tft.setTextDatum(MC_DATUM);
    tft.setTextColor(TFT_CYAN);
    tft.setTextSize(2);
    tft.drawString("SAN SANG LANG NGHE", 160, 132);

    tft.setTextColor(TFT_WHITE);
    tft.setTextSize(1);
    tft.drawString("Hay noi: 'XiaoXi oi' hoac hoi bat ky dieu gi", 160, 162);

    tft.setTextColor(TFT_GREEN);
    tft.drawString("Micro INMP441 san sang | Thu ro xa 1m", 160, 185);

    tft.setTextColor(TFT_LIGHTGREY);
    tft.drawString("Cham man hinh de mo Menu Cai Dat", 160, 208);
    drawReadyAmbient();
}

void showUserSpeechUI(const String &text) {
    addChatBubble(text, true);
    currentScreen = SCREEN_USER;
    renderChatFrame("BAN VUA NOI", TFT_ORANGE);
}

void showAIReplyUI(const String &reply) {
    addChatBubble(reply, false);
    currentScreen = SCREEN_AI;
    renderChatFrame("XIAOXI TRA LOI", moodColorTft());
}

void drawMainPage(String text) {
    if (!wsConnected || WiFi.status() != WL_CONNECTED) {
        showDisconnectedUI(text);
        return;
    }
    if (text == "San sang!" || text == "San sang") {
        showReadyUI();
    } else {
        showAIReplyUI(text);
    }
}

void drawSettingPage() {
    currentScreen = SCREEN_SETTING;
    tft.fillScreen(TFT_BLACK);
    tft.setTextColor(TFT_YELLOW);
    tft.setTextDatum(MC_DATUM);
    tft.setTextSize(2);
    tft.drawString("CAI DAT ROBOT", 160, 30);
    tft.drawRoundRect(20, 60, 280, 40, 5, TFT_WHITE);
    tft.drawString("1. Dat lai vi tri 0", 160, 80);
    tft.drawRoundRect(20, 110, 280, 40, 5, TFT_WHITE);
    tft.drawString("2. Kiem tra Servo", 160, 130);
    tft.drawRoundRect(20, 160, 280, 40, 5, TFT_WHITE);
    tft.drawString("QUAY VE", 160, 180);
}

void handleTouch() {
#if ENABLE_TOUCH
    if (touch.touched()) {
        // Cham man hinh khi XiaoXi dang noi = ngat loi ngay (barge-in).
        // Khong ap dung khi dang phat nhac de khong vo tinh cat bai.
        if ((ttsPlaying || protocolState == "SPEAK") && !musicPlaying) {
            flushSpeakerRing();
            sendBargeIn("touch");
            delay(250);
            return;
        }

        TS_Point p = touch.getPoint();
        int x = map(p.x, 200, 3700, 0, 320);
        int y = map(p.y, 240, 3800, 0, 240);
        if (currentPage == MAIN_PAGE) {
            currentPage = SETTING_PAGE;
            drawSettingPage();
        } else {
            if (y > 60 && y < 100) { executeHeadMove(0); executeLegMove(1); }
            else if (y > 110 && y < 150) {
                // Kiểm tra servo đầu: nhịp lên rồi xuống
                executeHeadMove(1);
                executeHeadMove(-1);
            }
            else if (y > 160 && y < 200) {
                currentPage = MAIN_PAGE;
                if (!wsConnected || WiFi.status() != WL_CONNECTED) showDisconnectedUI();
                else showReadyUI();
            }
        }
        delay(300);
    }
#endif
}

// =========================================================================
// 11. NVS CONFIG (WiFi + IP server)
// =========================================================================
bool loadConfig() {
    prefs.begin("xiaoxi-cfg", true);
    cfgSSID  = prefs.getString("ssid", "");
    cfgPass  = prefs.getString("pass", "");
    cfgSrvIP = prefs.getString("ip", "");
    cfgSrvPort = prefs.getUShort("port", 8765);
    prefs.end();
    // Chỉ cần WiFi là đủ - IP server có thể để trống (tự dò qua UDP)
    cfgLoaded = cfgSSID.length() > 0;
    if (cfgLoaded) {
        Serial.printf("[CFG] WiFi='%s' Server=%s:%u\n", cfgSSID.c_str(),
                      cfgSrvIP.length() ? cfgSrvIP.c_str() : "<AUTO-UDP>",
                      cfgSrvPort);
    } else {
        Serial.println("[CFG] Chua co cau hinh - can Setup bang dien thoai");
    }
    return cfgLoaded;
}

void saveConfig() {
    prefs.begin("xiaoxi-cfg", false);
    prefs.putString("ssid", cfgSSID);
    prefs.putString("pass", cfgPass);
    prefs.putString("ip",   cfgSrvIP);
    prefs.putUShort("port", cfgSrvPort);
    prefs.end();
}

void clearConfig() {
    prefs.begin("xiaoxi-cfg", false);
    prefs.clear();
    prefs.end();
}

// Ghi vào NVS rồi khởi động lại (an toàn nhất)
void saveConfigAndRestart() {
    saveConfig();
    Serial.println("[CFG] Da luu cau hinh. Khoi dong lai trong 1 giay...");
    delay(800);
    ESP.restart();
}

// =========================================================================
// 12. CAPTIVE PORTAL (Google: xem mo 192.168.4.1 bang dien thoai)
// =========================================================================
String htmlEscape(String s) {
    s.replace("&", "&amp;"); s.replace("<", "&lt;");
    s.replace(">", "&gt;");  s.replace("\"", "&quot;");
    return s;
}

static String lastScanJSON = "[]";

void handlePortalScan() {
    int n = WiFi.scanComplete();
    if (n == WIFI_SCAN_FAILED) {
        WiFi.scanNetworks(true, false, false, 200);  // quét async, không chặn
        lastScanJSON = "[]";
    } else if (n == WIFI_SCAN_RUNNING) {
        // đang quét, trả kết quả cũ
    } else if (n >= 0) {
        // Buil dynamic JSON - caches results and kicks a new scan
        String json = "[";
        for (int i = 0; i < n; i++) {
            String ssid = WiFi.SSID(i);
            if (ssid.length() == 0) continue;
            if (i > 0) json += ",";
            int32_t rssi = WiFi.RSSI(i);
            int enc = WiFi.encryptionType(i) == WIFI_AUTH_OPEN ? 0 : 1;
            ssid.replace("\\", "\\\\"); ssid.replace("\"", "\\\"");
            json += "{\"s\":\"" + ssid + "\",\"r\":" + String(rssi) +
                    ",\"l\":" + String(enc) + "}";
        }
        json += "]";
        lastScanJSON = json;
        WiFi.scanDelete();
        WiFi.scanNetworks(true, false, false, 200);
    }
    portal.sendHeader("Cache-Control", "no-store");
    portal.send(200, "application/json", lastScanJSON);
}

void handlePortalRoot() {
    static const char PAGE[] PROGMEM = R"rawliteral(
<!DOCTYPE html><html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>XiaoXi Setup</title>
<style>
body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#10141f;color:#eee;max-width:420px;margin:0 auto;padding:24px 18px}
h1{font-size:22px;text-align:center;margin:4px 0 18px}
.card{background:#1b2233;border-radius:14px;padding:16px;margin-bottom:14px}
label{display:block;font-size:13px;color:#9fb0d9;margin:10px 0 4px}
select,input{width:100%;box-sizing:border-box;padding:12px;border-radius:10px;border:1px solid #33405e;background:#0c101a;color:#eee;font-size:16px}
button{width:100%;padding:14px;margin-top:18px;border:0;border-radius:12px;background:#2f7bff;color:white;font-size:17px;font-weight:bold}
.danger{background:#e5484d;font-size:13px;padding:10px;margin-top:8px}
.hint{font-size:12px;color:#7a89ad;margin-top:6px}
#status{font-size:13px;color:#7ee787;text-align:center;min-height:18px}
</style></head><body>
<h1>&#129302; C&#7845;u h&igrave;nh XiaoXi Robot</h1>
<div class="card">
<label>Wi-Fi nh&agrave; (hover qu&eacute;t t&#7921; &#273;&#7897;ng m&#7895;i 6s)</label>
<select id="ssid"><option>&#272;ang qu&eacute;t Wi-Fi...</option></select>
<label id="manualLabel">Ho&#7863;c nh&#7853;p tay t&ecirc;n Wi-Fi</label>
<input id="ssidManual" placeholder="C&ugrave;ng t&ecirc;n nh&#432; list tr&ecirc;n">
<label>M&#7853;t kh&#7849;u Wi-Fi</label>
<input id="pass" type="password" placeholder="M&#7853;t kh&#7849;u t&#432;&#417;ng &#7913;ng">
</div>
<div class="card">
<label>IP m&aacute;y ch&#7841;y server XiaoXi</label>
<input id="ip" placeholder="B&#7887; tr&#7889;ng - t&#7921; &#273;&#7897;ng d&ograve; (khuy&#7871;n ngh&#7883;)" value="%SRVIP%">
<label>C&#7893;ng server</label>
<input id="port" inputmode="numeric" value="%SRVPORT%" default="8765">
<div class="hint">&#8963; Khuy&#7871;n ngh&#7883;: &#272;&#7875; tr&#7889;ng IP &#273;&#7875; robot t&#7921; &#273;&#7897;ng d&ograve; th&ocirc;ng qua UDP broadcast (server.js c&#249;ng Wi-Fi). Nh&#7853;t manually: Win+R &#273;&aacute;nh "cmd" &#8594; "ipconfig" &#7845;m IPv4 Address.</div>
</div>
<div id="status"></div>
<button onclick="save()">L&#431;U &amp; KH&#7894;I &#272;&#7896;NG L&#7840;I</button>
<div class="card danger">
<button class="danger" onclick="location.href='/reset'">&#128465; Xo&aacute; c&#7845;u h&igrave;nh (v&#224;o Setup l&#7841;i t&#7915; &#273;&#7847;u)</button>
</div>
<script>
window.loadWifi = async function(){
  try{
    const r = await fetch('/scan',{cache:'no-store'});
    const list = await r.json();
    const sel = document.getElementById('ssid');
    if(!list.length){sel.innerHTML='<option>&#272;ang qu&eacute;t Wi-Fi ( &#273;&#7877; 6s)...</option>';return;}
    sel.innerHTML='';
    list.forEach(w=>{
      const o=document.createElement('option');
      o.value=w.s;o.textContent=w.s+' ('+w.r+'dBm)'+(w.l?' \u{1F512}':'');
      sel.appendChild(o);
    });
  }catch(e){}
};
loadWifi(); setInterval(loadWifi,6000);
window.save = async function(){
  const s = document.getElementById('ssidManual').value.trim() || document.getElementById('ssid').value;
  const p = document.getElementById('pass').value;
  const ip= document.getElementById('ip').value.trim();
  const port=document.getElementById('port').value.trim()||'8765';
  if(!s){document.getElementById('status').textContent='&#10060; H&#227;y chọn Wi-Fi nh&agrave; ho&#7863;c nh&#7853;p tay t&#234;n Wi-Fi';document.getElementById('status').style.color='#ff6b6b';return;}
  if(ip && !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)){document.getElementById('status').textContent='&#10060; IP kh&#244;ng &#273;&#250;ng &#273;&#7883;nh d&#7841;ng IPv4 (ho&#7863;c &#273;&#7875; tr&#7889;ng)';document.getElementById('status').style.color='#ff6b6b';return;}
  document.getElementById('status').textContent='&#8987; &#272;ang l&#432;u &amp; kh&#7903;i &#273;&#7897;ng l&#7841;i (10-15s)...';
  const r = await fetch('/save',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body:'ssid='+encodeURIComponent(s)+'&pass='+encodeURIComponent(p)+'&ip='+encodeURIComponent(ip)+'&port='+encodeURIComponent(port)});
  const t = await r.text();
  document.getElementById('status').textContent=t.includes('OK')?t:'&#10060; L&#7895;i: '+t;
};
</script></body></html>
)rawliteral";

    String page = FPSTR(PAGE);
    page.replace("%SRVIP%", htmlEscape(cfgSrvIP));
    page.replace("%SRVPORT%", String(cfgSrvPort));
    portal.send(200, "text/html", page);
}

// Kiểm tra IPv4 hợp lệ (4 octet 0-255)... trả về false nếu rỗng/sai
bool isValidIPv4(const String &ip) {
    if (ip.length() == 0 || ip.length() > 15) return false;
    int dots = 0;
    for (unsigned int i = 0; i < ip.length(); i++) {
        char c = ip.charAt(i);
        if (c == '.') {
            dots++;
            if (i == 0 || i == ip.length() - 1) return false;
        } else if (c < '0' || c > '9') {
            return false;
        }
    }
    if (dots != 3) return false;
    int part = -1, cur = 0;
    for (unsigned int i = 0; i <= ip.length(); i++) {
        if (i == ip.length() || ip.charAt(i) == '.') {
            if (cur > 255) return false;
            cur = 0;
            part++;
        } else {
            cur = cur * 10 + (ip.charAt(i) - '0');
        }
    }
    (void)part;
    return true;
}

void handlePortalSave() {
    String s = portal.arg("ssid");
    String p = portal.arg("pass");
    String ip = portal.arg("ip");
    String portS = portal.arg("port");
    if (!s.length()) { portal.send(400, "text/html", "MISSING SSID"); return; }
    if (ip.length() > 0 && !isValidIPv4(ip)) {
        portal.send(400, "text/html", "INVALID IP"); return;
    }
    cfgSSID = s; cfgPass = p;
    // IP bỏ trống = tự động dò qua UDP broadcast sau khi vào được WiFi nhà
    cfgSrvIP = ip;
    cfgSrvPort = (uint16_t)(portS.length() > 0 && portS.toInt() > 0 ? portS.toInt() : 8765);
    saveConfig();
    Serial.printf("[CFG] SAVE: WiFi='%s' Server=%s:%u\n",
                  cfgSSID.c_str(),
                  cfgSrvIP.length() ? cfgSrvIP.c_str() : "<AUTO/UDP>",
                  cfgSrvPort);
    portal.send(200, "text/html", "OK Da luu! Robot dang khoi dong lai...");
}

void handlePortalReset() {
    clearConfig();
    portal.send(200, "text/html", "OK Da xoa - Restarting...");
    delay(600);
    ESP.restart();
}

void handleCaptiveRedirect() {
    // Mọi request không khớp route -> redirect về portal (bắt popup trên điện thoại)
    portal.sendHeader("Location", "http://192.168.4.1/", true);
    portal.send(302, "text/plain", "");
}

void showPortalSplash() {
    Serial.println("[SETUP] Dang ve giao dien Setup len man hinh TFT...");
    Serial.flush();
    tft.invertDisplay(true);   // Đảo màu để 0x0000 là đen sâu, không bị trắng màn hình
    tft.fillScreen(TFT_BLACK);
    tft.setTextColor(TFT_CYAN, TFT_BLACK);
    tft.setTextDatum(MC_DATUM);
    tft.setTextSize(2);
    tft.drawString("XiaoXi SETUP", 160, 44);
    tft.setTextColor(TFT_WHITE, TFT_BLACK);
    tft.setTextSize(1);
    tft.drawString("Buoc 1: Tren dien thoai ket noi Wi-Fi:", 160, 95);
    tft.setTextColor(TFT_YELLOW, TFT_BLACK);
    tft.drawString("XiaoXi-Setup (khong mat khau)", 160, 115);
    tft.setTextColor(TFT_WHITE, TFT_BLACK);
    tft.drawString("Buoc 2: Mo trinh duyet vao dia chi:", 160, 140);
    tft.setTextColor(TFT_CYAN, TFT_BLACK);
    tft.drawString("http://192.168.4.1", 160, 160);
    tft.setTextColor(TFT_LIGHTGREY, TFT_BLACK);
    tft.drawString("Chon Wi-Fi nha + nhap IP server -> LUU", 160, 195);
    Serial.println("[SETUP] Ve TFT hoan tat!");
    Serial.flush();
    if (oledOk) {
        display.clearDisplay();
        display.setCursor(0, 0);
        display.println("SETUP VIA PHONE");
        display.println("Wi-Fi: XiaoXi-Setup");
        display.print("Vi tri: 192.168.4.1");
        display.display();
    }
}

void runSetupPortal(bool allowStart) {
    Serial.println("[SETUP] Khoi dong Captive Portal cho dien thoai...");
    Serial.flush();

    // 1. BẬT WIFI ACCESS POINT TRƯỚC TIÊN ĐỂ ĐIỆN THOẠI LUÔN BẮT ĐƯỢC NGAY
    WiFi.mode(WIFI_AP_STA);
    delay(150);
    WiFi.softAP(AP_SSID);            // nếu đặt mật khẩu ở đây -> softAP(AP_SSID, "12345678")
    IPAddress apIP = WiFi.softAPIP(); // 192.168.4.1
    Serial.println();
    Serial.println("=============================================================");
    Serial.printf("[SETUP] Wi-Fi AP DA PHAT: '%s' | IP: %s\n", AP_SSID, apIP.toString().c_str());
    Serial.println("[SETUP] >>> DUNG DIEN THOAI KET NOI WIFI: XiaoXi-Setup");
    Serial.println("[SETUP] >>> MO TRINH DUYET GO: http://192.168.4.1");
    Serial.println("=============================================================");
    Serial.flush();

    dnsServer.start(53, "*", apIP);  // DNS wildcard -> tất cả tên đều về robot

    portal.on("/", HTTP_GET, handlePortalRoot);
    portal.on("/scan", HTTP_GET, handlePortalScan);
    portal.on("/save", HTTP_POST, handlePortalSave);
    portal.on("/save", HTTP_GET, handlePortalSave);  // duyệt an toàn (máy test)
    portal.on("/reset", HTTP_GET, handlePortalReset);
    portal.onNotFound(handleCaptiveRedirect);
    portal.begin();
    WiFi.scanNetworks(true, false, false, 200);  // bắt đầu quét ngầm

    // 2. VẼ GIAO DIỆN LÊN MÀN HÌNH
    showPortalSplash();

    unsigned long startAt = millis();
    bool hasSavedConfig = cfgSSID.length() > 0;
    while (true) {
        dnsServer.processNextRequest();
        portal.handleClient();

        // Timeout tự thoát nếu đã có cấu hình cũ mà anh bỏ quên 8 phút
        if (allowStart && hasSavedConfig &&
            millis() - startAt > (AP_TIMEOUT_MIN * 60UL * 1000UL)) {
            Serial.println("[SETUP] Timeout - quay lai ket noi luu tru");
            WiFi.softAPdisconnect(true);
            portal.stop();
            dnsServer.stop();
            return;
        }
        delay(2);
    }
}

// =========================================================================
// 13. WIFI + WEBSOCKET
// =========================================================================
bool tryConnectWiFi(uint32_t timeoutMs) {
    Serial.printf("[WiFi] Dang ket noi '%s'...\n", cfgSSID.c_str());
    WiFi.mode(WIFI_STA);
    WiFi.begin(cfgSSID.c_str(), cfgPass.c_str());
    unsigned long start = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - start < timeoutMs) {
        delay(400);
        Serial.print(".");
        if (digitalRead(BOOT_BUTTON_PIN) == LOW) break; // cho phép huỷ
    }
    Serial.println();
    wifiConnected = (WiFi.status() == WL_CONNECTED);
    if (wifiConnected) {
        Serial.printf("[WiFi] OK dto IP: %s\n", WiFi.localIP().toString().c_str());
        serverStatusText = "WiFi " + cfgSSID;
    } else {
        Serial.println("[WiFi] THAT BAI");
        serverStatusText = "Loi ket noi WiFi !";
    }
    return wifiConnected;
}

void connectWebSocket() {
    if (!wifiConnected) return;
    if (cfgSrvIP.length() == 0) {
        Serial.println("[WS] Chua biet IP server - cho UDP UDP discovery tu dong");
        serverStatusText = "Do tim server UDP...";
        return;
    }
    Serial.printf("[WS] Ket noi ws://%s:%u/\n", cfgSrvIP.c_str(), cfgSrvPort);
    serverStatusText = "Server " + cfgSrvIP + ":" + String(cfgSrvPort);
    webSocket.begin(cfgSrvIP.c_str(), cfgSrvPort, "/");
    webSocket.onEvent(onWebSocketEvent);
    webSocket.setReconnectInterval(5000);
    webSocket.enableHeartbeat(15000, 3000, 2);
}

// =========================================================================
// 12.5 UDP DISCOVERY - tự tìm IP server (server.js broadcast mỗi 3s)
// =========================================================================
void handleDiscoveryPacket() {
    char rx[64];
    int n = udpDiscovery.read(rx, sizeof(rx) - 1);
    if (n <= 0) { udpDiscovery.flush(); return; }
    rx[n] = 0;
    udpDiscovery.flush();

    String msg = String(rx);
    if (!msg.startsWith(UDP_DISCOVERY_MAGIC)) return;

    String discoveredIP = udpDiscovery.remoteIP().toString();
    unsigned long now = millis();

    // Reply ACK để Node server biết robot còn sống (throttle 60s)
    if (now - lastDiscoveryReplyAt > 60000) {
        udpDiscovery.beginPacket(udpDiscovery.remoteIP(), UDP_DISCOVERY_PORT);
        udpDiscovery.print(UDP_ROBOT_REPLY);
        udpDiscovery.endPacket();
        lastDiscoveryReplyAt = now;
    }

    if (cfgSrvIP.length() == 0) {
        Serial.printf("[DISCOVER] Tu dong tim thay server: %s -> luu va ket noi\n",
                      discoveredIP.c_str());
        cfgSrvIP = discoveredIP;
        saveConfig();
        connectWebSocket();
    } else if (cfgSrvIP != discoveredIP && !wsConnected) {
        // IP cũ sai / máy đổi IP: tự chuyển sang IP discovered mới
        Serial.printf("[DISCOVER] IP config '%s' khong ket noi duoc -> chuyen sang '%s'\n",
                      cfgSrvIP.c_str(), discoveredIP.c_str());
        cfgSrvIP = discoveredIP;
        saveConfig();
        webSocket.disconnect();
        connectWebSocket();
    }
}

// =========================================================================
// 12.6 PROTOCOL V2 - handshake JSON, state, barge-in, metrics
// =========================================================================
String jsonStringField(const String &json, const char *key) {
    String needle = String("\"") + key + "\"";
    int keyPos = json.indexOf(needle);
    if (keyPos < 0) return "";
    int colon = json.indexOf(':', keyPos + needle.length());
    if (colon < 0) return "";
    int q1 = json.indexOf('"', colon + 1);
    if (q1 < 0) return "";
    int q2 = json.indexOf('"', q1 + 1);
    if (q2 < 0) return "";
    return json.substring(q1 + 1, q2);
}

long jsonIntField(const String &json, const char *key) {
    String needle = String("\"") + key + "\"";
    int keyPos = json.indexOf(needle);
    if (keyPos < 0) return 0;
    int colon = json.indexOf(':', keyPos + needle.length());
    if (colon < 0) return 0;
    int start = colon + 1;
    while (start < (int)json.length() && !isDigit(json[start]) && json[start] != '-') start++;
    int end = start;
    while (end < (int)json.length() && (isDigit(json[end]) || json[end] == '-')) end++;
    return json.substring(start, end).toInt();
}

void flushSpeakerRing() {
    if (speakerMutex != NULL) {
        xSemaphoreTake(speakerMutex, portMAX_DELAY);
        speakerReadIdx = speakerWriteIdx;
        xSemaphoreGive(speakerMutex);
    }
    ttsPlaying = false;
    micPausedByServer = false;
}

void sendProtocolHello() {
    if (!wsConnected) return;
    if (deviceId.length() == 0) {
        String mac = WiFi.macAddress();
        mac.replace(":", "");
        deviceId = "xiaoxi-" + mac.substring(mac.length() > 6 ? mac.length() - 6 : 0);
    }
    protocolV2 = false;
    String caps = "\"audio_pcm16_16k\",\"touch\",\"tft_st7789\",\"oled_ssd1306\",\"music\",\"servo\",\"dual_i2s\"";
#if defined(XIAOXI_TARGET_S3)
    caps += ",\"esp32s3\",\"usb_cdc\"";
    if (ESP.getPsramSize() > 0) caps += ",\"psram\"";
#endif
    String hello = "{\"v\":2,\"type\":\"hello\",\"device_id\":\"" + deviceId +
                   "\",\"capabilities\":[" + caps + "]}";
    webSocket.sendTXT(hello);
    Serial.printf("[WS v2] Gui hello: %s\n", deviceId.c_str());
}

void sendProtocolMetrics() {
    if (!protocolV2 || !wsConnected) return;
    size_t buffered = 0;
    if (speakerMutex != NULL) {
        xSemaphoreTake(speakerMutex, portMAX_DELAY);
        buffered = (speakerWriteIdx >= speakerReadIdx)
                       ? (speakerWriteIdx - speakerReadIdx)
                       : (speakerBufferSize - speakerReadIdx + speakerWriteIdx);
        xSemaphoreGive(speakerMutex);
    }
    String json = String("{\"v\":2,\"type\":\"metrics\",\"metrics\":{\"free_heap\":") + String(ESP.getFreeHeap()) +
                  ",\"min_free_heap\":" + String(ESP.getMinFreeHeap()) +
                  ",\"rssi\":" + String(WiFi.RSSI()) +
                  ",\"uptime_ms\":" + String(millis()) +
                  ",\"cpu_mhz\":" + String(ESP.getCpuFreqMHz()) +
                  ",\"flash_size\":" + String((unsigned)ESP.getFlashChipSize()) +
                  ",\"psram_size\":" + String((unsigned)ESP.getPsramSize()) +
                  ",\"free_psram\":" + String((unsigned)ESP.getFreePsram()) +
                  ",\"speaker_buffer\":" + String((unsigned)buffered) +
                  ",\"speaker_capacity\":" + String((unsigned)speakerBufferSize) +
                  ",\"speaker_psram\":" + String(speakerBufferInPsram ? "true" : "false") +
                  ",\"speaker_drops\":" + String((unsigned)speakerDropTotal) +
                  ",\"state\":\"" + protocolState + "\"}}";
    webSocket.sendTXT(json);
}

void sendBargeIn(const char *reason) {
    if (!wsConnected) return;
    if (protocolV2) {
        String msg = String("{\"v\":2,\"type\":\"barge_in\",\"reason\":\"") + reason + "\"}";
        webSocket.sendTXT(msg);
    } else {
        webSocket.sendTXT("__BARGE_IN__");
    }
    Serial.printf("[WS] Barge-in: %s\n", reason);
}

void handleProtocolMessage(const String &msg) {
    String type = jsonStringField(msg, "type");
    if (type.length() == 0) return;

    if (type == "hello_ack") {
        protocolV2 = true;
        deviceSessionId = jsonStringField(msg, "session_id");
        lastMetricsAt = millis();
        Serial.printf("[WS v2] Hello OK - session=%s\n", deviceSessionId.c_str());
        return;
    }

    if (type == "ping") {
        long seq = jsonIntField(msg, "seq");
        String pong = String("{\"v\":2,\"type\":\"pong\",\"seq\":") + String(seq) + "}";
        webSocket.sendTXT(pong);
        return;
    }

    if (type == "state") {
        String state = jsonStringField(msg, "state");
        protocolState = state;
        if (state == "LISTEN") drawEyes("__FACE_LISTEN__");
        else if (state == "THINK") drawEyes("__FACE_THINK__");
        else if (state == "ERROR") drawEyes("__FACE_SAD__");
        else if (state == "IDLE" && (currentFace == "__FACE_LISTEN__" || currentFace == "__FACE_THINK__")) {
            drawEyes("__FACE_HAPPY__");
        }
        return;
    }

    if (type == "audio.flush") {
        flushSpeakerRing();
        ignoreAudioUntil = millis() + 150;
        return;
    }

    if (type == "config_ack") {
        Serial.println("[WS v2] Da ap dung cau hinh VAD");
        return;
    }

    if (type == "error") {
        String message = jsonStringField(msg, "message");
        Serial.println("[WS v2] Loi server: " + message);
        drawEyes("__FACE_SAD__");
        return;
    }
}

void onWebSocketEvent(WStype_t type, uint8_t *payload, size_t length) {
    switch (type) {
        case WStype_CONNECTED:
            wsConnected = true;
            ttsPlaying = false;
            micPausedByServer = false;
            musicPlaying = false;
            protocolV2 = false;
            ignoreAudioUntil = 0;
            Serial.println("[WS] Da ket noi server!");
            serverStatusText = "Server: ONLINE";
            currentPage = MAIN_PAGE;
            drawMainPage("San sang!");
            sendProtocolHello();
            break;

        case WStype_DISCONNECTED:
            wsConnected = false;
            protocolV2 = false;
            musicPlaying = false;
            flushSpeakerRing();
            micWindowEndMs = 0;
            serverStatusText = "Server: OFFLINE";
            Serial.println("[WS] Mat ket noi server!");
            drawMainPage("Mat ket noi!");
            break;

        case WStype_TEXT: {
            String msg = String((char *)payload);
            if (msg.startsWith("{")) {
                handleProtocolMessage(msg);
                return;
            }
            if (msg == "__PING__") {
                webSocket.sendTXT("__PONG__");
                return;
            }
            if (msg == "__SPEAK_START__") {
                ttsPlaying = true;
                micPausedByServer = true;   // không tự nghe tiếng mình
                ignoreAudioUntil = 0;
                return;
            }
            if (msg == "__AUDIO_FLUSH__") {
                flushSpeakerRing();
                ignoreAudioUntil = millis() + 150;
                return;
            }
            if (msg == "__SPEAK_END__") {
                // Không xóa ring buffer ngay kẻo vứt mất phần đuôi câu nói đang phát dở!
                // speakerTask sẽ tự động phát hết sạch dữ liệu (avail == 0) rồi mới mở lại mic.
                return;
            }
            if (msg == "__MIC_WINDOW__") {
                // CỬA SỔ NGHE LỆNH (nhạc vẫn đang phát): xả buổi loa kẻo robot tự
                // nghe chính nó, mở mic 2.6s cho server bận VAD bắt lệnh
                // (tắt / tạm dừng / tiếp tục / bài khác). Hết 2.6s micTask tự đóng.
                xSemaphoreTake(speakerMutex, portMAX_DELAY);
                speakerReadIdx = speakerWriteIdx;     // xả ring loa
                xSemaphoreGive(speakerMutex);
                micPausedByServer = false;
                micWindowEndMs = millis() + 2600;
                return;
            }
            if (msg == "SERVER_SHUTDOWN") {
                wsConnected = false;
                protocolV2 = false;
                musicPlaying = false;
                flushSpeakerRing();
                micWindowEndMs = 0;
                return;
            }
            // ==== [TFT PRO] các lệnh NHỊP đi đường nhanh KHÔNG qua hàng đợi ====
            // (mỗi 4s một POS/TIME/WX sẽ làmCmdQueue dễ tràn -> USER/AI bị bỏ -> TFT trống)
            if (msg.startsWith("__MUSIC_POS__")) {
                int p1 = msg.indexOf('|'), p2 = msg.lastIndexOf('|');
                if (p1 > 13 && p2 > p1) {
                    musicPosStr = msg.substring(13, p1);
                    musicDurStr = msg.substring(p1 + 1, p2);
                    musicPosPct = msg.substring(p2 + 1).toFloat();
                    if (currentScreen == SCREEN_MUSIC) drawMusicProgress();
                }
                return;
            }
            if (msg.startsWith("__TIME__")) {
                int bar = msg.indexOf('|');
                if (bar > 8) { tftClockLine = msg.substring(8, bar); tftClockDow = msg.substring(bar + 1); }
                drawReadyAmbient();
                return;
            }
            if (msg.startsWith("__WX__")) {
                tftWxLine = msg.substring(6);
                drawReadyAmbient();
                return;
            }
            if (msg.startsWith("__MUSIC_INFO__")) musicPlaying = true;
            else if (msg == "__MUSIC_STOP__") musicPlaying = false;
            if (cmdQueue != NULL) {
                char buf[CMD_MSG_LEN];
                strlcpy(buf, (const char *)payload, CMD_MSG_LEN - 1);
                if (xQueueSend(cmdQueue, buf, 0) != pdTRUE) {
                    Serial.println("[!] CmdQueue day, bo lenh: " + msg);
                }
            }
            break;
        }

        case WStype_BIN:
            // Binary = chunk PCM16 16kHz từ TTS/Nhạc -> đẩy vào ring buffer cho loa
            if (length > 1) {
                if (speakerBuffer == NULL || speakerBufferSize == 0) break;
                // Sau barge-in/stop: bỏ các gói PCM còn bay tới để không nghe vọng lại
                if (millis() < ignoreAudioUntil) break;
                // BẮT BUỘC chẵn byte để bảo toàn căn chỉnh mẫu 16-bit PCM Little-Endian
                length &= ~1;
                size_t written = 0;
                xSemaphoreTake(speakerMutex, portMAX_DELAY);
                // Tính dung lượng còn trống bảo đảm số byte chẵn
                size_t freeSpace = (speakerReadIdx > speakerWriteIdx)
                                       ? (speakerReadIdx - speakerWriteIdx - 1)
                                       : (speakerBufferSize - speakerWriteIdx + speakerReadIdx - 1);
                freeSpace &= ~1;
                size_t toWrite = min(length, freeSpace);

                for (size_t i = 0; i < toWrite; i++) {
                    speakerBuffer[speakerWriteIdx] = payload[i];
                    speakerWriteIdx = (speakerWriteIdx + 1) % speakerBufferSize;
                    written++;
                }
                if (toWrite < length) {
                    speakerDropTotal += (length - toWrite);
                }
                xSemaphoreGive(speakerMutex);
                if (written < length) {
                    Serial.printf("[AMP] CANH BAO ring day: bo %u/%u B (tong bo %u)\n",
                                  (unsigned)(length - written), (unsigned)length, (unsigned)speakerDropTotal);
                }
            }
            break;

        default: break;
    }
}

// =========================================================================
// 14. I2S
// =========================================================================
void initMic() {
    i2s_config_t cfg = {
        .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX),
        .sample_rate = MIC_SAMPLE_RATE,
        .bits_per_sample = I2S_BITS_PER_SAMPLE_32BIT,  // INMP441 là mic 24-bit: BẮT BUỘC khung 32-bit! 16-bit = mic giải mã lệch xung -> trống 0x0000
        .channel_format = I2S_CHANNEL_FMT_ONLY_LEFT,   // L/R cắm xuống GND -> kênh trái
        .communication_format = I2S_COMM_FORMAT_STAND_I2S,
        .intr_alloc_flags = ESP_INTR_FLAG_LEVEL1,
        .dma_buf_count = 8,
        .dma_buf_len = 256,
        .use_apll = false,
        .tx_desc_auto_clear = false,
        .fixed_mclk = 0
    };
    i2s_pin_config_t pins = {
        .mck_io_num = I2S_PIN_NO_CHANGE,
        .bck_io_num = I2S_MIC_SCK,
        .ws_io_num = I2S_MIC_WS,
        .data_out_num = I2S_PIN_NO_CHANGE,
        .data_in_num = I2S_MIC_SD
    };
    if (i2s_driver_install(I2S_MIC_PORT, &cfg, 0, NULL) != ESP_OK) {
        Serial.println("[!] Loi cai dat I2S mic"); return;
    }
    if (i2s_set_pin(I2S_MIC_PORT, &pins) != ESP_OK) {
        Serial.println("[!] Loi gan pin I2S mic");
    }
}

void initSpeaker() {
    i2s_config_t cfg = {
        .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_TX),
        .sample_rate = AMP_SAMPLE_RATE,
        .bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT,
        // STEREO (L=R): firmware tự nhân đôi mỗi mẫu mono -> loa amp MAX98357A
        // nghe đúng audio DÙ chân L/R của amp nối GND hay lơ lửng HIGH.
        .channel_format = I2S_CHANNEL_FMT_RIGHT_LEFT,
        .communication_format = I2S_COMM_FORMAT_STAND_I2S,
        .intr_alloc_flags = ESP_INTR_FLAG_LEVEL1,
        .dma_buf_count = 8,
        .dma_buf_len = 256,
#if defined(CONFIG_IDF_TARGET_ESP32S3) || defined(XIAOXI_TARGET_S3)
        .use_apll = false,           // ESP32-S3 không có APLL - bắt buộc dùng clock chuẩn nội bộ
#else
        .use_apll = true,            // ESP32 legacy dùng APLL
#endif
        .tx_desc_auto_clear = true,
        .fixed_mclk = 0
    };
    i2s_pin_config_t pins = {
        .mck_io_num = I2S_PIN_NO_CHANGE,
        .bck_io_num = I2S_AMP_BCLK,
        .ws_io_num = I2S_AMP_LRC,
        .data_out_num = I2S_AMP_DIN,
        .data_in_num = I2S_PIN_NO_CHANGE
    };
    esp_err_t err = i2s_driver_install(I2S_AMP_PORT, &cfg, 0, NULL);
    if (err != ESP_OK) {
        Serial.printf("[!] Loi cai dat I2S loa: 0x%X\n", err); return;
    }
    err = i2s_set_pin(I2S_AMP_PORT, &pins);
    if (err != ESP_OK) {
        Serial.printf("[!] Loi gan pin I2S loa: 0x%X\n", err);
    } else {
        Serial.printf("[AMP] I2S Loa OK: BCLK=%d LRC=%d DIN=%d\n", I2S_AMP_BCLK, I2S_AMP_LRC, I2S_AMP_DIN);
    }
}

// =========================================================================
// 15. FREERTOS TASKS
// =========================================================================
void micTask(void *param) {
    Serial.println("[MIC] Task capture 16kHz PCM-16LE");

    // MIC DEBUG: mỗi giây in RMS của tiếng thu được lên Serial.
    //  rms ~ 0.000 đến hết bài → dây mic sai (SD/WS/SCK/L/R) hoặc mic chết
    //  rms nhảy theo lời nói (0.02-0.4) → mic hoàn toàn sống, vấn đề nằm ở server
    const bool MIC_DEBUG = true;
    int dbgFrames = 0;
    float dbgPeakRMS = 0;
    uint32_t dbgZero = 0;

    for (;;) {
        if (!wsConnected) {
            // DMA I2S vẫn nạp đầy khi mất mạng -> khi WS sống lại, khối cũ
            // (tiếng của quá khứ) tràn xuống server làm Whisper đọc sai câu.
            // Xả DMA liên tục như khi robot đang nói, nghỉ 16ms/khung.
            int32_t flush[MIC_CHUNK_SAMPLES];
            size_t br = 0;
            i2s_read(I2S_MIC_PORT, flush, sizeof(flush), &br, pdMS_TO_TICKS(16));
            continue;
        }
        // Hết 2.6s cửa sổ "nghe lệnh trong nhạc" -> mic tự đóng lại (nếu nhạc đang phát)
        if (micWindowEndMs != 0 && millis() >= micWindowEndMs) micWindowEndMs = 0;

        static unsigned long pausedSince = 0;
        bool inMicWindow = (micWindowEndMs != 0);
        if ((ttsPlaying || micPausedByServer) && !inMicWindow) {
            if (pausedSince == 0) pausedSince = millis();
            else if (millis() - pausedSince > 15000) {
                // Bảo hiểm: server ngắt ngang chưa kịp gửi __SPEAK_END__ -> tự mở mic lại
                micPausedByServer = false;
                ttsPlaying = false;
                pausedSince = 0;
            }
            // vứt frame đang chờ (không tự nghe tiếng mình)
            int32_t flush[MIC_CHUNK_SAMPLES];
            size_t br = 0;
            i2s_read(I2S_MIC_PORT, flush, sizeof(flush), &br, pdMS_TO_TICKS(5));
            continue;
        }
        pausedSince = 0;
        int32_t rawChunk[MIC_CHUNK_SAMPLES];   // I2S 32-bit: INMP441 nạp 24/32 bit có dữ liệu
        int16_t chunk[MIC_CHUNK_SAMPLES];
        size_t bytes_read = 0;
        if (i2s_read(I2S_MIC_PORT, rawChunk, sizeof(rawChunk), &bytes_read, portMAX_DELAY) == ESP_OK
            && bytes_read > 0) {
            int n = bytes_read / 4;
            // dịch phải 14 bit: 24-bit raw -> 16-bit có gain tự nhiên (nghe rõ xa 1m)
            for (int i = 0; i < n; i++) chunk[i] = (int16_t)(rawChunk[i] >> 14);
            if (MIC_DEBUG) {
                float sum = 0;
                for (int i = 0; i < MIC_CHUNK_SAMPLES; i++) sum += (float)chunk[i] * chunk[i];
                float rms = sqrt(sum / MIC_CHUNK_SAMPLES) / 32768.0f;
                if (rms > dbgPeakRMS) dbgPeakRMS = rms;
                if (++dbgFrames >= 31) {         // kiem tra moi 0.5s
                    // Chi in log khi thuc su co am thanh, im lang khong in gi ca
                    if (dbgPeakRMS > 0.008f) {
                        Serial.printf("[MIC] Phat hien am thanh: RMS = %.3f\n", dbgPeakRMS);
                    }
                    dbgFrames = 0; dbgPeakRMS = 0;
                }
            }
            webSocket.sendBIN((uint8_t *)chunk, n * 2);  // n raw 32-bit -> n mẫu 16-bit
        } else {
            vTaskDelay(2);
        }
    }
}

void speakerTask(void *param) {
    Serial.println("[AMP] Task phat PCM 16kHz (APLL + Pre-buffering + Anti-clipping)");
    bool isBuffering = true;
    const size_t PREBUFFER_THRESHOLD = 8192; // gom tối thiểu 8KB (~256ms) trước khi mở loa phát

    for (;;) {
        if (speakerBufferSize == 0) {
            vTaskDelay(pdMS_TO_TICKS(1000));
            continue;
        }
        size_t avail;
        xSemaphoreTake(speakerMutex, portMAX_DELAY);
        avail = (speakerWriteIdx >= speakerReadIdx)
                    ? (speakerWriteIdx - speakerReadIdx)
                    : (speakerBufferSize - speakerReadIdx + speakerWriteIdx);
        xSemaphoreGive(speakerMutex);

        if (avail == 0) {
            isBuffering = true;
            ttsPlaying = false;
            micPausedByServer = false;
            vTaskDelay(pdMS_TO_TICKS(10));
            continue;
        }

        // Nếu đang trong trạng thái chờ tích đệm (pre-buffering)
        // và dữ liệu chưa đủ 8KB, đồng thời đang trong lượt TTS
        if (isBuffering && avail < PREBUFFER_THRESHOLD && ttsPlaying) {
            vTaskDelay(pdMS_TO_TICKS(15));
            continue;
        }
        isBuffering = false;

        // Chỉ lấy số byte chẵn (PCM 16-bit LE), xử lý chunk 1024 bytes (512 mẫu mono = 32ms)
        size_t chunk = min(avail, (size_t)1024);
        chunk &= ~1;

        static uint8_t out[1024];
        static int16_t stereoOut[1024];

        xSemaphoreTake(speakerMutex, portMAX_DELAY);
        for (size_t i = 0; i < chunk; i++) {
            out[i] = speakerBuffer[speakerReadIdx];
            speakerReadIdx = (speakerReadIdx + 1) % speakerBufferSize;
        }
        xSemaphoreGive(speakerMutex);

        size_t n = chunk / 2;  // số sample mono 16-bit
        const int16_t *monoIn = (const int16_t *)out;

        // Giữ trọn vẹn 100% biên độ mẫu để giọng nói to, tròn vành, rõ chữ
        for (size_t s = 0; s < n; s++) {
            int16_t v = monoIn[s];
            stereoOut[2 * s]     = v; // kênh trái
            stereoOut[2 * s + 1] = v; // kênh phải
        }

        size_t written = 0;
        i2s_write(I2S_AMP_PORT, (const uint8_t *)stereoOut, n * 4, &written, portMAX_DELAY);
        ttsPlaying = true;
    }
}

bool initSpeakerBuffer() {
    size_t cap = 64 * 1024;
#if defined(XIAOXI_TARGET_S3)
    if (ESP.getPsramSize() > 0) {
        cap = 512 * 1024;
        speakerBuffer = (uint8_t *)heap_caps_malloc(cap, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
        if (speakerBuffer) speakerBufferInPsram = true;
    }
#endif
    if (!speakerBuffer) {
        cap = 64 * 1024;
        speakerBuffer = (uint8_t *)malloc(cap);
    }
    if (!speakerBuffer) {
        cap = 16 * 1024;
        speakerBuffer = (uint8_t *)malloc(cap);
    }
    if (!speakerBuffer) {
        speakerBufferSize = 0;
        return false;
    }
    speakerBufferSize = cap;
    speakerWriteIdx = 0;
    speakerReadIdx = 0;
    speakerDropTotal = 0;
    memset(speakerBuffer, 0, speakerBufferSize);
    Serial.printf("[AMP] Ring buffer: %u KB (%s)\n",
                  (unsigned)(speakerBufferSize / 1024),
                  speakerBufferInPsram ? "PSRAM" : "SRAM");
    return true;
}

// =========================================================================
// 16. SETUP
// =========================================================================
void setup() {
    Serial.begin(115200);
    delay(300);

#if defined(XIAOXI_TARGET_S3)
    Serial.printf("[SYS] %s | chip=%s rev%d | %d core @ %u MHz\n",
                  XIAOXI_BOARD_NAME, ESP.getChipModel(), ESP.getChipRevision(),
                  ESP.getChipCores(), ESP.getCpuFreqMHz());
    Serial.printf("[SYS] Flash: %u MB | PSRAM: %u MB (free %u KB)\n",
                  (unsigned)(ESP.getFlashChipSize() / (1024 * 1024)),
                  (unsigned)(ESP.getPsramSize() / (1024 * 1024)),
                  (unsigned)(ESP.getFreePsram() / 1024));
    Serial.printf("[SYS] USB CDC native | eFuse MAC: %04X%08X\n",
                  (uint16_t)(ESP.getEfuseMac() >> 32), (uint32_t)ESP.getEfuseMac());
    if (ESP.getPsramSize() == 0) {
        Serial.println("[!] PSRAM chua bat - kiem tra board_build.arduino.memory_type=qio_opi");
    }
#else
    Serial.printf("[SYS] %s | chip=%s rev%d | %d core @ %u MHz\n",
                  XIAOXI_BOARD_NAME, ESP.getChipModel(), ESP.getChipRevision(),
                  ESP.getChipCores(), ESP.getCpuFreqMHz());
    Serial.printf("[SYS] Flash: %u MB | PSRAM: %u MB\n",
                  (unsigned)(ESP.getFlashChipSize() / (1024 * 1024)),
                  (unsigned)(ESP.getPsramSize() / (1024 * 1024)));
#endif
    Serial.printf("[SYS] Free heap luc boot: %u bytes | min: %u bytes\n",
                  (unsigned)ESP.getFreeHeap(), (unsigned)ESP.getMinFreeHeap());

    if (!initSpeakerBuffer()) {
        Serial.println("[!] Khong cap phat duoc speaker ring buffer!");
    }

    pinMode(BOOT_BUTTON_PIN, INPUT_PULLUP);

    // Nếu đang nhấn giữ BOOT lúc khởi động -> vào Setup bằng điện thoại
    bool forcePortal = (digitalRead(BOOT_BUTTON_PIN) == LOW);

    cmdQueue = xQueueCreate(CMD_QUEUE_MAX, CMD_MSG_LEN);
    speakerMutex = xSemaphoreCreateMutex();

    Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);
    oledOk = display.begin(SSD1306_SWITCHCAPVCC, 0x3C);
    if (!oledOk) {
        Serial.println("[OLED] Chua cam man OLED (GPIO 1, 2) - bo qua I2C de khong treo");
    } else {
        display.setTextColor(SSD1306_WHITE);
        drawEyes("__FACE_HAPPY__");
    }

#if defined(PIN_TFT_BL) && (PIN_TFT_BL >= 0)
    pinMode(PIN_TFT_BL, OUTPUT);
    digitalWrite(PIN_TFT_BL, HIGH);
#endif

    Serial.printf("[TFT] TFT_eSPI dang dung pin: MOSI=%d MISO=%d SCLK=%d CS=%d DC=%d RST=%d\n",
                  TFT_MOSI, TFT_MISO, TFT_SCLK, TFT_CS, TFT_DC, TFT_RST);
    tft.init();
    tft.setRotation(1);
    tft.invertDisplay(true);
    tft.fillScreen(TFT_BLACK);
#if ENABLE_TOUCH
    touch.begin();
#endif

    ESP32PWM::allocateTimer(0);
    ESP32PWM::allocateTimer(1);
    ESP32PWM::allocateTimer(2);
    ESP32PWM::allocateTimer(3);
    headServo.setPeriodHertz(50);
    headServo.attach(HEAD_PIN, 500, 2400);
    legServo.setPeriodHertz(50);
    legServo.attach(LEG_PIN, 500, 2400);
    headServo.write(STOP_VALUE);
    legServo.write(STOP_VALUE);          // chân 14 cũng là quay liên tục - dừng ở 94

    // Task servo riêng: lệnh servo bất đồng bộ, luồng chính không bị delay()
    servoQueue = xQueueCreate(SERVO_QUEUE_MAX, sizeof(ServoMove));
    xTaskCreatePinnedToCore(servoTask, "servo", 3072, NULL, 2, NULL, SERVO_TASK_CORE);

    // ---------------- CẤU HÌNH QUA ĐIỆN THOẠI ----------------
    bool hasCfg = loadConfig();
    if (forcePortal || !hasCfg) {
        // Lần đầu boot hoặc anh yêu cầu -> mở Setup bằng điện thoại
        // (Portal sẽ KHÔNG thoát cho đến khi phone bấm LƯU -> restart chip)
        runSetupPortal(hasCfg);   // hasCfg=true cho phép chờ 8' rồi retry old cfg
        bool ok = tryConnectWiFi(15000);
        if (!ok) {
            drawMainPage("Loi WiFi!");
            showPortalSplash();
            runSetupPortal(false);  // chờ vĩnh viễn cho tới khi LƯU
        }
        drawMainPage("San sang!");
    } else {
        if (!tryConnectWiFi(15000)) {
            // WiFi mất kết nối / sai mật khẩu: mở portal chờ điện thoại cài lại
            showPortalSplash();
            runSetupPortal(true);
            tryConnectWiFi(15000);
        }
    }
    drawMainPage("San sang!");

    // ---------------- AUDIO + WS ----------------
    initSpeaker();
    initMic();
    xTaskCreatePinnedToCore(speakerTask, "speaker", 6144, NULL, 3, NULL, SPEAKER_TASK_CORE);
    xTaskCreatePinnedToCore(micTask, "mic", 6144, NULL, 4, NULL, MIC_TASK_CORE);

    connectWebSocket();
    Serial.println("[BOOT] XiaoXi san sang hoat dong!");
}

void loop() {
    webSocket.loop();
    networkLoop();
    handleTouch();

    // UDP auto-discovery: chỉ có tác dụng khi đã kết nối WiFi nhà (không phải mode AP setup)
    static bool udpListening = false;
    if (wifiConnected && !udpListening) {
        if (udpDiscovery.begin(UDP_DISCOVERY_PORT)) {   // core 3.x: dùng begin(), không có listen()
            udpListening = true;
            Serial.printf("[UDP] Nghe discovery port %u de tu tim server...\n",
                          UDP_DISCOVERY_PORT);
        }
    }
    if (udpListening) {
        int p = udpDiscovery.parsePacket();
        if (p > 0) handleDiscoveryPacket();
    }

    char cmdBuf[CMD_MSG_LEN];
    if (cmdQueue != NULL && xQueueReceive(cmdQueue, cmdBuf, 0) == pdTRUE) {
        String cmd = String(cmdBuf);
        if (cmd == "__SERVO_HEAD_UP__") executeHeadMove(1);
        else if (cmd == "__SERVO_HEAD_DOWN__") executeHeadMove(-1);
        else if (cmd == "__SERVO_HEAD_CENTER__") executeHeadMove(0);
        else if (cmd == "__SERVO_LEG_LEFT__") executeLegMove(0);
        else if (cmd == "__SERVO_LEG_RIGHT__") executeLegMove(2);
        else if (cmd == "__SERVO_LEG_CENTER__") executeLegMove(1);
        else if (cmd.startsWith("__FACE_")) drawEyes(cmd);
        else if (cmd.startsWith("USER:")) {
            currentPage = MAIN_PAGE;
            showUserSpeechUI(cmd.substring(5));
        }
        else if (cmd.startsWith("AI:")) {
            currentPage = MAIN_PAGE;
            showAIReplyUI(cmd.substring(3));
            returnToReadyAt = millis() + 15000;  // giữ màn trả lời 15s cho dễ đọc
        }
        else if (cmd.startsWith("TEXT:")) {
            currentPage = MAIN_PAGE;
            showAIReplyUI(cmd.substring(5));
            returnToReadyAt = millis() + 15000;  // giữ màn trả lời 15s cho dễ đọc
        }
        // ==== [TFT PRO] lệnh UI đủ nếu nằm queue ====
        else if (cmd.startsWith("__MUSIC_INFO__")) {
            int bar = cmd.lastIndexOf('|');
            if (bar > 14) {
                musicTitle = cmd.substring(14, bar);
                musicDurS = cmd.substring(bar + 1).toInt();
            }
            showMusicUI();
        }
        else if (cmd == "__MUSIC_STOP__") {
            if (currentScreen == SCREEN_MUSIC) { showReadyUI(); returnToReadyAt = 0; }
        }
    }

    // Tự động trở về trạng thái Sẵn sàng sau khi hiển thị câu trả lời AI
    if (currentScreen == SCREEN_AI && returnToReadyAt > 0 && millis() > returnToReadyAt && !ttsPlaying) {
        returnToReadyAt = 0;
        showReadyUI();
    }

    // Chớp mắt KHÔNG chặn luồng (state machine, không delay):
    // vẽ mắt nhắm -> sau 140ms mở lại đúng biểu cảm đang giữ
    static bool blinkClosed = false;
    static unsigned long blinkStartedAt = 0;
    if (!ttsPlaying) {
        unsigned long now = millis();
        if (!blinkClosed && now - lastBlinkTime > random(3000, 8000)) {
            blinkClosed = true;
            blinkStartedAt = now;
            display.clearDisplay();
            display.fillRect(30, 32, 20, 2, SSD1306_WHITE);
            display.fillRect(80, 32, 20, 2, SSD1306_WHITE);
            display.display();
        } else if (blinkClosed && now - blinkStartedAt >= 140) {
            blinkClosed = false;
            lastBlinkTime = now;
            drawEyes(currentFace);
        }
        // Đôi mắt đi rảnh tự thay đổi biểu cảm (chỉ khi không chớp mắt
        // và KHÔNG ở màn AI reply - giữ đúng mood vừa chọn cho câu trả lời)
        if (!blinkClosed && currentScreen != SCREEN_AI && now - lastEyeMoveTime > random(10000, 20000)) {
            int chance = random(0, 3);
            if (chance == 0) drawEyes("__FACE_LISTEN__");
            else if (chance == 1) drawEyes("__FACE_THINK__");
            else drawEyes("__FACE_HAPPY__");
            lastEyeMoveTime = now;
        }
    }

    // Giữ BOOT 5s khi đang chạy: 3 chế độ khác nhau
    //  - giữ >=1.5s và <5s: TEST LOA - phát sine chuẩn 440Hz 3s sinh trực tiếp
    //    trên bo (KHÔNG qua server/WiFi/decode) - phân định cứng vs mềm:
    //      sine nghe SẠCH/tròn  -> phần cứng OK, nghi phần mềm
    //      sine cũng RÈ/nhiễu  -> phần cứng (dây I2S, nguồn, amp, loa)
    //  - giữ >=5s: force vào lại Setup (phone khác Wi-Fi)
    static unsigned long bootPressSince = 0;
    static bool bootTestPlayed = false;
    if (digitalRead(BOOT_BUTTON_PIN) == LOW) {
        if (bootPressSince == 0) { bootPressSince = millis(); bootTestPlayed = false; }
        else if (!bootTestPlayed && millis() - bootPressSince > 1500 && millis() - bootPressSince < 5000) {
            bootTestPlayed = true;
            Serial.println("[LOA TEST] Phat 3 tong 1kHz/2kHz/4kHz tong 2.5s TRUC TIEP tren bo (khong qua server):");
            Serial.println("[LOA TEST] - Nghie SACH + DU 2.5s = phan cung + dong ho I2S OK");
            Serial.println("[LOA TEST] - Keo dai qua 2.5s = phat cham, dong ho I2S sai");
            Serial.println("[LOA TEST] - Re/hut = day I2S / nguon / amp / loa");
            // vẽ nhãn trên TFT để anh biết đang test
            tft.fillScreen(TFT_BLACK);
            showTopStatusBar();
            tft.setTextDatum(MC_DATUM);
            tft.setTextColor(TFT_YELLOW);
            tft.setTextSize(2);
            tft.drawString("TEST LOA - 3 TONG (2.5s)", 160, 90);
            tft.setTextColor(TFT_WHITE);
            tft.setTextSize(1);
            tft.drawString("1kHz -> 2kHz -> 4kHz. Nghe SACH, DU 2.5s = cung OK", 160, 130);
            tft.drawString("Keo dai qua 2.5s = phat cham (dong ho I2S sai)", 160, 148);
            tft.drawString("Re / hut am = day I2S / nguon / amp / loa", 160, 164);
            tft.drawString("Cho 3 giay...", 160, 186);
            ttsPlaying = false;  // chặn speakerTask trộn nhạc cùng lúc
            // TEST 3 ÂM: 1kHz (1.0s) -> 2kHz (1.0s) -> 4kHz (0.5s) — tổng ĐÚNG 2.5s.
            //  - Nghe rõ 3 âm tăng dần, sạch:  phần cứng + nhịp phát OK
            //  - Nghe kéo dài quá 2.5s:        loa phát SLOWER -> đồng hồ I2S lỗi
            //  - Nghe rè/hụt:                  dây I2S / nguồn / amp / loa
            static int16_t sineOut[256];
            size_t written = 0;
            const float tones[3][2] = { {1000.0f, 1.0f}, {2000.0f, 1.0f}, {4000.0f, 0.5f} };
            unsigned long phaseIdx = 0;
            for (int ti = 0; ti < 3; ti++) {
                const float fHz = tones[ti][0];
                const int blocks = (int)(AMP_SAMPLE_RATE * tones[ti][1] / 128);
                const float step = 2.0f * PI * fHz / AMP_SAMPLE_RATE;
                for (int block = 0; block < blocks; block++) {
                    for (int s = 0; s < 128; s++) {
                        float v = 0.55f * sin(step * (phaseIdx++));
                        int16_t sample = (int16_t)(v * 32000);
                        sineOut[2 * s] = sample;
                        sineOut[2 * s + 1] = sample;
                    }
                    i2s_write(I2S_AMP_PORT, (const uint8_t *)sineOut, sizeof(sineOut), &written, portMAX_DELAY);
                }
                // ngắt 150ms giữa các âm để dễ tách 3 tông
                vTaskDelay(pdMS_TO_TICKS(150));
            }
            Serial.println("[LOA TEST] Hoan tat - nghe quay ve phan chinh");
            showReadyUI();
        }
        else if (millis() - bootPressSince > 5000) {
            Serial.println("[BOOT] Giu BOOT >=5 giay -> vao SETUP bang dien thoai");
            webSocket.disconnect();
            showPortalSplash();
            runSetupPortal(true);
            tryConnectWiFi(15000);
            connectWebSocket();
            bootPressSince = 0;
        }
    } else {
        bootPressSince = 0;
    }
}

// =========================================================================
// 17. NETWORK RECOVERY
// =========================================================================
void networkLoop() {
    unsigned long now = millis();

    static unsigned long lastWifiCheck = 0;
    if (now - lastWifiCheck > 5000) {
        lastWifiCheck = now;
        if (WiFi.status() != WL_CONNECTED) {
            wifiConnected = false;
            if (wsConnected) { webSocket.disconnect(); wsConnected = false; }
            serverStatusText = "WiFi: retry...";
            if (currentScreen != SCREEN_DISCONNECTED && currentScreen != SCREEN_SETTING) {
                showDisconnectedUI("WIFI_LOST");
            }
            if (!tryConnectWiFi(6000)) {
                // mất WiFi: mở portal chờ điện thoại xử lý
                showPortalSplash();
                runSetupPortal(true);
                tryConnectWiFi(15000);
                connectWebSocket();
            }
        }
    }

    static unsigned long lastWsCheck = 0;
    if (now - lastWsCheck > 4000) {
        lastWsCheck = now;
        if (!wsConnected && wifiConnected) {
            Serial.println("[WS] Thu ket noi lai server...");
            if (currentScreen != SCREEN_DISCONNECTED && currentScreen != SCREEN_SETTING) {
                showDisconnectedUI("SERVER_LOST");
            }
        }
    }

    if (protocolV2 && wsConnected && now - lastMetricsAt > 30000) {
        lastMetricsAt = now;
        sendProtocolMetrics();
    }
}
