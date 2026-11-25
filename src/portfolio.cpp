#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>

#include "portfolio.hpp"
#include "http.hpp"

#include <algorithm>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <sstream>

using nlohmann::json;

namespace {
constexpr int sharesPerLot = 100;

std::filesystem::path dataPath(bool demo) {
    return demo ? L"stockwatch-demo.json" : L"stockwatch-data.json";
}

std::string decimal(double value) {
    std::ostringstream out;
    out << std::fixed << std::setprecision(2) << (value == 0 ? 0 : value);
    auto text = out.str();
    text[text.find('.')] = ',';
    return text;
}
}

double positionValue(const Position& position, double price) {
    return position.lots * sharesPerLot * price;
}

ScenarioResult simulate(const Position& position, double price, double percent) {
    const double current = positionValue(position, price);
    const double projected = current * (1 + percent / 100);
    return {current, projected, projected - current};
}

std::string money(double amount) {
    std::ostringstream stream;
    stream << std::fixed << std::setprecision(0) << std::fabs(amount);
    const auto digits = stream.str();
    std::string result;
    for (std::size_t i = 0; i < digits.size(); ++i) {
        if (i > 0 && (digits.size() - i) % 3 == 0) result += '.';
        result += digits[i];
    }
    return (std::round(amount) < 0 ? "-Rp" : "Rp") + result;
}

std::string indexPoints(double value) {
    const auto cents = std::llround(std::abs(value) * 100);
    const auto integer = money(static_cast<double>(cents / 100)).substr(2);
    return std::string(value < 0 && cents ? "-" : "") + integer + "," +
           (cents % 100 < 10 ? "0" : "") + std::to_string(cents % 100);
}

std::string percentText(double amount, bool signedValue) {
    return (signedValue && amount > 0 ? "+" : "") + decimal(amount) + "%";
}

TerminalData loadData(bool demo) {
    auto path = dataPath(demo);
    if (!std::filesystem::exists(path)) {
        // Mendukung file dari versi sebelumnya (PantauSaham / nabung).
        path = demo ? L"pantau-demo.json" : L"pantau-data.json";
        if (!std::filesystem::exists(path)) {
            path = demo ? L"nabung-demo.json" : L"nabung-data.json";
            if (!std::filesystem::exists(path)) return {};
        }
    }
    std::ifstream stream(path);
    if (!stream) throw std::runtime_error("File data tidak bisa dibuka");
    const auto data = json::parse(stream);
    const auto& watchlist = data.at("watchlist");
    const auto& positions = data.at("positions");
    if (!watchlist.is_array() || !positions.is_array() ||
        watchlist.size() > maxStocks || positions.size() > maxStocks) {
        throw std::runtime_error("Format file data tidak valid");
    }

    TerminalData result;
    for (const auto& entry : watchlist) {
        const auto code = stockCode(entry.get<std::string>());
        if (std::find(result.watchlist.begin(), result.watchlist.end(), code) != result.watchlist.end()) {
            throw std::runtime_error("File data berisi kode watchlist ganda");
        }
        result.watchlist.push_back(code);
    }
    for (const auto& entry : positions) {
        const auto code = stockCode(entry.at("code").get<std::string>());
        const auto& lots = entry.at("lots");
        const double buyPrice = entry.at("buyPrice").get<double>();
        if (!lots.is_number_integer() || lots.get<double>() < 1 || lots.get<double>() > 100000 ||
            !std::isfinite(buyPrice) || buyPrice <= 0 || buyPrice > 1000000000 ||
            std::any_of(result.positions.begin(), result.positions.end(),
                        [&code](const auto& position) { return position.code == code; })) {
            throw std::runtime_error("Posisi dalam file data tidak valid");
        }
        result.positions.push_back({code, lots.get<int>(), buyPrice});
    }
    if (const auto alertsIt = data.find("alerts"); alertsIt != data.end() && alertsIt->is_array()) {
        for (const auto& entry : *alertsIt) {
            if (!entry.is_object() || result.alerts.size() >= maxAlerts) continue;
            try {
                const auto code = stockCode(entry.at("code").get<std::string>());
                const double target = entry.at("target").get<double>();
                const bool above = entry.value("above", true);
                const bool triggered = entry.value("triggered", false);
                if (!std::isfinite(target) || target <= 0 || target > 1000000000) continue;
                result.alerts.push_back({code, target, above, triggered});
            } catch (const std::exception&) {
                // Abaikan entri alert yang tidak valid.
            }
        }
    }
    return result;
}

void saveData(const TerminalData& data, bool demo) {
    json positions = json::array();
    for (const auto& position : data.positions) {
        positions.push_back({{"code", position.code}, {"lots", position.lots},
                             {"buyPrice", position.buyPrice}});
    }
    json alerts = json::array();
    for (const auto& alert : data.alerts) {
        alerts.push_back({{"code", alert.code}, {"target", alert.target},
                          {"above", alert.above}, {"triggered", alert.triggered}});
    }
    const auto path = dataPath(demo);
    auto temporary = path;
    temporary += L".tmp";
    std::ofstream stream(temporary, std::ios::trunc);
    stream << json{{"watchlist", data.watchlist}, {"positions", positions}, {"alerts", alerts}}.dump(2) << '\n';
    stream.close();
    if (!stream || !MoveFileExW(temporary.c_str(), path.c_str(),
                               MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
        throw std::runtime_error("File data gagal disimpan");
    }
}
