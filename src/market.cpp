#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>

#include "market.hpp"
#include "chart_periods.hpp"
#include "http.hpp"

#include <algorithm>
#include <array>
#include <cctype>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <ctime>
#include <filesystem>
#include <fstream>
#include <future>
#include <iomanip>
#include <sstream>
#include <thread>
#include <vector>

using nlohmann::json;
using namespace std::chrono_literals;

namespace {
struct Sample {
    const char* code;
    const char* name;
    double price;
    double previous;
    long long volume;
};

constexpr Sample samples[] = {
    {"BBCA", "Bank Central Asia", 10000, 9800, 15000000},
    {"BBRI", "Bank Rakyat Indonesia", 4000, 3900, 32500000},
    {"BMRI", "Bank Mandiri", 5000, 5200, 17000000},
    {"TLKM", "Telkom Indonesia", 2500, 2550, 22000000},
    {"ASII", "Astra International", 4500, 4500, 11000000},
    {"GOTO", "GoTo Gojek Tokopedia", 70, 72, 210000000}
};

std::string lower(std::string value) {
    for (char& c : value) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    return value;
}

std::string nameOf(const json& entry, const std::string& longKey,
                   const std::string& shortKey, const std::string& fallback) {
    for (const auto& key : {longKey, shortKey}) {
        if (entry.contains(key) && entry[key].is_string()) {
            auto name = entry[key].get<std::string>();
            if (!name.empty()) return name;
        }
    }
    return fallback;
}

double numericField(const json& entry, const char* key) {
    if (!entry.contains(key) || !entry[key].is_number()) return 0;
    const auto number = entry[key].get<double>();
    return std::isfinite(number) ? number : 0;
}

json stockbitNumber(const json& row, const char* key) {
    const auto found = row.find(key);
    if (found == row.end()) return nullptr;
    if (found->is_number()) {
        return std::isfinite(found->get<double>()) ? *found : json(nullptr);
    }
    if (!found->is_string()) return nullptr;

    const auto text = trim(found->get<std::string>());
    try {
        std::size_t used = 0;
        const double number = std::stod(text, &used);
        if (used == text.size() && std::isfinite(number)) return number;
    } catch (const std::logic_error&) {
        // Data numerik yang kosong, tidak dikenal, atau di luar jangkauan dianggap hilang.
    }
    return nullptr;
}

struct StockbitTime {
    std::string date;
    json timestamp;
};

StockbitTime stockbitTime(const json& row) {
    const auto date = row.value("date", "");
    int day = 0;
    int year = 0;
    char monthText[4]{};
    if (std::sscanf(date.c_str(), "%d %3s %d", &day, monthText, &year) != 3 ||
        day < 1 || day > 31 || year < 1970 || year > 2100) return {};
    const std::array<std::string, 12> months{
        "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"
    };
    const auto month = std::find(months.begin(), months.end(), lower(monthText));
    if (month == months.end()) return {};

    std::tm local{};
    local.tm_year = year - 1900;
    local.tm_mon = static_cast<int>(month - months.begin());
    local.tm_mday = day;
    if (_mkgmtime64(&local) < 0 || local.tm_mday != day) return {};

    std::ostringstream isoDate;
    isoDate << std::put_time(&local, "%Y-%m-%d");
    const auto displayedTime = trim(row.value("time", ""));
    const auto clock = displayedTime.substr(displayedTime.find_last_of(' ') + 1);
    int chars = 0;
    if (std::sscanf(clock.c_str(), "%d:%d%n", &local.tm_hour, &local.tm_min, &chars) != 2 ||
        chars != static_cast<int>(clock.size()) || local.tm_hour < 0 ||
        local.tm_hour >= 24 || local.tm_min < 0 || local.tm_min >= 60) {
        return {isoDate.str(), nullptr};
    }
    return {isoDate.str(), _mkgmtime64(&local) - 7 * 60 * 60};
}

std::string stockbitBoard(const json& row) {
    for (const auto& notation : row.value("notation", json::array())) {
        if (notation.is_object() && notation.value("notation_code", "") == "X")
            return "Papan Pemantauan Khusus";
    }
    for (const auto& catalog : row.value("catalogs", json::array())) {
        if (catalog.is_object() && catalog.value("company_type", "") == "listing-board")
            return catalog.value("company_symbol", "");
    }
    return "";
}

int priceTick(long long price) {
    if (price < 200) return 1;
    if (price < 500) return 2;
    if (price < 2000) return 5;
    if (price < 5000) return 10;
    return 25;
}

void addPriceLimits(json& quote, const json& row) {
    const auto board = stockbitBoard(row);
    if (board.empty()) return;
    quote["board"] = board;
    const auto& reference = quote.at("previous");
    const auto date = quote.value("date", "");
    const auto corporateAction = row.find("corp_action");
    if (!reference.is_number() || (corporateAction != row.end() && corporateAction->is_object() &&
        corporateAction->value("active", false))) return;
    const auto previous = reference.get<double>();
    if (previous < 1 || previous > 100000000 || std::floor(previous) != previous) return;

    const bool monitored = board == "Papan Pemantauan Khusus";
    const bool special = monitored || board == "Papan Akselerasi";
    const bool regular = board == "Papan Utama" || board == "Papan Pengembangan" ||
                         board == "Papan Ekonomi Baru";
    // Kep-00158/BEI/10-2026 menetapkan ARB sementara sampai 31 Desember 2026.
    if ((!special && !regular) || date < "2026-10-20" || date > "2026-12-31") return;

    const auto base = static_cast<long long>(previous);
    const int rise = special ? 10 : base <= 200 ? 35 : base <= 5000 ? 25 : 20;
    const int fall = special ? 10 : 7;
    const auto ceiling = base <= 10 ? base + 1 : base * (100 + rise) / 100;
    const auto floor = std::max(1LL, base <= 10 || (regular && base <= 14)
        ? base - 1 : (base * (100 - fall) + 99) / 100);
    const int upperTick = priceTick(ceiling);
    const int lowerTick = priceTick(floor);
    quote["ara"] = ceiling / upperTick * upperTick;
    quote["arb"] = (floor + lowerTick - 1) / lowerTick * lowerTick;
}

json parseStockbit(const std::string& html, const std::string& code) {
    auto marker = html.find("id=\"__NEXT_DATA__\"");
    if (marker == std::string::npos) marker = html.find("id='__NEXT_DATA__'");
    if (marker == std::string::npos) return nullptr;
    const auto script = html.rfind("<script", marker);
    const auto begin = html.find('>', marker);
    if (script == std::string::npos || begin == std::string::npos ||
        html.find('>', script) != begin) return nullptr;
    const auto end = html.find("</script", begin + 1);
    if (end == std::string::npos) return nullptr;

    const auto body = json::parse(html.begin() + begin + 1, html.begin() + end);
    const auto& row = body.at("props").at("pageProps").at("company");
    if (row.value("symbol", "") != code || row.value("exchange", "") != "IDX") return nullptr;
    auto price = stockbitNumber(row, "price");
    if (!price.is_number() || price.get<double>() <= 0) price = stockbitNumber(row, "lastprice");
    if (!price.is_number() || price.get<double>() <= 0) return nullptr;

    auto previous = stockbitNumber(row, "previous");
    auto change = stockbitNumber(row, "change");
    auto percent = stockbitNumber(row, "percentage");
    if (previous.is_number() && previous.get<double>() > 0) {
        change = price.get<double>() - previous.get<double>();
        percent = change.get<double>() / previous.get<double>() * 100;
    } else {
        previous = nullptr;
    }
    const auto clock = stockbitTime(row);
    json open;
    std::string marketStatus;
    std::string marketTimeLeft;
    if (const auto market = row.find("market_hour"); market != row.end() && market->is_object()) {
        marketStatus = market->value("status", "");
        marketTimeLeft = market->value("formatted_time_left", "");
        if (!marketStatus.empty()) open = marketStatus == "open";
    }
    const bool index = code == ihsgCode;
    json quote = {{"code", code}, {"symbol", index ? ihsgSymbol : code + ".JK"},
        {"name", index ? ihsgName : row.value("name", code)},
        {"currency", "IDR"}, {"price", price}, {"previous", previous},
        {"change", change}, {"changePercent", percent},
        {"volume", index ? json(nullptr) : stockbitNumber(row, "volume")},
        {"marketTime", clock.timestamp}, {"date", clock.date}, {"timePrecision", "minute"},
        {"marketOpen", open}, {"marketStatus", marketStatus}, {"marketTimeLeft", marketTimeLeft},
        {"source", "Stockbit"}, {"demo", false}};
    if (index) {
        quote["kind"] = "index";
        return quote;
    }
    if (const auto book = row.find("orderbook"); book != row.end() && book->is_object()) {
        for (const auto side : {"bid", "offer"}) {
            const auto level = book->find(side);
            if (level == book->end() || !level->is_object()) continue;
            const auto levelPrice = stockbitNumber(*level, "price");
            if (levelPrice.is_number() && levelPrice.get<double>() > 0) quote[side] = levelPrice;
        }
    }
    addPriceLimits(quote, row);
    return quote;
}

json yahooChart(const std::string& symbol, const std::string& range,
                const char* interval = "1d", bool tryMirror = true) {
    constexpr std::array<const wchar_t*, 2> mirrors = {
        L"query1.finance.yahoo.com", L"query2.finance.yahoo.com"
    };
    const auto path = "/v8/finance/chart/" + encodeQuery(symbol) + "?range=" + range + "&interval=" + interval;
    int notFound = 0;
    const auto attempts = tryMirror ? mirrors.size() : 1;
    for (std::size_t i = 0; i < attempts; ++i) {
        const auto host = mirrors[i];
        try {
            const auto response = httpGet(host, 443, path, true);
            if (response.status == 404) {
                ++notFound;
                continue;
            }
            if (response.status != 200) continue;
            const auto payload = json::parse(response.body);
            const auto& chart = payload.at("chart").at("result").at(0);
            const auto& meta = chart.at("meta");
            if (meta.value("symbol", "") == symbol && meta.value("currency", "") == "IDR") return chart;
        } catch (const std::exception&) {
            // Penyedia memiliki dua host. Coba host lainnya jika hasilnya tidak dapat dipakai.
        }
    }
    if (notFound == static_cast<int>(attempts)) {
        throw MarketError(404, "Kode saham tidak ditemukan oleh penyedia");
    }
    throw MarketError(502, "Yahoo Finance belum menyediakan data saat ini");
}

std::string wibDate(std::time_t timestamp) {
    if (timestamp <= 0) return "";
    timestamp += 7 * 60 * 60;
    std::tm local{};
    if (gmtime_s(&local, &timestamp) != 0) return "";
    std::ostringstream isoDate;
    isoDate << std::put_time(&local, "%Y-%m-%d");
    return isoDate.str();
}

const json& savedIndex() {
    static const auto snapshot = [] {
        wchar_t executable[32768];
        const auto length = GetModuleFileNameW(nullptr, executable, 32768);
        if (!length || length == 32768) throw MarketError(502, "Lokasi snapshot IHSG tidak tersedia");
        const auto root = std::filesystem::path(executable).parent_path().parent_path();
        std::ifstream file(root / "data" / "ihsg.json");
        if (!file) throw MarketError(502, "Snapshot IHSG tidak tersedia");
        return json::parse(file);
    }();
    return snapshot;
}

json cachedIndex(json data, bool demo) {
    data["source"] = data.value("source", "Yahoo Finance") + " (snapshot)";
    data["snapshot"] = true;
    data["demo"] = demo;
    return data;
}

json liveQuote(const std::string& code) {
    const bool index = code == ihsgCode;
    const auto symbol = index ? ihsgSymbol : code + ".JK";
    const auto chart = yahooChart(symbol, "1d");
    const auto& meta = chart.at("meta");
    const double price = numericField(meta, "regularMarketPrice");
    if (price <= 0) throw MarketError(502, "Harga tidak tersedia dari penyedia saat ini");
    double previous = numericField(meta, "previousClose");
    if (previous <= 0) previous = numericField(meta, "chartPreviousClose");
    const auto time = meta.value("regularMarketTime", std::time_t{});
    const auto date = wibDate(time);
    json quote = {{"code", code}, {"symbol", symbol}, {"name", nameOf(meta, "longName", "shortName", code)},
        {"currency", "IDR"}, {"price", price},
        {"previous", previous > 0 ? json(previous) : json(nullptr)},
        {"change", previous > 0 ? json(price - previous) : json(nullptr)},
        {"changePercent", previous > 0 ? json((price / previous - 1) * 100) : json(nullptr)},
        {"volume", meta.value("regularMarketVolume", json(nullptr))},
        {"marketTime", time > 0 ? json(time) : json(nullptr)}, {"date", date},
        {"source", "Yahoo Finance"}, {"demo", false}};
    if (index) {
        quote["name"] = ihsgName;
        quote["kind"] = "index";
        quote["volume"] = nullptr;
    }
    if (!date.empty()) {
        const auto times = chart.find("timestamp");
        const auto indicators = chart.find("indicators");
        if (times != chart.end() && times->is_array() && !times->empty() &&
            times->back().is_number_integer() && wibDate(times->back().get<std::time_t>()) == date &&
            indicators != chart.end() && indicators->contains("quote") && !indicators->at("quote").empty()) {
            const auto& day = indicators->at("quote").at(0);
            for (const auto key : {"open", "high", "low"}) {
                const auto values = day.find(key);
                if (values == day.end() || !values->is_array() || values->size() != times->size()) continue;
                const auto& value = values->back();
                if (value.is_number() && value.get<double>() > 0) quote[key] = value;
            }
        }
        for (const auto& key : {std::pair{"high", "regularMarketDayHigh"}, {"low", "regularMarketDayLow"}}) {
            const auto value = numericField(meta, key.second);
            if (value > 0) quote[key.first] = value;
        }
    }
    return quote;
}

json sampleQuote(const Sample& sample) {
    return {{"code", sample.code}, {"symbol", std::string(sample.code) + ".JK"},
            {"name", sample.name}, {"currency", "IDR"}, {"price", sample.price},
            {"previous", sample.previous}, {"change", sample.price - sample.previous},
            {"changePercent", (sample.price / sample.previous - 1) * 100},
            {"volume", sample.volume}, {"marketTime", nullptr}, {"source", "Data demo"},
            {"date", ""}, {"demo", true}};
}

json chartBars(const json& chart, int secondsPerBar) {
    const auto times = chart.find("timestamp");
    if (times == chart.end() || !times->is_array()) return json::array();
    const auto marketTime = chart.at("meta").value("regularMarketTime", std::time_t{});
    const bool intraday = secondsPerBar < 86400;
    const auto& series = chart.at("indicators").at("quote").at(0);
    const auto& opens = series.at("open");
    const auto& highs = series.at("high");
    const auto& lows = series.at("low");
    const auto& closes = series.at("close");
    const auto& volumes = series.at("volume");
    const auto count = std::min({times->size(), opens.size(), highs.size(), lows.size(),
                                  closes.size(), volumes.size()});
    json bars = json::array();
    std::time_t last = 0;
    for (std::size_t i = 0; i < count; ++i) {
        if (!times->at(i).is_number_integer() || !opens[i].is_number() || !highs[i].is_number() ||
            !lows[i].is_number() || !closes[i].is_number()) continue;
        const auto time = times->at(i).get<std::time_t>();
        // Yahoo dapat menambahkan titik kuotasi mentah yang bukan bagian dari seri candle.
        const bool weeklyTail = secondsPerBar > 86400 && time == marketTime && last &&
                                time - last < 5 * 86400;
        if (time <= last || weeklyTail || (intraday && time % secondsPerBar != 0)) continue;
        const auto low = lows[i].get<double>(), high = highs[i].get<double>();
        const auto open = opens[i].get<double>(), close = closes[i].get<double>();
        if (low <= 0 || open < low || open > high || close < low || close > high) continue;
        bars.push_back({{"t", time}, {"o", open}, {"h", high}, {"l", low}, {"c", close}, {"v", volumes[i]}});
        last = time;
    }
    return bars;
}

json optionalBars(const std::string& code, const char* interval) {
    try {
        const auto symbol = code == ihsgCode ? std::string(ihsgSymbol) : code + ".JK";
        const auto source = yahooChart(symbol, "1d", interval, false);
        return chartBars(source, interval[1] == 'm' ? 60 : 86400);
    } catch (const std::exception&) {
        return json::array();
    }
}

json intradayAverage(const json& minutes, const std::string& date) {
    double volume = 0, weighted = 0;
    std::time_t through = 0;
    for (const auto& bar : minutes) {
        const auto minute = bar.at("t").get<std::time_t>();
        const auto shares = numericField(bar, "v");
        if (shares <= 0 || wibDate(minute) != date) continue;
        volume += shares;
        weighted += (numericField(bar, "h") + numericField(bar, "l") + numericField(bar, "c")) / 3 * shares;
        through = minute;
    }
    if (volume > 0 && std::isfinite(weighted))
        return {{"date", date}, {"average", weighted / volume}, {"through", through}};
    return nullptr;
}

json historySession(const std::string& code, const ChartPeriod& period, const json& bars,
                    const std::string& date) {
    json session = {{"date", date}, {"ohlc", nullptr}, {"intraday", nullptr}};
    if (date.empty()) return session;
    const std::string interval = period.interval;
    if (interval == "1d") {
        if (wibDate(bars.back().at("t").get<std::time_t>()) == date) session["ohlc"] = bars.back();
    } else if (interval == "1m") {
        const auto daily = optionalBars(code, "1d");
        if (!daily.empty() && wibDate(daily.back().at("t").get<std::time_t>()) == date)
            session["ohlc"] = daily.back();
    } else {
        auto task = std::async(std::launch::async, optionalBars, code, "1d");
        session["intraday"] = intradayAverage(optionalBars(code, "1m"), date);
        const auto daily = task.get();
        if (!daily.empty() && wibDate(daily.back().at("t").get<std::time_t>()) == date)
            session["ohlc"] = daily.back();
        return session;
    }
    session["intraday"] = interval == "1m" ? intradayAverage(bars, date) :
        intradayAverage(optionalBars(code, "1m"), date);
    return session;
}
}

