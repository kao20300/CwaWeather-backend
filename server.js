require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

// CWA API 設定
// 使用 F-D0047-091 資料集，提供更細緻的鄉鎮預報 (通常是 3 或 6 小時一報)
const CWA_API_BASE_URL = "https://opendata.cwa.gov.tw/api";
const CWA_API_KEY = process.env.CWA_API_KEY;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/**
 * 取得後山 (臺東市) 天氣預報
 * CWA 氣象資料開放平臺 API
 * 使用「鄉鎮天氣預報-臺東縣 (F-D0047-091)」資料集，獲取更細緻的預報時間間隔。
 * 雖然此資料集是針對臺東縣所有鄉鎮，但我們只挑選「臺東市」的資料作為代表。
 */
const getTaitungWeather = async (req, res) => {
    try {
        // 檢查是否有設定 API Key
        if (!CWA_API_KEY) {
            return res.status(500).json({
                error: "伺服器設定錯誤",
                message: "請在 .env 檔案中設定 CWA_API_KEY",
            });
        }

        // 呼叫 CWA API - 鄉鎮天氣預報 (F-D0047-091)
        const response = await axios.get(
            `${CWA_API_BASE_URL}/v1/rest/datastore/F-D0047-091`,
            {
                params: {
                    Authorization: CWA_API_KEY,
                    // locationName 參數在此資料集不適用，我們手動從 response 中挑選臺東市
                },
            }
        );

        // 鄉鎮預報資料結構不同，需從 records.locations 中找到臺東縣
        const locationDataContainer = response.data.records.locations[0]; // 臺東縣
        
        if (!locationDataContainer || !locationDataContainer.location) {
             return res.status(404).json({
                error: "查無資料",
                message: "無法取得臺東縣鄉鎮天氣資料",
            });
        }

        // 預設取臺東縣下的第一個鄉鎮資料 (通常為臺東市)，以確保有數據
        const taitungCityData = locationDataContainer.location.find(
            (loc) => loc.locationName === "臺東市"
        ) || locationDataContainer.location[0];

        if (!taitungCityData) {
            return res.status(404).json({
                error: "查無資料",
                message: "無法取得臺東市天氣資料",
            });
        }

        // 整理天氣資料
        const weatherData = {
            city: taitungCityData.locationName,
            // 由於 F-D0047-091 沒有 datasetDescription，我們使用發布時間
            updateTime: response.data.records.issueTime || "未知發布時間",
            forecasts: [],
        };

        // 解析天氣要素
        const weatherElements = taitungCityData.weatherElement;
        
        // 使用 Wx (天氣現象) 來決定時間軸長度
        const wxElement = weatherElements.find(e => e.elementName === "Wx");
        if (!wxElement) throw new Error("缺少 Wx 天氣要素");

        const timeCount = wxElement.time.length;

        // 遍歷所有預報時間段 (通常是 3 或 6 小時為一個間隔)
        for (let i = 0; i < timeCount; i++) {
            const forecast = {
                startTime: wxElement.time[i].startTime,
                endTime: wxElement.time[i].endTime,
                weather: "",
                rain: "",
                minTemp: "", // F-D0047-091 通常只提供 T (單一溫度)
                maxTemp: "", // 我們將 T 同時用於 minTemp 和 maxTemp
                comfort: "",
                windSpeed: "",
            };

            weatherElements.forEach((element) => {
                const timeEntry = element.time[i];
                if (!timeEntry || !timeEntry.parameter) return;

                // F-D0047-091 的資料結構，數值通常在 parameterName 中
                let value = timeEntry.parameter.parameterName;

                switch (element.elementName) {
                    case "Wx": // 天氣現象
                        forecast.weather = value;
                        break;
                    case "PoP6h": // 6小時降雨機率 (較精細)
                        forecast.rain = value + "%";
                        break;
                    case "T": // 溫度
                        // 將單一溫度 T 設為 MinT 和 MaxT，以保持前端相容
                        forecast.minTemp = value + "°C";
                        forecast.maxTemp = value + "°C";
                        break;
                    case "CI": // 舒適度
                        forecast.comfort = value;
                        break;
                    case "Ws": // 平均風速
                        forecast.windSpeed = value;
                        break;
                }
            });
            
            // 如果 PoP6h 沒有數據，嘗試尋找 PoP12h (備用)
            if (!forecast.rain) {
                 const pop12hElement = weatherElements.find(e => e.elementName === "PoP12h");
                 if (pop12hElement && pop12hElement.time[i]) {
                     const popValue = pop12hElement.time[i].parameter.parameterName;
                     forecast.rain = popValue + "%";
                 } else {
                     forecast.rain = "0%"; // 找不到 PoP 則預設 0%
                 }
            }


            weatherData.forecasts.push(forecast);
        }

        res.json({
            success: true,
            data: weatherData,
        });
    } catch (error) {
        console.error("取得天氣資料失敗:", error.message);

        if (error.response) {
            // CWA API 回應錯誤
            return res.status(error.response.status).json({
                error: "CWA API 錯誤",
                message: error.response.data.message || "無法取得天氣資料",
                details: error.response.data,
            });
        }

        // 其他錯誤
        res.status(500).json({
            error: "伺服器錯誤",
            message: "無法取得天氣資料，請稍後再試",
        });
    }
};

// Routes
app.get("/", (req, res) => {
    res.json({
        message: "歡迎使用 CWA 天氣預報 API",
        endpoints: {
            taitung: "/api/weather/taitung",
            health: "/api/health",
        },
    });
});

app.get("/api/health", (req, res) => {
    res.json({ status: "OK", timestamp: new Date().toISOString() });
});

// 取得後山天氣預報
app.get("/api/weather/taitung", getTaitungWeather);

// Error handling middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({
        error: "伺服器錯誤",
        message: err.message,
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        error: "找不到此路徑",
    });
});

app.listen(PORT, () => {
    console.log(`🚀 伺服器運行已運作`);
    console.log(`📍 環境: ${process.env.NODE_ENV || "development"}`);
});