// ============================================================================
// XIAOXI - TEST TFT ONLY (ESP32-S3)
// Khong WiFi, khong touch, khong mic, khong servo.
// Chi kiem tra TFT co hien thi mau duoc khong.
//
// TFT_eSPI lay cau hinh tu User_Setup.h cua thu vien.
// ============================================================================

#include <FS.h>
#include <TFT_eSPI.h>

TFT_eSPI tft = TFT_eSPI();

void setup() {
    Serial.begin(115200);
    delay(1200);

    Serial.println();
    Serial.println("============================================================");
    Serial.println(" XIAOXI TFT ONLY TEST - ESP32-S3");
    Serial.println("============================================================");
    Serial.printf("[TFT] MOSI=%d MISO=%d SCLK=%d CS=%d DC=%d RST=%d\n",
                  TFT_MOSI, TFT_MISO, TFT_SCLK, TFT_CS, TFT_DC, TFT_RST);
#if defined(ST7789_DRIVER)
    Serial.println("[TFT] Driver: ST7789");
#elif defined(ILI9341_DRIVER)
    Serial.println("[TFT] Driver: ILI9341");
#elif defined(ILI9341_2_DRIVER)
    Serial.println("[TFT] Driver: ILI9341_2");
#else
    Serial.println("[TFT] Driver: KHONG XAC DINH");
#endif
#if defined(TFT_BL) && (TFT_BL >= 0)
    pinMode(TFT_BL, OUTPUT);
    digitalWrite(TFT_BL, HIGH);
    Serial.printf("[TFT] Bat den nen BL=GPIO %d\n", TFT_BL);
#endif
    Serial.println("[TFT] Dang init...");

    tft.init();
    tft.setRotation(1);
    tft.fillScreen(TFT_RED);

    Serial.println("[TFT] init xong - phai thay mau DO");
    Serial.println("[TFT] Neu van trang: kiem tra RESET, VCC, CS, DC, MOSI, SCLK, LED");
}

void loop() {
    static const uint16_t colors[] = {
        TFT_RED, TFT_GREEN, TFT_BLUE, TFT_WHITE, TFT_BLACK
    };
    static const char *names[] = {
        "RED", "GREEN", "BLUE", "WHITE", "BLACK"
    };
    static uint8_t index = 0;

    uint16_t color = colors[index];
    uint16_t textColor = (color == TFT_WHITE) ? TFT_BLACK : TFT_WHITE;

    tft.fillScreen(color);
    tft.setTextDatum(MC_DATUM);
    tft.setTextColor(textColor, color);
    tft.setTextSize(3);
    tft.drawString(names[index], tft.width() / 2, tft.height() / 2);

    Serial.printf("[TFT] Mau %s\n", names[index]);
    index = (index + 1) % (sizeof(colors) / sizeof(colors[0]));
    delay(1500);
}