json Market::directory() {
    if (!demo_) return directory_.snapshot();

    json rows = json::array();
    constexpr const char* sectors[] = {"Keuangan", "Keuangan", "Keuangan",
        "Infrastruktur", "Perindustrian", "Teknologi"};
    std::size_t index = 0;
    for (const auto& sample : samples) {
        auto row = sampleQuote(sample);
        row["sector"] = sectors[index++];
        row["open"] = sample.previous;
        row["high"] = std::max(sample.price, sample.previous) * 1.01;
        row["low"] = std::min(sample.price, sample.previous) * 0.99;
        row["value"] = sample.price * static_cast<double>(sample.volume);
        rows.push_back(std::move(row));
    }
    return {{"source", "Data demo"}, {"date", ""}, {"offline", false},
            {"stale", false}, {"stocks", std::move(rows)}};
}

json Market::stockbitQuote(const std::string& code) {
    std::chrono::steady_clock::time_point waitUntil{};
    {
        const std::lock_guard<std::mutex> lock(stockbitMutex_);
        const auto now = std::chrono::steady_clock::now();
        if (now < stockbitBackoff_) return nullptr;
        const auto slot = std::max(now, stockbitSlot_);
        if (slot - now > 3500ms) return nullptr;
        stockbitSlot_ = slot + 400ms;
        waitUntil = slot;
    }
    if (const auto now = std::chrono::steady_clock::now(); waitUntil > now) {
        std::this_thread::sleep_until(waitUntil);
        const std::lock_guard<std::mutex> lock(stockbitMutex_);
        if (std::chrono::steady_clock::now() < stockbitBackoff_) return nullptr;
    }

    try {
        const auto response = httpGet(L"stockbit.com", 443, "/symbol/" + code, true,
                                      1024 * 1024, L"text/html");
        if (response.status == 403 || response.status == 429) {
            const std::lock_guard<std::mutex> lock(stockbitMutex_);
            stockbitBackoff_ = std::chrono::steady_clock::now() + 90s;
        }
        if (response.status == 200) return parseStockbit(response.body, code);
    } catch (const std::exception&) {
        // Kegagalan mengambil atau membaca halaman publik tidak menghentikan sumber cadangan.
    }
    return nullptr;
}

