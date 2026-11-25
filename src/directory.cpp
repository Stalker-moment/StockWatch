#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>

#include "directory.hpp"
#include "http.hpp"

#include <algorithm>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <map>
#include <stdexcept>

using nlohmann::json;
using namespace std::chrono_literals;

namespace {
json field(const json& item, const char* key, bool positive = false) {
    const auto it = item.find(key);
    if (it == item.end() || !it->is_number()) return nullptr;
    const double value = it->get<double>();
    return std::isfinite(value) && (!positive || value > 0) ? *it : json(nullptr);
}

std::string fieldText(const json& item, const char* key) {
    const auto it = item.find(key);
    return it != item.end() && it->is_string() ? it->get<std::string>() : "";
}

json loadCatalog() {
    wchar_t executable[32768];
    const auto length = GetModuleFileNameW(nullptr, executable, 32768);
    if (!length || length == 32768) throw std::runtime_error("Lokasi direktori IDX tidak diketahui");
    const auto root = std::filesystem::path(executable).parent_path().parent_path();
    std::ifstream stream(root / "data" / "idx-catalog.json");
    if (!stream) throw std::runtime_error("Direktori IDX daring dan katalog lokal tidak tersedia");
    auto data = json::parse(stream);
    data["offline"] = true;
    data["stale"] = true;
    return data;
}

json loadMarket() {
    const auto response = httpGet(L"pasardana.id", 443,
        "/api/StockSearchResult/GetAll?pageBegin=1&pageLength=1500&sortField=Code&sortOrder=ASC",
        true, 4 * 1024 * 1024);
    if (response.status != 200) throw std::runtime_error("Sumber direktori saham tidak tersedia");
    const auto payload = json::parse(response.body);
    if (!payload.is_array()) throw std::runtime_error("Format direktori saham berubah");

    std::map<std::string, json> byCode;
    std::string latest;
    for (const auto& item : payload) {
        std::string code;
        try {
            code = stockCode(fieldText(item, "Code"));
        } catch (const std::invalid_argument&) {
            continue;
        }
        const auto date = fieldText(item, "LastDate").substr(0, 10);
        const auto name = fieldText(item, "Name");
        const auto sector = fieldText(item, "NewSectorName");
        const auto price = field(item, "Last", true);
        const auto previous = field(item, "PrevClosingPrice", true);
        json change;
        if (price.is_number() && previous.is_number()) {
            change = (price.get<double>() / previous.get<double>() - 1) * 100;
        } else if (const auto day = field(item, "OneDay"); price.is_number() && day.is_number()) {
            change = day.get<double>() * 100;
        }
        if (price.is_number() && date > latest) latest = date;
        byCode[code] = {{"code", code}, {"name", name.empty() ? code : name}, {"sector", sector},
            {"price", price}, {"previous", previous}, {"changePercent", change}, {"date", date},
            {"open", field(item, "AdjustedOpenPrice", true)},
            {"high", field(item, "AdjustedHighPrice", true)}, {"low", field(item, "AdjustedLowPrice", true)},
            {"volume", field(item, "Volume")}, {"value", field(item, "Value")},
            {"cap", field(item, "Capitalization", true)}, {"per", field(item, "Per")},
            {"pbr", field(item, "Pbr")}, {"frequency", field(item, "Frequency")}};
    }
    // Endpoint ini mengembalikan seluruh direktori sekaligus. Respons parsial tidak menggantikan cache.
    if (byCode.size() < 500 || latest.empty()) throw std::runtime_error("Direktori saham tidak lengkap");

    json rows = json::array();
    for (auto& entry : byCode) rows.push_back(std::move(entry.second));
    return {{"source", "Pasardana"}, {"date", latest}, {"offline", false},
            {"stale", false}, {"stocks", std::move(rows)}};
}
}

json StockDirectory::snapshot() {
    const std::lock_guard<std::mutex> lock(mutex_);
    if (!last_.is_null() && std::chrono::steady_clock::now() < nextFetch_) return last_;
    try {
        last_ = loadMarket();
        nextFetch_ = std::chrono::steady_clock::now() + 60s;
    } catch (const std::exception&) {
        if (last_.is_null()) last_ = loadCatalog();
        last_["stale"] = true;
        nextFetch_ = std::chrono::steady_clock::now() + 45s;
    }
    return last_;
}
