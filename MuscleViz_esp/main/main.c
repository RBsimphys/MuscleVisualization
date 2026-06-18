#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/event_groups.h"
#include "esp_wifi.h"
#include "esp_event.h"
#include "esp_log.h"
#include "nvs_flash.h"
#include "esp_http_client.h"
#include "esp_adc/adc_oneshot.h"

#define WIFI_SSID "Pixel 4a "
#define WIFI_PASS "lolola10"
#define SERVER_URL "http://10.68.171.136:3000/adc"

#define ADC_PIN ADC_CHANNEL_6
#define ADC_UNIT ADC_UNIT_1
#define ADC_BITWIDTH ADC_BITWIDTH_12
#define ADC_ATTEN ADC_ATTEN_DB_12

static EventGroupHandle_t wifi_events;
const int WIFI_CONNECTED = BIT0;

// wifi event handler
static void on_wifi_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START)
        esp_wifi_connect();
    else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP)
        xEventGroupSetBits(wifi_events, WIFI_CONNECTED);
    else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED)
        esp_wifi_connect(); // auto reconnect
}

// connect to wifi
void connect_wifi(void)
{
    wifi_events = xEventGroupCreate();
    nvs_flash_init();
    esp_netif_init();
    esp_event_loop_create_default();
    esp_netif_create_default_wifi_sta();

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    esp_wifi_init(&cfg);

    esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, on_wifi_event, NULL);
    esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, on_wifi_event, NULL);

    wifi_config_t wifi_config = {
        .sta = {
            .ssid = WIFI_SSID,
            .password = WIFI_PASS,
        }};

    esp_wifi_set_mode(WIFI_MODE_STA);
    esp_wifi_set_config(WIFI_IF_STA, &wifi_config);
    esp_wifi_start();

    // wait until connected
    xEventGroupWaitBits(wifi_events, WIFI_CONNECTED, false, true, portMAX_DELAY);
    ESP_LOGI("WIFI", "connected!");
}

// send adc value to server
void send_adc(int value)
{
    char body[32];
    snprintf(body, sizeof(body), "{\"value\":%d}", value);

    esp_http_client_config_t config = {.url = SERVER_URL};
    esp_http_client_handle_t client = esp_http_client_init(&config);

    esp_http_client_set_method(client, HTTP_METHOD_POST);
    esp_http_client_set_header(client, "Content-Type", "application/json");
    esp_http_client_set_post_field(client, body, strlen(body));

    esp_http_client_perform(client);
    esp_http_client_cleanup(client);
}

void app_main(void)
{
    connect_wifi();

    // setup ADC
    int adc_value;
    adc_oneshot_unit_handle_t adc_handle;
    adc_oneshot_unit_init_cfg_t init_config = {
        .unit_id = ADC_UNIT,
    };
    adc_oneshot_new_unit(&init_config, &adc_handle);

    adc_oneshot_chan_cfg_t config = {
        .bitwidth = ADC_BITWIDTH,
        .atten = ADC_ATTEN,
    };
    adc_oneshot_config_channel(adc_handle, ADC_PIN, &config);

    while (1)
    {
        adc_oneshot_read(adc_handle, ADC_PIN, &adc_value);
        ESP_LOGI("ADC", "%d", adc_value);
        send_adc(adc_value);
        vTaskDelay(pdMS_TO_TICKS(1)); // send every second
    }
}