json Market::quote(const std::string& symbol) {
    const auto code = instrumentCode(symbol);
    const bool index = code == ihsgCode;
    if (demo_) {
        if (index) return cachedIndex(savedIndex().at("quote"), true);
        for (const auto& sample : samples) {
            if (code == sample.code) return sampleQuote(sample);
        }
        throw MarketError(404, "Kode tidak ada dalam dataset demo");
    }

    {
        const std::lock_guard<std::mutex> lock(cacheMutex_);
        const auto entry = cache_.find(code);
        if (entry != cache_.end() &&
            std::chrono::steady_clock::now() - entry->second.fetched <
                (entry->second.quote.value("source", "") == "Stockbit" ? 6s : 12s)) {
            return entry->second.quote;
        }
    }

    auto result = stockbitQuote(code);
    if (result.is_null()) try {
        result = liveQuote(code);
    } catch (const MarketError&) {
        if (index) return cachedIndex(savedIndex().at("quote"), false);
        const auto snapshot = directory();
        for (const auto& row : snapshot.at("stocks")) {
            if (row.at("code") != code || !row.value("price", json(nullptr)).is_number()) continue;
            result = row;
            result["symbol"] = code + ".JK";
            result["currency"] = "IDR";
            result["source"] = snapshot.value("source", "Pasardana");
            result["demo"] = false;
            result["marketTime"] = nullptr;
            const auto previous = row.value("previous", json(nullptr));
            result["change"] = previous.is_number()
                ? json(row.at("price").get<double>() - previous.get<double>()) : json(nullptr);
            break;
        }
        if (result.is_null()) throw;
    }
    result["fetchedAt"] = std::time(nullptr);
    {
        const std::lock_guard<std::mutex> lock(cacheMutex_);
        cache_[code] = {result, std::chrono::steady_clock::now()};
    }
    return result;
}

json Market::search(const std::string& query) {
    const auto filter = lower(trim(query));
    if (filter.size() < 2 || filter.size() > 64) {
        throw std::invalid_argument("Kata kunci harus 2 sampai 64 karakter");
    }
    const auto snapshot = directory();
    json results = json::array();
    const std::string indexSearch = "ihsg ^jkse idx composite indeks harga saham gabungan";
    if (indexSearch.find(filter) != std::string::npos)
        results.push_back({{"code", ihsgCode}, {"name", ihsgName}, {"kind", "index"}});
    for (const auto& row : snapshot.at("stocks")) {
        const auto code = lower(row.at("code").get<std::string>());
        const auto name = lower(row.at("name").get<std::string>());
        if (code.find(filter) != std::string::npos || name.find(filter) != std::string::npos) {
            results.push_back({{"code", row.at("code")}, {"name", row.at("name")}});
        }
    }
    std::stable_sort(results.begin(), results.end(), [&filter](const auto& a, const auto& b) {
        const auto rank = [&filter](const auto& row) {
            const auto code = lower(row.at("code").template get<std::string>());
            if (code == filter) return 0;
            if (code.find(filter) == 0) return 1;
            return 2;
        };
        return rank(a) < rank(b);
    });
    if (results.size() > 30) results.erase(results.begin() + 30, results.end());
    return results;
}

namespace {
bool validTradeTime(const std::string& value) {
    if (value.size() != 8 || value[2] != ':' || value[5] != ':') return false;
    for (const auto i : {0, 1, 3, 4, 6, 7}) {
        if (value[i] < '0' || value[i] > '9') return false;
    }
    return value <= "23:59:59" && value[3] <= '5' && value[6] <= '5';
}

json tradeRows(const json& payload) {
    const auto& data = payload.at("data");
    if (!data.is_array()) throw std::invalid_argument("Format transaksi berubah");
    std::vector<json> trades;
    for (const auto& trade : data) {
        if (!trade.is_object()) continue;
        const auto text = [&](const char* key) {
            const auto found = trade.find(key);
            return found != trade.end() && found->is_string() ? found->get<std::string>() : "";
        };
        const auto time = text("time");
        const auto price = numericField(trade, "price");
        const auto volume = numericField(trade, "volume");
        if (!validTradeTime(time) || price <= 0 || volume <= 0) continue;
        const auto side = text("type");
        trades.push_back({{"time", time}, {"price", price}, {"shares", volume},
            {"side", side == "BUY" || side == "SELL" ? side : "--"},
            {"board", text("board")}, {"buyer", text("buyer")}, {"seller", text("seller")}});
    }
    if (!data.empty() && trades.empty()) throw std::invalid_argument("Format transaksi berubah");
    std::stable_sort(trades.begin(), trades.end(), [](const auto& a, const auto& b) {
        return a.at("time") > b.at("time");
    });
    return trades;
}
}

json Market::trades(const std::string& symbol) {
    const auto code = instrumentCode(symbol);
    if (code == ihsgCode) throw MarketError(400, "Running Trade tersedia untuk saham");
    if (demo_) throw MarketError(503, "Running Trade tersedia di mode pasar");
    const auto env = std::getenv("INVEZGO_API_KEY");
    const std::string token = env ? env : "";
    if (token.empty()) throw MarketError(503, "Running Trade perlu INVEZGO_API_KEY");
    if (token.size() > 512 || std::any_of(token.begin(), token.end(), [](unsigned char c) { return c <= 32 || c >= 127; }))
        throw MarketError(503, "Format INVEZGO_API_KEY tidak valid");

    const auto date = wibDate(std::time(nullptr));
    const auto key = code + date;
    const std::lock_guard<std::mutex> lock(tradesMutex_);
    const auto now = std::chrono::steady_clock::now();
    if (const auto cached = tradePages_.find(key); cached != tradePages_.end() &&
        now - cached->second.fetched < 10s) return cached->second.quote;
    if (now < retryTrades_) throw MarketError(tradesStatus_, tradesError_);

    HttpResponse response{};
    try {
        response = httpGet(L"api.invezgo.com", 443,
            "/analysis/running-trade/" + code + "?date=" + date + "&limit=100&sort=DESC",
            true, 1024 * 1024, L"application/json", std::wstring(token.begin(), token.end()));
    } catch (const std::exception&) {
        throw MarketError(502, "Invezgo tidak dapat dihubungi");
    }
    if (response.status != 200) {
        if (response.status == 401) tradesError_ = "API key Invezgo ditolak";
        else if (response.status == 402 || response.status == 403)
            tradesError_ = "Akses atau kuota Running Trade Invezgo belum tersedia";
        else if (response.status == 429) tradesError_ = "Batas permintaan Invezgo tercapai";
        else throw MarketError(502, "Data Running Trade belum tersedia dari Invezgo");
        tradesStatus_ = static_cast<int>(response.status);
        retryTrades_ = std::chrono::steady_clock::now() + std::chrono::seconds(
            response.status == 429 ? std::max(60UL, response.retryAfter) : 60UL);
        throw MarketError(tradesStatus_, tradesError_);
    }
    try {
        auto trades = tradeRows(json::parse(response.body));
        json result = {{"code", code}, {"date", date}, {"source", "Invezgo"},
            {"fetchedAt", std::time(nullptr)}, {"trades", std::move(trades)}};
        if (tradePages_.size() >= 64 && tradePages_.find(key) == tradePages_.end()) {
            const auto oldest = std::min_element(tradePages_.begin(), tradePages_.end(),
                [](const auto& a, const auto& b) { return a.second.fetched < b.second.fetched; });
            tradePages_.erase(oldest);
        }
        tradePages_[key] = {result, std::chrono::steady_clock::now()};
        return result;
    } catch (const std::exception&) {
        throw MarketError(502, "Format Running Trade Invezgo berubah");
    }
}

json Market::history(const std::string& symbol, const std::string& range) {
    const auto code = instrumentCode(symbol);
    const bool index = code == ihsgCode;
    const auto period = std::find_if(chartPeriods.begin(), chartPeriods.end(),
        [&](const auto& option) { return range == option.range; });
    if (period == chartPeriods.end()) {
        throw std::invalid_argument("Rentang tersedia: 1d, 5d, 1mo, 3mo, 6mo, ytd, 1y, 5y");
    }
    if (demo_) {
        if (index) return cachedIndex(savedIndex().at("history").at(range), true);
        const auto sample = quote(code);
        const auto price = sample.at("price").get<double>();
        const int length = period->demoBars;
        const int step = period->secondsPerBar;
        json bars = json::array();
        constexpr std::time_t marketOpen = 1795572000; // 25 November 2026 pukul 09.00 WIB
        constexpr int demoDays[] = {6, 5, 2, 1, 0};
        for (int i = 0; i < length; ++i) {
            std::time_t time;
            if (range == "1d") time = marketOpen + i * step + (i >= 180 ? 5400 : 0);
            else if (range == "5d") {
                const int slot = i % 24;
                time = marketOpen - demoDays[i / 24] * 86400 + slot * step + (slot >= 12 ? 5400 : 0);
            } else time = marketOpen - (length - 1 - i) * static_cast<std::time_t>(step);
            const double close = (i == length - 1) ? price :
                price * (0.94 + 0.06 * i / (length - 1) + 0.05 * std::sin(i * 0.7 + code[0]));
            const double open = close * (1 + 0.012 * std::cos(i * 1.1));
            const auto volume = sample.at("volume").get<long long>() / (step < 86400 ? length : 1);
            bars.push_back({{"t", time}, {"o", open}, {"h", std::max(open, close) * 1.012},
                            {"l", std::min(open, close) * 0.989}, {"c", close},
                            {"v", volume * (i % 9 + 1) / 5}});
        }
        return {{"code", code}, {"range", range}, {"interval", period->interval},
                {"source", "Data demo"}, {"bars", std::move(bars)}, {"price", price},
                {"marketTime", nullptr}, {"changePercent", sample.at("changePercent")}};
    }

    const auto key = code + range;
    {
        const std::lock_guard<std::mutex> lock(cacheMutex_);
        const auto entry = histories_.find(key);
        if (entry != histories_.end() && std::chrono::steady_clock::now() - entry->second.fetched < 60s)
            return entry->second.quote;
    }
    json chart, bars;
    try {
        chart = yahooChart(index ? ihsgSymbol : code + ".JK", range, period->interval);
        bars = chartBars(chart, period->secondsPerBar);
        if (bars.empty()) throw MarketError(502, "Belum ada candle untuk periode ini");
    } catch (const std::exception&) {
        if (index) return cachedIndex(savedIndex().at("history").at(range), false);
        throw;
    }
    const auto& meta = chart.at("meta");
    const auto price = numericField(meta, "regularMarketPrice");
    const auto time = meta.value("regularMarketTime", std::time_t{});
    const auto date = wibDate(time);

    json session = {{"ohlc", nullptr}, {"intraday", nullptr}};
    if (!date.empty()) {
        json stored;
        {
            const std::lock_guard<std::mutex> lock(cacheMutex_);
            const auto entry = sessionStats_.find(code);
            if (entry != sessionStats_.end() && entry->second.quote.value("date", "") == date &&
                std::chrono::steady_clock::now() - entry->second.fetched < 60s) stored = entry->second.quote;
        }
        if (stored.is_null()) {
            if (index) {
                stored = {{"date", date}, {"ohlc", nullptr}, {"intraday", nullptr}};
                if (std::string(period->interval) == "1d") {
                    if (wibDate(bars.back().at("t").get<std::time_t>()) == date) stored["ohlc"] = bars.back();
                } else {
                    const auto daily = optionalBars(code, "1d");
                    if (!daily.empty() && wibDate(daily.back().at("t").get<std::time_t>()) == date)
                        stored["ohlc"] = daily.back();
                }
            } else {
                stored = historySession(code, *period, bars, date);
            }
            const std::lock_guard<std::mutex> lock(cacheMutex_);
            sessionStats_[code] = {stored, std::chrono::steady_clock::now()};
        }
        session = std::move(stored);
    }
    json result = {{"code", code}, {"range", range}, {"interval", period->interval},
        {"source", "Yahoo Finance"}, {"bars", std::move(bars)}, {"session", session["ohlc"]},
        {"intraday", session["intraday"]}, {"price", price > 0 ? json(price) : json(nullptr)},
        {"marketTime", time > 0 ? json(time) : json(nullptr)},
        {"changePercent", meta.value("regularMarketChangePercent", json(nullptr))}};
    {
        const std::lock_guard<std::mutex> lock(cacheMutex_);
        histories_[key] = {result, std::chrono::steady_clock::now()};
    }
    return result;
}
