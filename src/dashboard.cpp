#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <conio.h>

#include "dashboard.hpp"
#include "chart_periods.hpp"
#include "http.hpp"

#include <algorithm>
#include <array>
#include <cctype>
#include <chrono>
#include <cmath>
#include <ctime>
#include <iomanip>
#include <iostream>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <sstream>
#include <thread>

namespace {
using nlohmann::json;
using Clock = std::chrono::steady_clock;
using namespace std::chrono_literals;

constexpr auto reset = "\x1b[0m";
constexpr auto cyan = "\x1b[38;5;81m";
constexpr auto teal = "\x1b[38;5;43m";
constexpr auto green = "\x1b[38;5;84m";
constexpr auto red = "\x1b[38;5;210m";
constexpr auto amber = "\x1b[38;5;221m";
constexpr auto muted = "\x1b[38;5;247m";
constexpr auto grid = "\x1b[38;5;240m";
constexpr auto white = "\x1b[1;97m";
constexpr auto bar = "\x1b[48;5;17m";
constexpr auto stripe = "\x1b[48;5;233m";
constexpr auto activeTab = "\x1b[48;5;25m";
constexpr auto highlight = "\x1b[48;5;24m";
constexpr auto marketInterval = 30s;
constexpr auto historyInterval = 60s;
constexpr auto quoteInterval = 8s;
constexpr auto watchInterval = 15s;
constexpr auto tradeInterval = 10s;

class Screen {
public:
    Screen() {
        active_ = GetConsoleMode(input_, &inputMode_) &&
                  GetConsoleMode(output_, &originalMode_) &&
                  SetConsoleMode(output_, originalMode_ | ENABLE_VIRTUAL_TERMINAL_PROCESSING);
        if (active_) {
            SetConsoleMode(input_, inputMode_ & ~ENABLE_PROCESSED_INPUT);
            GetConsoleTitleW(title_, static_cast<DWORD>(std::size(title_)));
            SetConsoleTitleW(L"StockWatch | IDX");
            std::cout << "\x1b[?1049h\x1b[?7l\x1b[?25l\x1b[2J" << std::flush;
        }
    }

    ~Screen() {
        if (!active_) return;
        std::cout << reset << "\x1b[?7h\x1b[?25h\x1b[?1049l" << std::flush;
        SetConsoleMode(output_, originalMode_);
        SetConsoleMode(input_, inputMode_);
        if (title_[0]) SetConsoleTitleW(title_);
    }

    bool active() const { return active_; }

    COORD size() const {
        CONSOLE_SCREEN_BUFFER_INFO info{};
        if (!GetConsoleScreenBufferInfo(output_, &info)) return {80, 24};
        return {static_cast<SHORT>(info.srWindow.Right - info.srWindow.Left + 1),
                static_cast<SHORT>(info.srWindow.Bottom - info.srWindow.Top + 1)};
    }

private:
    HANDLE input_ = GetStdHandle(STD_INPUT_HANDLE);
    HANDLE output_ = GetStdHandle(STD_OUTPUT_HANDLE);
    DWORD inputMode_ = 0;
    DWORD originalMode_ = 0;
    wchar_t title_[1024]{};
    bool active_ = false;
};

std::string clip(const std::string& value, int cells, bool pad = false) {
    // Teks dari penyedia dipotong per karakter UTF-8 dan tidak boleh mengirim kontrol terminal.
    std::string output;
    int count = 0;
    for (std::size_t i = 0; i < value.size() && count < cells; ++count) {
        const auto first = i++;
        while (i < value.size() && (static_cast<unsigned char>(value[i]) & 0xC0) == 0x80) ++i;
        const auto byte = static_cast<unsigned char>(value[first]);
        if (byte < 32 || byte == 127 || (byte == 0xC2 && i - first == 2 &&
            static_cast<unsigned char>(value[first + 1]) < 0xA0)) output += ' ';
        else output.append(value, first, i - first);
    }
    if (pad && cells > count) output.append(cells - count, ' ');
    return output;
}

std::string lower(std::string text) {
    for (char& c : text) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    return text;
}

std::optional<double> number(const json& item, const char* key) {
    const auto found = item.find(key);
    if (found == item.end() || !found->is_number()) return std::nullopt;
    const auto value = found->get<double>();
    return std::isfinite(value) ? std::optional<double>(value) : std::nullopt;
}

std::string timeText(std::time_t timestamp, const char* format) {
    if (!timestamp) return "--";
    timestamp += 7 * 60 * 60;
    const auto* time = std::gmtime(&timestamp);
    if (!time) return "--";
    std::ostringstream result;
    result << std::put_time(time, format);
    return result.str();
}

std::time_t timestamp(const json& item, const char* key) {
    const auto value = item.find(key);
    return value != item.end() && value->is_number_integer() ? value->get<std::time_t>() : 0;
}

std::string sessionDate(const json& quote) {
    const auto date = quote.value("date", "");
    if (!date.empty()) return date;
    const auto time = timestamp(quote, "marketTime");
    return time ? timeText(time, "%Y-%m-%d") : "";
}

std::string compact(double value) {
    const char* units[] = {"", "K", "M", "B", "T"};
    int unit = 0;
    while (std::abs(value) >= 1000 && unit < 4) {
        value /= 1000;
        ++unit;
    }
    std::ostringstream out;
    out << std::fixed << std::setprecision(unit ? 1 : 0) << value << units[unit];
    return out.str();
}

std::string priceText(const std::optional<double>& price, bool index = false) {
    return price ? (index ? indexPoints(*price) : money(*price)) : "--";
}
std::string dailyText(const std::optional<double>& value) { return value ? percentText(*value) : "--"; }
std::string quantityText(const std::optional<double>& value) { return value ? compact(*value) : "--"; }

std::string ratioText(const std::optional<double>& value) {
    if (!value) return "--";
    std::ostringstream out;
    out << std::fixed << std::setprecision(2) << *value << 'x';
    auto text = out.str();
    std::replace(text.begin(), text.end(), '.', ',');
    return text;
}

const char* changeColor(const std::optional<double>& value) {
    if (!value || *value == 0) return muted;
    return *value > 0 ? green : red;
}

struct Stock {
    std::string code, name, sector, date, search;
    std::optional<double> price, previous, change, open, high, low, volume, value, cap, per, pbr;

    explicit Stock(const json& item)
        : code(item.at("code").get<std::string>()), name(item.value("name", code)),
          sector(item.value("sector", "")), date(item.value("date", "")),
          search(lower(code + " " + name + " " + sector)),
          price(number(item, "price")), previous(number(item, "previous")),
          change(number(item, "changePercent")), open(number(item, "open")),
          high(number(item, "high")), low(number(item, "low")), volume(number(item, "volume")),
          value(number(item, "value")), cap(number(item, "cap")), per(number(item, "per")),
          pbr(number(item, "pbr")) {}
};

struct MarketData {
    std::map<std::string, Stock> rows;
    std::vector<std::string> sectors;
    std::string source, date;
    bool stale = false, offline = false;
    int rising = 0, falling = 0, flat = 0;
    double turnover = 0;

    void apply(const json& data) {
        MarketData next;
        next.source = data.at("source").get<std::string>();
        next.date = data.value("date", "");
        next.stale = data.value("stale", false);
        next.offline = data.value("offline", false);
        for (const auto& entry : data.at("stocks")) {
            Stock row(entry);
            if (!row.sector.empty() &&
                std::find(next.sectors.begin(), next.sectors.end(), row.sector) == next.sectors.end()) {
                next.sectors.push_back(row.sector);
            }
            if (row.price && row.change && (!next.date.empty() ? row.date == next.date : !next.offline)) {
                if (*row.change > 0) ++next.rising;
                else if (*row.change < 0) ++next.falling;
                else ++next.flat;
                next.turnover += row.value.value_or(0);
            }
            auto code = row.code;
            next.rows.emplace(std::move(code), std::move(row));
        }
        std::sort(next.sectors.begin(), next.sectors.end());
        *this = std::move(next);
    }
};

struct Result {
    json data;
    std::string error;
};

struct Pending {
    std::mutex mutex;
    std::optional<Result> result;
};

std::shared_ptr<Pending> launch(ApiLoader load, std::string path) {
    auto work = std::make_shared<Pending>();
    std::thread([work, load, path = std::move(path)] {
        Result result;
        try {
            result.data = load(path);
        } catch (const std::exception& error) {
            result.error = error.what();
        }
        const std::lock_guard<std::mutex> lock(work->mutex);
        work->result = std::move(result);
    }).detach();
    return work;
}

std::optional<Result> take(std::shared_ptr<Pending>& work) {
    if (!work) return std::nullopt;
    std::optional<Result> result;
    {
        const std::lock_guard<std::mutex> lock(work->mutex);
        if (work->result) result = std::move(work->result);
    }
    if (result) work.reset();
    return result;
}

struct Candle {
    std::time_t time;
    double open, high, low, close, volume;
};

std::vector<Candle> compress(const json& bars, int width) {
    std::vector<Candle> points;
    const auto count = bars.size();
    const auto groups = std::min<std::size_t>(count, width);
    for (std::size_t i = 0; i < groups; ++i) {
        const auto begin = i * count / groups;
        const auto end = (i + 1) * count / groups;
        const auto& first = bars.at(begin);
        Candle point{first.at("t").get<std::time_t>(), first.at("o").get<double>(),
                     first.at("h").get<double>(), first.at("l").get<double>(),
                     bars.at(end - 1).at("c").get<double>(), number(first, "v").value_or(0)};
        for (auto j = begin + 1; j < end; ++j) {
            point.high = std::max(point.high, bars.at(j).at("h").get<double>());
            point.low = std::min(point.low, bars.at(j).at("l").get<double>());
            point.volume += number(bars.at(j), "v").value_or(0);
        }
        points.push_back(point);
    }
    return points;
}

using PaneLine = std::string;

PaneLine plain(std::string value, int width, const char* color = "") {
    return std::string(color) + clip(value, width, true) + reset;
}

PaneLine rule(const std::string& title, int width) {
    std::string line;
    for (int i = static_cast<int>(title.size()) + 3; i < width; ++i) line += "─";
    return std::string(grid) + "╭─ " + teal + title + grid + line + reset;
}

enum class Indicator { none, ma5, ma20, prev };

std::vector<PaneLine> chart(const json& bars, int width, int height, const ChartPeriod& period,
                            bool index, Indicator indicator, std::optional<double> prevClose) {
    const int axis = index ? 11 : 9;
    const int plotWidth = width - axis;
    const auto points = compress(bars, plotWidth);
    std::vector<PaneLine> lines;
    if (points.empty()) return lines;

    double low = points.front().low;
    double high = points.front().high;
    double maxVolume = 0;
    for (const auto& point : points) {
        low = std::min(low, point.low);
        high = std::max(high, point.high);
        maxVolume = std::max(maxVolume, point.volume);
    }
    const bool showPrev = indicator == Indicator::prev && prevClose && *prevClose > 0;
    if (showPrev) {
        low = std::min(low, *prevClose);
        high = std::max(high, *prevClose);
    }
    std::vector<std::optional<double>> ma(points.size());
    const std::size_t maWindow = indicator == Indicator::ma5 ? 5 : indicator == Indicator::ma20 ? 20 : 0;
    if (maWindow > 0 && points.size() >= maWindow) {
        double sum = 0;
        for (std::size_t i = 0; i < points.size(); ++i) {
            sum += points[i].close;
            if (i >= maWindow) sum -= points[i - maWindow].close;
            if (i + 1 >= maWindow) ma[i] = sum / static_cast<double>(maWindow);
        }
    }
    const bool showVolume = height >= 8 && maxVolume > 0;
    if (showVolume) --height;
    const auto x = [&](std::size_t index) {
        return points.size() == 1 ? plotWidth / 2 :
            static_cast<int>(index * (plotWidth - 1) / (points.size() - 1));
    };
    if (high == low) high += std::max(1.0, high * 0.01);
    const auto y = [=](double price) {
        return std::clamp(static_cast<int>(std::lround((high - price) / (high - low) * (height - 1))),
                          0, height - 1);
    };
    const int prevRow = showPrev ? y(*prevClose) : -1;
    const char* maColor = indicator == Indicator::ma5 ? cyan : amber;

    for (int row = 0; row < height; ++row) {
        const bool guide = row == 0 || row == height / 2 || row == height - 1;
        const bool isPrevRow = row == prevRow;
        const auto mark = high - (high - low) * row / (height - 1);
        const auto label = guide ? (index ? indexPoints(mark) : compact(mark)) : "";
        std::string line = std::string(muted) + clip(label, axis - 1, true) + "│" + grid;
        int column = 0;
        const auto advance = [&line, &column, guide, isPrevRow](int until) {
            for (; column < until; ++column) {
                if (isPrevRow) line += std::string(amber) + "┄" + grid;
                else line += guide ? "·" : " ";
            }
        };
        for (std::size_t i = 0; i < points.size(); ++i) {
            const auto target = x(i);
            advance(target);
            const auto& point = points[i];
            const auto bodyTop = y(std::max(point.open, point.close));
            const auto bodyBottom = y(std::min(point.open, point.close));
            const auto color = point.close >= point.open ? green : red;
            if (row >= bodyTop && row <= bodyBottom) line += std::string(color) + "█" + grid;
            else if (row >= y(point.high) && row <= y(point.low)) line += std::string(color) + "│" + grid;
            else if (ma[i] && y(*ma[i]) == row) line += std::string(maColor) + "─" + grid;
            else if (isPrevRow) line += std::string(amber) + "┄" + grid;
            else line += guide ? "·" : " ";
            ++column;
        }
        advance(plotWidth);
        lines.push_back(line + reset);
    }
    if (showVolume) {
        const char* levels[] = {" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"};
        std::string line = std::string(muted) + clip("VOL", axis - 1, true) + "│" + teal;
        int column = 0;
        for (std::size_t i = 0; i < points.size(); ++i) {
            const auto target = x(i);
            line.append(target - column, ' ');
            const auto level = std::clamp(static_cast<int>(std::ceil(points[i].volume / maxVolume * 8)), 0, 8);
            line += levels[level];
            column = target + 1;
        }
        line.append(plotWidth - column, ' ');
        lines.push_back(line + reset);
    }

    const auto format = period.secondsPerBar == 60 ? "%H:%M" :
        period.secondsPerBar < 86400 ? "%d/%m %H:%M" : "%d/%m/%y";
    const auto first = timeText(bars.front().at("t").get<std::time_t>(), format);
    const auto last = timeText(bars.back().at("t").get<std::time_t>(), format);
    std::string axisText(width, ' ');
    if (first == last) {
        axisText.replace(std::clamp(axis + x(0) - static_cast<int>(first.size()) / 2,
                                    0, width - static_cast<int>(first.size())), first.size(), first);
    } else {
        axisText.replace(0, first.size(), first);
        axisText.replace(width - last.size(), last.size(), last);
        if (points.size() >= 4) {
            const auto middle = timeText(points[points.size() / 2].time, format);
            const int start = axis + x(points.size() / 2) - static_cast<int>(middle.size()) / 2;
            if (middle != first && middle != last && start > static_cast<int>(first.size()) &&
                start + static_cast<int>(middle.size() + last.size()) < width)
                axisText.replace(start, middle.size(), middle);
        }
    }
    lines.push_back(plain(axisText, width, muted));
    return lines;
}

enum class View { market, watch };
enum class Panel { overview, detail, trades };
enum class Order { code, gain, loss, value };

class Desk {
public:
    Desk(TerminalData& data, bool demo, ApiLoader load)
        : data_(data), demo_(demo), load_(load) {}

    DashboardExit run(Screen& screen);

private:
    struct History {
        Result result;
        Clock::time_point expires;
    };
    struct Quote {
        json data;
        std::string error;
        std::optional<double> move;
        Clock::time_point flashUntil{}, next{};
    };

    TerminalData& data_;
    bool demo_;
    ApiLoader load_;
    MarketData market_;
    View view_ = View::market;
    Order order_ = Order::code;
    std::vector<std::string> visible_;
    std::size_t selected_ = 0, top_ = 0;
    std::string filter_, input_, searchOrigin_, notice_, marketError_, pendingKey_;
    std::string sector_, alertInput_;
    Panel panel_ = Panel::overview;
    Indicator indicator_ = Indicator::none;
    bool editing_ = false, editingAlert_ = false, redraw_ = true, paused_ = false, pickingRange_ = false, loadPeriod_ = false;
    int range_ = defaultChartPeriod, pageSize_ = 5;
    std::time_t refreshed_ = 0;
    Clock::time_point nextMarket_{}, nextWatch_{}, nextFrame_{}, selectAfter_{};
    std::shared_ptr<Pending> marketWork_, watchWork_, historyWork_, quoteWork_;
    std::string quoteCode_;
    std::map<std::string, History> histories_;
    std::map<std::string, Quote> quotes_;
    std::shared_ptr<Pending> tradesWork_;
    std::string tradesCode_, pendingTradesCode_;
    Result tradesPage_;
    Clock::time_point nextTrades_{};

    void changeRange(int range, Clock::time_point now);
    void updateTrades(Clock::time_point now, const std::string& code);
    std::vector<PaneLine> tradeTape(int width, int limit) const;

    std::string selection() const;
    const Stock* find(const std::string& code) const;
    const Quote* quote(const std::string& code) const;
    void checkAlerts(const std::string& code, double price);
    void ingestQuote(const std::string& code, Result result, Clock::time_point now);
    void acceptQuote(Result result, Clock::time_point now);
    void alertKey(int key);
    void cycleSector();
    std::string marketStatusLabel() const;
    std::string historyKey() const;
    View activeView() const { return editing_ ? View::market : view_; }
    void rebuild(std::optional<std::string> preferred = std::nullopt);
    void searchKey(int key);
    void tick(Clock::time_point now);
    void switchView(View view);
    void openDetail();
    void move(int delta);
    void toggleWatch();
    PaneLine boardRow(const Stock* row, const std::string& code, int width, bool selected, bool alternate) const;
    std::vector<PaneLine> detail(int width, int limit) const;
    void draw(COORD size, Clock::time_point now);
};

std::string Desk::selection() const {
    return selected_ < visible_.size() ? visible_[selected_] : "";
}

const Stock* Desk::find(const std::string& code) const {
    static const Stock index(json{{"code", ihsgCode}, {"name", ihsgName}, {"sector", "Indeks IDX"}});
    if (code == ihsgCode) return &index;
    const auto it = market_.rows.find(code);
    return it == market_.rows.end() ? nullptr : &it->second;
}

const Desk::Quote* Desk::quote(const std::string& code) const {
    const auto it = quotes_.find(code);
    return it == quotes_.end() ? nullptr : &it->second;
}

void Desk::checkAlerts(const std::string& code, double price) {
    bool changed = false;
    for (auto& alert : data_.alerts) {
        if (alert.triggered || alert.code != code) continue;
        const bool hit = alert.above ? price >= alert.target : price <= alert.target;
        if (!hit) continue;
        alert.triggered = true;
        changed = true;
        notice_ = "ALERT " + code + (alert.above ? " >= " : " <= ") + money(alert.target) +
                  " (kini " + money(price) + ")";
        std::cout << '\a' << std::flush;
    }
    if (changed) {
        try {
            saveData(data_, demo_);
        } catch (const std::exception&) {
            // Tetap tampilkan notifikasi alert di sesi ini.
        }
    }
}

void Desk::ingestQuote(const std::string& code, Result result, Clock::time_point now) {
    if (quotes_.size() >= 64 && quotes_.find(code) == quotes_.end()) {
        const auto oldest = std::min_element(quotes_.begin(), quotes_.end(),
            [](const auto& a, const auto& b) { return a.second.next < b.second.next; });
        quotes_.erase(oldest);
    }

    auto& state = quotes_[code];
    state.next = now + (code == ihsgCode && selection() != ihsgCode ? 15s : quoteInterval);
    state.error = std::move(result.error);
    const auto incoming = number(result.data, "price");
    if (!state.error.empty()) return;
    if (!incoming || *incoming <= 0 || result.data.value("code", "") != code) {
        state.error = "Kuotasi tidak lengkap";
        return;
    }
    if (demo_ || result.data.value("marketOpen", json(nullptr)) == false) {
        state.next = now + 30s;
    }

    const auto source = result.data.value("source", "");
    if (!state.data.is_null()) {
        const auto previousSource = state.data.value("source", "");
        const auto previousTime = timestamp(state.data, "marketTime");
        const auto incomingTime = timestamp(result.data, "marketTime");
        if ((incomingTime && previousTime && incomingTime < previousTime) ||
            (previousSource == "Stockbit" && source != "Stockbit" && !incomingTime &&
             sessionDate(result.data) <= sessionDate(state.data))) {
            state.error = "Kuotasi pengganti lebih lama";
            return;
        }
        const bool sameFetch = source == previousSource &&
            timestamp(result.data, "fetchedAt") == timestamp(state.data, "fetchedAt");
        if (!sameFetch) {
            const auto previous = number(state.data, "price");
            state.move.reset();
            state.flashUntil = {};
            if (previous && source == previousSource && sessionDate(result.data) == sessionDate(state.data)) {
                state.move = *incoming - *previous;
                if (*state.move != 0) state.flashUntil = now + 4s;
            }
        }
    }
    state.data = std::move(result.data);
    checkAlerts(code, *incoming);
}

void Desk::acceptQuote(Result result, Clock::time_point now) {
    ingestQuote(quoteCode_, std::move(result), now);
}

void Desk::cycleSector() {
    if (market_.sectors.empty()) {
        sector_.clear();
        return;
    }
    if (sector_.empty()) {
        sector_ = market_.sectors.front();
    } else {
        const auto it = std::find(market_.sectors.begin(), market_.sectors.end(), sector_);
        if (it == market_.sectors.end() || it + 1 == market_.sectors.end()) sector_.clear();
        else sector_ = *(it + 1);
    }
    selected_ = top_ = 0;
    visible_.clear();
    rebuild();
}

std::string Desk::marketStatusLabel() const {
    const auto inspect = [](const Quote* q) -> std::string {
        if (!q || q->data.is_null()) return "";
        const auto status = q->data.value("marketStatus", "");
        if (status == "open") return "BUKA";
        if (status == "break") return "ISTIRAHAT";
        if (status == "closed" || status == "close") return "TUTUP";
        if (q->data.contains("marketOpen") && q->data["marketOpen"].is_boolean()) {
            return q->data["marketOpen"].get<bool>() ? "BUKA" : "TUTUP";
        }
        return "";
    };
    if (auto s = inspect(quote(ihsgCode)); !s.empty()) return s;
    if (auto s = inspect(quote(selection())); !s.empty()) return s;
    return "";
}

void Desk::alertKey(int key) {
    if (key == 27) {
        editingAlert_ = false;
        alertInput_.clear();
        return;
    }
    if ((key == 8 || key == 127) && !alertInput_.empty()) {
        alertInput_.pop_back();
        return;
    }
    if (key == 13) {
        editingAlert_ = false;
        const auto code = selection();
        auto raw = trim(alertInput_);
        alertInput_.clear();
        if (code.empty() || code == ihsgCode) {
            notice_ = "Price alert tersedia untuk emiten saham";
            return;
        }
        auto updated = data_;
        if (raw.empty()) {
            const auto before = updated.alerts.size();
            updated.alerts.erase(std::remove_if(updated.alerts.begin(), updated.alerts.end(),
                [&code](const auto& a) { return a.code == code; }), updated.alerts.end());
            if (updated.alerts.size() == before) {
                notice_ = "Tidak ada alert aktif untuk " + code;
                return;
            }
            try {
                saveData(updated, demo_);
                data_ = std::move(updated);
                notice_ = "Alert " + code + " dihapus";
            } catch (const std::exception& error) {
                notice_ = error.what();
            }
            return;
        }
        std::optional<bool> above;
        if (raw[0] == '>' || raw[0] == '<') {
            above = raw[0] == '>';
            raw.erase(raw.begin());
            if (!raw.empty() && raw[0] == '=') raw.erase(raw.begin());
            raw = trim(raw);
        }
        std::replace(raw.begin(), raw.end(), ',', '.');
        std::istringstream stream(raw);
        double target = 0;
        char extra = 0;
        if (!(stream >> target) || (stream >> extra) || !std::isfinite(target) || target <= 0 || target > 1000000000) {
            notice_ = "Format alert tidak valid (contoh >6000 atau <5500)";
            return;
        }
        if (!above) {
            const auto* q = quote(code);
            const auto* row = find(code);
            const auto currentPrice = q && !q->data.is_null() ? number(q->data, "price")
                : row ? row->price : std::nullopt;
            above = !currentPrice || target >= *currentPrice;
        }
        if (updated.alerts.size() >= maxAlerts) {
            notice_ = "Alert penuh (maksimal " + std::to_string(maxAlerts) + ")";
            return;
        }
        updated.alerts.push_back({code, target, *above, false});
        try {
            saveData(updated, demo_);
            data_ = std::move(updated);
            notice_ = "Alert disimpan: " + code + (*above ? " >= " : " <= ") + money(target);
        } catch (const std::exception& error) {
            notice_ = error.what();
        }
        return;
    }
    if (key >= 32 && key <= 126 && alertInput_.size() < 24) {
        alertInput_ += static_cast<char>(key);
    }
}

std::string Desk::historyKey() const {
    const auto code = selection();
    return code.empty() ? "" : code + chartPeriods[range_].range;
}

void Desk::rebuild(std::optional<std::string> preferred) {
    const auto previous = selection();
    const auto keep = preferred.value_or(previous);
    const auto view = activeView();
    auto query = view == View::market ? lower(trim(editing_ ? input_ : filter_)) : "";
    if (query.size() == 7 && query.substr(4) == ".jk") query.resize(4);
    std::vector<std::string> terms;
    if (!query.empty()) {
        auto words = query;
        for (char& c : words) {
            if (!std::isalnum(static_cast<unsigned char>(c))) c = ' ';
        }
        std::istringstream input(words);
        for (std::string word; input >> word;) terms.push_back(word);
        if (std::any_of(terms.begin(), terms.end(), [](const auto& term) {
            return term != "pt" && term != "tbk";
        })) {
            terms.erase(std::remove_if(terms.begin(), terms.end(), [](const auto& term) {
                return term == "pt" || term == "tbk";
            }), terms.end());
        }
    }

    visible_.clear();
    if (view == View::market) {
        for (const auto& [code, row] : market_.rows) {
            if (!sector_.empty() && row.sector != sector_) continue;
            const auto matches = [&row](const auto& term) {
                return row.search.find(term) != std::string::npos;
            };
            if (std::all_of(terms.begin(), terms.end(), matches)) visible_.push_back(code);
        }
    } else {
        visible_ = data_.watchlist;
    }

    if (view == View::market && !terms.empty() && (editing_ || order_ == Order::code)) {
        const auto rank = [this, &query](const auto& code) {
            const auto ticker = lower(code);
            if (ticker == query) return 0;
            if (ticker.find(query) == 0) return 1;
            if (lower(market_.rows.at(code).name).find(query) == 0) return 2;
            return 3;
        };
        std::stable_sort(visible_.begin(), visible_.end(), [&rank](const auto& a, const auto& b) {
            return rank(a) < rank(b);
        });
    } else if (order_ == Order::code) {
        std::sort(visible_.begin(), visible_.end());
    } else {
        const auto score = [this](const std::string& code) -> std::optional<double> {
            const auto* row = find(code);
            if (!row || (!market_.date.empty() && row->date != market_.date)) return std::nullopt;
            return order_ == Order::value ? row->value : row->change;
        };
        std::sort(visible_.begin(), visible_.end(), [this, &score](const auto& a, const auto& b) {
            const auto x = score(a);
            const auto y = score(b);
            if (x.has_value() != y.has_value()) return x.has_value();
            if (!x || *x == *y) return a < b;
            return order_ == Order::loss ? *x < *y : *x > *y;
        });
    }

    const std::string indexSearch = "ihsg jkse idx composite indeks harga saham gabungan";
    if (view == View::market && sector_.empty() && std::all_of(terms.begin(), terms.end(),
        [&indexSearch](const auto& term) { return indexSearch.find(term) != std::string::npos; }))
        visible_.insert(visible_.begin(), ihsgCode);

    const auto found = std::find(visible_.begin(), visible_.end(), keep);
    selected_ = found == visible_.end() ? 0 : static_cast<std::size_t>(found - visible_.begin());
    if (top_ > selected_) top_ = selected_;
    if (selection() != previous) selectAfter_ = Clock::now() + 250ms;
    redraw_ = true;
}

void Desk::searchKey(int key) {
    if (key == 27) {
        editing_ = false;
        rebuild(searchOrigin_);
    } else if (key == 13) {
        editing_ = false;
        filter_ = trim(input_);
        view_ = View::market;
        rebuild();
    } else if ((key == 8 || key == 127) && !input_.empty()) {
        input_.pop_back();
        rebuild(std::string{});
    } else if (key >= 32 && key <= 126 && input_.size() < 50) {
        input_ += static_cast<char>(key);
        rebuild(std::string{});
    }
}

void Desk::changeRange(int range, Clock::time_point now) {
    range_ = range;
    selectAfter_ = now;
    loadPeriod_ = true;
}

void Desk::updateTrades(Clock::time_point now, const std::string& code) {
    if (auto result = take(tradesWork_)) {
        if (pendingTradesCode_ == code) {
            if (result->error.empty() || tradesCode_ != code || tradesPage_.data.is_null())
                tradesPage_ = std::move(*result);
            else tradesPage_.error = result->error;
            tradesCode_ = code;
            nextTrades_ = now + (tradesPage_.error.empty() ? tradeInterval : 25s);
        }
        redraw_ = true;
    }
    if (!tradesWork_ && panel_ == Panel::trades && !editing_ && !paused_ &&
        !code.empty() && code != ihsgCode && now >= selectAfter_ && (tradesCode_ != code || now >= nextTrades_)) {
        pendingTradesCode_ = code;
        tradesWork_ = launch(load_, "/stocks/" + code + "/trades");
        redraw_ = true;
    }
}

void Desk::tick(Clock::time_point now) {
    if (auto result = take(quoteWork_)) {
        acceptQuote(std::move(*result), now);
        redraw_ = true;
    }
    const auto code = selection();
    updateTrades(now, code);
    if (!quoteWork_ && !paused_ && !editing_) {
        const auto due = [&](const std::string& symbol) {
            const auto* current = quote(symbol);
            return !current || now >= current->next;
        };
        const auto requestCode = !code.empty() && now >= selectAfter_ && due(code) ? code :
            due(ihsgCode) ? ihsgCode : "";
        if (!requestCode.empty()) {
            quoteCode_ = requestCode;
            quoteWork_ = launch(load_, "/stocks/" + requestCode);
            redraw_ = true;
        }
    }
    if (auto result = take(watchWork_)) {
        if (result->error.empty() && result->data.is_array()) {
            for (const auto& item : result->data) {
                if (!item.is_object() || item.contains("error")) continue;
                const auto rowCode = item.value("code", "");
                if (!rowCode.empty()) ingestQuote(rowCode, {item, ""}, now);
            }
        }
        redraw_ = true;
    }
    if (!watchWork_ && !paused_ && !editing_ && !editingAlert_ && activeView() == View::watch &&
        !data_.watchlist.empty() && now >= nextWatch_) {
        std::string codes;
        for (const auto& item : data_.watchlist) {
            if (!codes.empty()) codes += ',';
            codes += item;
        }
        watchWork_ = launch(load_, "/stocks/compare?codes=" + encodeQuery(codes));
        const auto marketState = marketStatusLabel();
        nextWatch_ = now + (marketState == "TUTUP" || marketState == "ISTIRAHAT" ? 30s : watchInterval);
        redraw_ = true;
    }
    if (auto result = take(marketWork_)) {
        marketError_ = result->error;
        if (marketError_.empty()) {
            try {
                market_.apply(result->data);
                refreshed_ = std::time(nullptr);
                rebuild();
            } catch (const json::exception&) {
                marketError_ = "Format direktori pasar tidak dikenali";
            }
        }
        redraw_ = true;
    }
    if (auto result = take(historyWork_)) {
        auto existing = histories_.find(pendingKey_);
        if (!result->error.empty() && existing != histories_.end() && !existing->second.result.data.is_null()) {
            existing->second.result.error = result->error;
            existing->second.expires = now + historyInterval;
        } else {
            if (histories_.size() >= 64 && existing == histories_.end()) {
                const auto oldest = std::min_element(histories_.begin(), histories_.end(),
                    [](const auto& a, const auto& b) { return a.second.expires < b.second.expires; });
                histories_.erase(oldest);
            }
            histories_[pendingKey_] = {std::move(*result), now + historyInterval};
        }
        redraw_ = true;
    }
    if (!marketWork_ && !paused_ && now >= nextMarket_) {
        marketWork_ = launch(load_, "/stocks/directory");
        nextMarket_ = now + marketInterval;
        redraw_ = true;
    }
    const auto requestKey = historyKey();
    if (!historyWork_ && (!paused_ || loadPeriod_) && !editing_ && panel_ != Panel::trades &&
        !requestKey.empty() && now >= selectAfter_) {
        const auto existing = histories_.find(requestKey);
        if (existing == histories_.end() || existing->second.expires <= now) {
            pendingKey_ = requestKey;
            historyWork_ = launch(load_, "/stocks/" + selection() + "/history?range=" + chartPeriods[range_].range);
            redraw_ = true;
        }
        loadPeriod_ = false;
    }
}

void Desk::switchView(View view) {
    panel_ = Panel::overview;
    if (view_ == view) return;
    view_ = view;
    visible_.clear();
    selected_ = top_ = 0;
    notice_.clear();
    rebuild();
}

void Desk::openDetail() {
    if (selection().empty()) {
        notice_ = "Pilih emiten untuk membuka detail";
        return;
    }
    panel_ = Panel::detail;
    notice_.clear();
}

void Desk::move(int delta) {
    if (visible_.empty()) return;
    const auto before = selected_;
    selected_ = static_cast<std::size_t>(std::clamp(
        static_cast<int>(selected_) + delta, 0, static_cast<int>(visible_.size()) - 1));
    if (before != selected_) {
        selectAfter_ = Clock::now() + 250ms;
        notice_.clear();
        redraw_ = true;
    }
}

void Desk::toggleWatch() {
    const auto code = selection();
    if (code.empty()) return;
    if (code == ihsgCode) {
        notice_ = "IHSG selalu ada di tab Pasar";
        return;
    }
    try {
        auto updated = data_;
        auto& watch = updated.watchlist;
        const auto found = std::find(watch.begin(), watch.end(), code);
        if (found == watch.end()) {
            if (watch.size() >= maxStocks) {
                notice_ = "Watchlist penuh (maksimal 8 saham)";
                return;
            }
            watch.push_back(code);
            notice_ = code + " masuk watchlist";
        } else {
            watch.erase(found);
            notice_ = code + " keluar dari watchlist";
        }
        saveData(updated, demo_);
        data_ = std::move(updated);
        if (view_ == View::watch) rebuild();
    } catch (const std::exception& error) {
        notice_ = error.what();
    }
}

PaneLine Desk::boardRow(const Stock* row, const std::string& code, int width,
                        bool selected, bool alternate) const {
    const auto background = selected ? highlight : alternate ? stripe : "";
    const bool saved = std::find(data_.watchlist.begin(), data_.watchlist.end(), code) != data_.watchlist.end();
    const bool hasName = width >= 47;
    const bool extra = width >= 60;
    const int nameWidth = hasName ? width - (extra ? 45 : 32) : 0;
    const int tailWidth = width - 32 - nameWidth;
    const bool index = code == ihsgCode;
    const auto* current = index || activeView() == View::watch || (selected && !editing_) ? quote(code) : nullptr;
    const auto* fresh = current && !current->data.is_null() ? &current->data : nullptr;
    const auto price = fresh ? number(*fresh, "price") : row ? row->price : std::nullopt;
    const auto change = fresh ? number(*fresh, "changePercent") : row ? row->change : std::nullopt;
    const bool outdated = !fresh && row && !market_.date.empty() && row->date != market_.date;
    const bool otherSession = fresh && row && !sessionDate(*fresh).empty() && sessionDate(*fresh) != row->date;
    const auto* priceColor = current && Clock::now() < current->flashUntil ?
        changeColor(current->move) : outdated ? muted : white;
    std::ostringstream line;
    line << background << (selected ? cyan : muted) << (selected ? " >" : "  ")
         << (saved ? teal : muted) << (saved ? "*" : " ") << white << clip(code, 7, true)
         << reset << background;
    if (hasName) line << muted << clip(row ? row->name : code, nameWidth, true);
    line << reset << background << priceColor << clip(priceText(price, index), 13, true)
         << changeColor(change) << clip(dailyText(change), 9, true);
    if (tailWidth > 0) {
        if (outdated && row->price) {
            line << amber << clip("SESI LAMA", tailWidth, true);
        } else {
            line << muted << clip(row && !otherSession ? quantityText(row->value) : "--", tailWidth, true);
        }
    }
    return line.str() + reset;
}

std::string averageText(const std::optional<double>& average) {
    if (!average) return "--";
    const auto cents = std::llround(*average * 100);
    return money(static_cast<double>(cents / 100)) + "," + (cents % 100 < 10 ? "0" : "") +
           std::to_string(cents % 100);
}

std::optional<double> averagePrice(std::optional<double> value, std::optional<double> volume) {
    if (!value || !volume || *value <= 0 || *volume <= 0) return std::nullopt;
    return *value / *volume;
}

std::vector<PaneLine> Desk::detail(int width, int limit) const {
    std::vector<PaneLine> lines;
    const auto add = [&](const std::string& text, const char* color) {
        if (static_cast<int>(lines.size()) < limit) lines.push_back(plain(text, width, color));
    };
    const auto code = selection();
    if (code.empty()) {
        add(" Pilih saham untuk melihat detail.", muted);
        return lines;
    }

    const auto* row = find(code);
    const bool index = code == ihsgCode;
    const auto history = histories_.find(historyKey());
    const json* prices = history == histories_.end() || history->second.result.data.is_null()
        ? nullptr : &history->second.result.data;
    const auto* current = editing_ ? nullptr : quote(code);
    const auto* live = current && !current->data.is_null() ? &current->data : nullptr;
    const auto price = live ? number(*live, "price") : row ? row->price : std::nullopt;
    const auto change = live ? number(*live, "changePercent") : row ? row->change : std::nullopt;
    const auto liveDate = live ? sessionDate(*live) : "";
    const auto tradeDate = live ? liveDate : row ? row->date : "";
    const auto day = tradeDate.size() == 10 ? tradeDate.substr(8, 2) + "/" + tradeDate.substr(5, 2) : "";
    const bool sameSession = row && (demo_ || (!tradeDate.empty() && row->date == tradeDate));
    const auto liveField = [&](const char* field) { return live ? number(*live, field) : std::nullopt; };
    const auto snapshotField = [&](std::optional<double> Stock::* field) {
        return sameSession ? row->*field : std::nullopt;
    };

    add(" " + code + (row && !row->sector.empty() ? "  /  " + row->sector : ""), cyan);
    auto header = " " + priceText(price, index) + (index && price ? " poin" : "") + "   " + dailyText(change);
    if (const auto delta = liveField("change"); delta && *delta != 0)
        header += (*delta > 0 ? "   +" : "   -") + (index ? indexPoints(std::abs(*delta)) : money(std::abs(*delta)));
    const auto pulse = current && Clock::now() < current->flashUntil ? current->move : std::nullopt;
    if (pulse && *pulse != 0) header += *pulse > 0 ? "  ↑" : "  ↓";
    add(header, changeColor(pulse ? pulse : change));
    if (live) {
        const auto trade = timestamp(*live, "marketTime");
        const auto fetched = timestamp(*live, "fetchedAt");
        const bool cached = !current->error.empty();
        auto label = std::string(cached ? " CACHE " : " ") + live->value("source", "");
        if (trade) label += " " + timeText(trade, "%d/%m %H:%M") + " WIB";
        else if (!day.empty()) label += " " + day;
        if (fetched && !cached && width >= 50) label += " | Ambil " + timeText(fetched, "%H:%M:%S");
        add(label, cached ? amber : teal);
    } else {
        add(row && row->price ? " Snapshot " + market_.source + " " + day : " Kuotasi belum tersedia", muted);
    }

    const json* sessionData = prices;
    if (!sessionData && !code.empty()) {
        Clock::time_point latest{};
        for (const auto& [cacheKey, item] : histories_) {
            if (cacheKey.compare(0, code.size(), code) == 0 && item.expires > latest &&
                !item.result.data.is_null()) {
                latest = item.expires;
                sessionData = &item.result.data;
            }
        }
    }
    const json* dailyBar = nullptr;
    if (sessionData && !tradeDate.empty()) {
        const auto dayBar = sessionData->find("session");
        if (dayBar != sessionData->end() && dayBar->is_object() &&
            timeText(timestamp(*dayBar, "t"), "%Y-%m-%d") == tradeDate) dailyBar = &*dayBar;
        const auto& bars = sessionData->at("bars");
        if (!dailyBar && sessionData->value("interval", "1d") == "1d" && !bars.empty() &&
            timeText(timestamp(bars.back(), "t"), "%Y-%m-%d") == tradeDate) dailyBar = &bars.back();
    }
    auto open = liveField("open"), high = liveField("high"), low = liveField("low");
    auto ohlcSource = live && (open || high || low) ? live->value("source", "") : "";
    if (!open && !high && !low) {
        open = snapshotField(&Stock::open);
        high = snapshotField(&Stock::high);
        low = snapshotField(&Stock::low);
        if (open || high || low) ohlcSource = market_.source;
    }
    if (!open && !high && !low && dailyBar) {
        open = number(*dailyBar, "o");
        high = number(*dailyBar, "h");
        low = number(*dailyBar, "l");
        ohlcSource = sessionData->value("source", "");
    }

    auto previous = liveField("previous");
    if (!previous) previous = snapshotField(&Stock::previous);
    auto volume = live ? liveField("volume") : snapshotField(&Stock::volume);
    if (!volume) volume = snapshotField(&Stock::volume);
    const auto tradedValue = liveField("value");
    const auto snapshotValue = snapshotField(&Stock::value);
    auto average = averagePrice(tradedValue, liveField("volume"));
    if (!average) average = averagePrice(snapshotValue, snapshotField(&Stock::volume));
    std::time_t averageThrough = 0;
    if (!average && sessionData) {
        const auto intraday = sessionData->find("intraday");
        if (intraday != sessionData->end() && intraday->is_object() && intraday->value("date", "") == tradeDate) {
            average = number(*intraday, "average");
            if (average) averageThrough = timestamp(*intraday, "through");
        }
    }
    const bool estimatedAverage = averageThrough > 0;
    const auto ara = liveField("ara"), arb = liveField("arb");
    const auto board = live ? live->value("board", "") : "";

    const auto metrics = [&](const std::string& a, const std::string& b, const std::string& c,
                             const char* color = muted) {
        if (static_cast<int>(lines.size()) >= limit) return;
        const int cell = std::min(24, (width - 1) / 3);
        lines.push_back(std::string(" ") + color + clip(a, cell, true) + clip(b, cell, true) +
                        clip(c, width - 1 - cell * 2) + reset);
    };
    metrics("BUKA " + priceText(open, index), "HIGH " + priceText(high, index), "LOW " + priceText(low, index), white);
    if (index) add(" PREV " + priceText(previous, true), muted);
    if (!index) {
        metrics("ARA* " + priceText(ara), "ARB* " + priceText(arb), "PREV " + priceText(previous), amber);
        metrics(std::string(estimatedAverage ? "AVG~ " : "AVG ") + averageText(average),
                "VOL " + quantityText(volume), "NILAI " + quantityText(tradedValue ? tradedValue : snapshotValue));
        if (const auto bid = liveField("bid"), offer = liveField("offer"); bid || offer) {
            metrics("BID " + priceText(bid), "OFFER " + priceText(offer), "");
        }
        if (limit >= 12) {
            auto label = std::string(" Sesi ") + (day.empty() ? "--" : day);
            if (estimatedAverage && width < 57 && ohlcSource == "Yahoo Finance") ohlcSource = "Yahoo";
            if (!ohlcSource.empty()) label += " | OHLC " + ohlcSource;
            if (estimatedAverage) {
                label += width >= 57 ? " | AVG~ Yahoo 1m " : " | AVG~ ";
                label += timeText(averageThrough, "%H:%M");
            }
            else if (average) label += tradedValue ? " | AVG Kuotasi" : " | AVG " + market_.source;
            add(label, teal);
        }
        if (limit >= 14) {
            if (ara || arb) {
                add(" * Estimasi BEI dari PREV" + (board.empty() ? "" : " | " + board), amber);
            } else if (!board.empty()) {
                add(" " + board + " | Batas harga belum tersedia", muted);
            }
        }
        if (row && !sameSession && !average && limit >= 16) {
            const auto earlier = averagePrice(row->value, row->volume);
            if (earlier && row->date.size() == 10)
                add(" AVG " + row->date.substr(8, 2) + "/" + row->date.substr(5, 2) + " " +
                    averageText(earlier) + " | " + market_.source, muted);
        }
        if (row && limit >= 20) {
            metrics("KAP " + quantityText(row->cap), "PER " + ratioText(row->per), "PBV " + ratioText(row->pbr));
        }
        if (limit >= 21) {
            std::string alertText;
            for (const auto& alert : data_.alerts) {
                if (alert.code != code) continue;
                if (!alertText.empty()) alertText += ", ";
                alertText += (alert.above ? ">=" : "<=") + money(alert.target) + (alert.triggered ? "*" : "");
            }
            if (!alertText.empty()) add(" Alert " + alertText, amber);
        }

    }

    std::string source;
    if (prices) {
        source = prices->value("source", "");
        if (!history->second.result.error.empty()) source += " / cache";
    } else {
        source = editing_ ? "Enter untuk buka" :
            history != histories_.end() ? history->second.result.error : "Memuat riwayat...";
    }
    const auto& period = chartPeriods[range_];
    const auto interval = period.secondsPerBar < 86400 ?
        std::to_string(period.secondsPerBar / 60) + " MENIT" :
        period.secondsPerBar == 86400 ? "HARIAN" : "MINGGUAN";
    if (static_cast<int>(lines.size()) < limit) {
        std::string options = " ";
        for (std::size_t i = 0; i < chartPeriods.size(); ++i) {
            options += std::string(static_cast<int>(i) == range_ ? activeTab : bar) +
                (static_cast<int>(i) == range_ ? white : muted) + " " + chartPeriods[i].label + " " + reset;
        }
        lines.push_back(std::move(options));
    }
    auto heading = " OHLC " + interval;
    if (period.secondsPerBar < 86400) heading += " WIB";
    if (indicator_ == Indicator::ma5) heading += " [MA5]";
    else if (indicator_ == Indicator::ma20) heading += " [MA20]";
    else if (indicator_ == Indicator::prev) heading += " [PREV]";
    add(heading + "  |  " + source, prices ? teal : amber);
    if (prices && limit - static_cast<int>(lines.size()) >= 4) {
        const auto height = limit - static_cast<int>(lines.size()) - 1;
        auto plot = chart(prices->at("bars"), width, height, period, index, indicator_, previous);
        lines.insert(lines.end(), plot.begin(), plot.end());
    }
    return lines;
}

std::vector<PaneLine> Desk::tradeTape(int width, int limit) const {
    std::vector<PaneLine> lines;
    const auto code = selection();
    if (code.empty()) return {plain(" Pilih saham untuk melihat transaksi.", width, muted)};
    if (code == ihsgCode) return {plain(" Running Trade tersedia untuk saham.", width, muted)};
    const auto available = tradesCode_ == code && tradesPage_.data.is_object();
    auto info = " " + code + "  |  INVEZGO";
    if (available) {
        const auto& data = tradesPage_.data;
        info += "  |  " + data.value("date", "");
        if (const auto fetched = timestamp(data, "fetchedAt"); fetched)
            info += "  |  Ambil " + timeText(fetched, "%H:%M:%S") + " WIB";
    }
    lines.push_back(plain(info, width, cyan));
    if (tradesCode_ == code && !tradesPage_.error.empty())
        lines.push_back(plain(" " + tradesPage_.error + (available ? "  |  CACHE" : ""), width, amber));
    if (!available) {
        if (lines.size() == 1)
            lines.push_back(plain(paused_ ? " Pembaruan transaksi dijeda." : " Memuat transaksi...", width, muted));
        return lines;
    }

    const auto& trades = tradesPage_.data.at("trades");
    if (trades.empty()) {
        lines.push_back(plain(" Belum ada transaksi untuk tanggal ini.", width, muted));
        return lines;
    }
    const int sideWidth = 6;
    const int timeWidth = width >= 64 ? 14 : 10;
    const int valueWidth = width >= 64 ? 15 : 11;
    const bool showBrokers = width >= 64;
    const auto values = [&](const std::string& time, const std::string& price, const std::string& lots) {
        return clip(time, timeWidth, true) + clip(price, valueWidth, true) + clip(lots, valueWidth, true);
    };
    lines.push_back(plain(" " + values("WAKTU WIB", "HARGA", "LOT") + clip("SIDE", sideWidth, true) +
        "PASAR" + (showBrokers ? "   BUYER   SELLER" : ""), width, white));

    const auto count = std::min<std::size_t>(trades.size(), limit - lines.size());
    for (std::size_t i = 0; i < count; ++i) {
        const auto& trade = trades[i];
        std::ostringstream lots;
        const auto volume = number(trade, "shares").value_or(0);
        lots << std::fixed << std::setprecision(std::fmod(volume, 100) == 0 ? 0 : 2) << volume / 100;
        const auto side = trade.value("side", "--");
        const auto background = i % 2 ? stripe : "";
        const auto broker = showBrokers ? "   " + clip(trade.value("buyer", ""), 8, true) +
            trade.value("seller", "") : "";
        const auto tail = clip(trade.value("board", ""), 5, true) + broker;
        lines.push_back(std::string(background) + white + " " +
            values(trade.value("time", ""), priceText(number(trade, "price")), lots.str()) +
            (side == "BUY" ? green : side == "SELL" ? red : muted) + clip(side, sideWidth, true) +
            muted + clip(tail, width - 1 - timeWidth - valueWidth * 2 - sideWidth, true) + reset);
    }
    return lines;
}

void Desk::draw(COORD size, Clock::time_point now) {
    std::ostringstream output;
    output << "\x1b[H";
    int drawn = 0;
    const auto line = [&output, &drawn](const std::string& text) {
        if (drawn++ > 0) output << "\r\n";
        output << "\x1b[2K" << text << reset;
    };
    if (size.X < 47 || size.Y < 15) {
        line(" Perbesar jendela untuk StockWatch");
        line(" [M] Menu   [Q] Keluar");
        std::cout << output.str() << "\x1b[J" << std::flush;
        return;
    }

    const int width = size.X;
    const bool split = width >= 104;
    const int left = split ? width * 55 / 100 : width;
    const int right = width - left - 3;
    const int body = size.Y - 6; // Tiga baris header, satu judul panel, dua baris footer.
    const int compactDetail = std::min(body - 3, std::max(15, body * 2 / 3));
    pageSize_ = split ? body - 1 : body - compactDetail - 2;
    if (selected_ < top_) top_ = selected_;
    if (selected_ >= top_ + pageSize_) top_ = selected_ - pageSize_ + 1;

    const auto wallNow = std::time(nullptr);
    const auto today = timeText(wallNow, "%Y-%m-%d");
    const auto clock = timeText(wallNow, "%H:%M:%S") + " WIB ";
    const auto marketLabel = demo_ ? " DEMO " : " IDX ";
    const auto statusTag = demo_ ? std::string{} : marketStatusLabel();
    const auto statusBlock = statusTag.empty() ? std::string{} : "[" + statusTag + "] ";
    const auto headerTime = marketLabel + today + "  |  ";
    const int titleWidth = width - static_cast<int>(statusBlock.size() + headerTime.size() + clock.size());
    const char* statusColor = statusTag == "BUKA" ? green : statusTag == "ISTIRAHAT" ? amber : muted;
    line(std::string(bar) + white + clip(" STOCKWATCH", std::max(1, titleWidth), true)
        + statusColor + statusBlock + (demo_ ? amber : cyan) + headerTime + white + clock);

    const auto count = std::to_string(market_.rows.size()) + " emiten";
    if (market_.offline) {
        line(plain(" " + count + "  |  Katalog lokal", width, muted));
    } else if (market_.rows.empty() && marketWork_) {
        line(plain(" Memuat snapshot pasar...", width, muted));
    } else {
        const auto snapshot = market_.date.empty() ? "" : "Snapshot " + market_.date + "  |  ";
        const auto rising = std::to_string(market_.rising) + " naik";
        const auto falling = std::to_string(market_.falling) + " turun";
        const auto flat = std::to_string(market_.flat) + " tetap";
        const auto changesWidth = 9 + rising.size() + falling.size() + flat.size();
        auto used = 1 + snapshot.size() + count.size();
        std::string summary = std::string(" ") + (market_.date == today ? muted : amber) +
            snapshot + white + count;
        if (const auto* index = quote(ihsgCode); index && !index->data.is_null()) {
            const auto change = number(index->data, "changePercent");
            const auto level = "  |  IHSG " + priceText(number(index->data, "price"), true) + " ";
            const auto daily = dailyText(change);
            if (used + level.size() + daily.size() <= static_cast<std::size_t>(width)) {
                summary += cyan + level + changeColor(change) + daily;
                used += level.size() + daily.size();
            }
        }
        if (used + changesWidth <= static_cast<std::size_t>(width)) {
            summary += std::string(muted) + "  |  " + green + rising +
                "  " + red + falling + "  " + muted + flat;
            used += changesWidth;
        }
        if (market_.turnover > 0) {
            const auto turnover = "  |  Nilai Rp" + compact(market_.turnover);
            if (used + turnover.size() <= static_cast<std::size_t>(width)) summary += muted + turnover;
        }
        line(summary);
    }
    const auto view = activeView();
    const bool focus = panel_ == Panel::detail && !editing_;
    const bool tape = panel_ == Panel::trades && !editing_;
    if (editing_) {
        constexpr auto label = " CARI EMITEN > ";
        const auto room = width - static_cast<int>(std::char_traits<char>::length(label)) - 1;
        const auto shown = input_.size() > static_cast<std::size_t>(room)
            ? input_.substr(input_.size() - room) : input_;
        line(plain(std::string(label) + shown + "_", width, amber));
    } else if (editingAlert_) {
        const auto label = " ALERT " + selection() + " (>harga / <harga, kosong=hapus) > ";
        line(plain(label + alertInput_ + "_", width, amber));
    } else if (pickingRange_) {
        std::string options;
        for (std::size_t i = 0; i < chartPeriods.size(); ++i)
            options += " " + std::to_string(i + 1) + ":" + chartPeriods[i].label;
        line(plain(options, width, amber));
    } else {
        const auto tab = [](const char* label, bool active) {
            return std::string(active ? activeTab : bar) + (active ? white : muted) + label + reset;
        };
        const std::string tradesTab = width >= 62 ? " 4 Running Trade " : " 4 Trade ";
        const std::string nav = " " + tab(" 1 Pasar ", !focus && !tape && view == View::market) + " " +
            tab(" 2 Watchlist ", !focus && !tape && view == View::watch) + " " +
            tab(" 3 Detail ", focus) + " " + tab(tradesTab.c_str(), tape);
        const int navWidth = 36 + static_cast<int>(tradesTab.size());
        constexpr const char* orders[] = {"Kode", "Naik", "Turun", "Nilai"};
        const auto query = view == View::market && !filter_.empty() ? filter_ : "Cari emiten";
        const auto sectorTag = sector_.empty() ? "Semua" : clip(sector_, 12);
        const auto suffix = "  / " + query + "   S:" + orders[static_cast<int>(order_)] +
                            (view == View::market ? "   F:" + sectorTag : "");
        line(nav + plain(suffix + "   I IHSG", width - navWidth, cyan));
    }
    const std::string gap = std::string(grid) + " │ " + reset;
    const auto listTitle = view == View::watch ? "WATCHLIST " : "DAFTAR EMITEN ";
    const auto available = visible_.size() - std::min(top_, visible_.size());
    const auto actualRows = std::min<std::size_t>(pageSize_, available);
    if (tape) {
        line(rule("RUNNING TRADE ", width));
        for (const auto& cell : tradeTape(width, body)) line(cell);
    } else if (focus) {
        line(rule("GRAFIK DAN KUOTASI ", width));
        for (const auto& cell : detail(width, body)) line(cell);
    } else {
        if (split) line(rule(listTitle, left) + gap + rule("DETAIL SAHAM ", right));
        else line(rule(listTitle, width));

        const bool hasName = left >= 47;
        const bool extra = left >= 60;
        const int nameWidth = hasName ? left - (extra ? 45 : 32) : 0;
        const auto colHead = std::string("   KODE   ") + (hasName ? clip("EMITEN", nameWidth, true) : "") +
            clip("HARGA", 13, true) + clip("HARI INI", 9, true) +
            clip("NILAI", left - 32 - nameWidth);
        std::vector<PaneLine> leftPane{plain(colHead, left, white)};
        for (std::size_t i = 0; i < actualRows; ++i) {
            const auto& code = visible_[top_ + i];
            leftPane.push_back(boardRow(find(code), code, left, top_ + i == selected_, i % 2 != 0));
        }
        if (visible_.empty()) {
            const auto empty = marketWork_ && market_.rows.empty() ? " Memuat data pasar ..." : view == View::watch ?
                " Watchlist kosong. Tekan A pada saham pilihan." : " Tidak ada emiten yang cocok.";
            leftPane.push_back(plain(empty, left, muted));
        }

        if (split) {
            const auto rightPane = detail(right, body);
            for (std::size_t i = 0; i < static_cast<std::size_t>(body); ++i) {
                line((i < leftPane.size() ? leftPane[i] : std::string(left, ' ')) + gap +
                     (i < rightPane.size() ? rightPane[i] : std::string(right, ' ')));
            }
        } else {
            for (const auto& cell : leftPane) line(cell);
            line(rule("DETAIL SAHAM ", width));
            const int height = body - static_cast<int>(leftPane.size()) - 1;
            for (const auto& cell : detail(width, height)) line(cell);
        }
    }

    while (drawn < size.Y - 2) line("");

    const auto first = visible_.empty() ? 0 : top_ + 1;
    const auto last = top_ + actualRows;
    const auto counter = std::to_string(first) + "-" + std::to_string(last) + "/" + std::to_string(visible_.size());
    const auto seconds = std::max(0, static_cast<int>(std::chrono::ceil<std::chrono::seconds>(nextMarket_ - now).count()));
    const std::string status = paused_ ? "JEDA" : marketWork_ ? "MEMUAT" :
        !marketError_.empty() || market_.stale ? "CACHE" : "AUTO " + std::to_string(seconds) + "s";
    const auto text = !notice_.empty() ? notice_ : !marketError_.empty() ? marketError_ :
        market_.source + (refreshed_ ? "  |  Cek " + timeText(refreshed_, "%H:%M:%S") + " WIB" : "");
    const auto location = tape ? "Trade " + selection() :
        focus ? (selection().empty() ? "Detail" : "Fokus " + selection()) : counter;
    const auto tradeStatus = paused_ ? "JEDA" : tradesWork_ ? "MEMUAT" :
        tradesCode_ == selection() && !tradesPage_.error.empty() ? "CEK FEED" : "Refresh tiap 10 dtk";
    const auto footer = tape ? tradeStatus : status + "   " + text;
    line(plain(" " + location + "  |  " + footer, width, market_.stale || !marketError_.empty() ? amber : muted));
    const auto controls = editing_ ? " ↑↓ Pilih  Enter Cari  Esc Batal  Bksp Hapus" :
        editingAlert_ ? " Ketik >harga atau <harga  Enter Simpan  Kosong+Enter Hapus  Esc Batal" :
        pickingRange_ ? " 1-8 Pilih periode  Esc Batal" :
        tape ? " ↑↓ Emiten  R Muat  Space Jeda  Esc Kembali" :
        focus ? " ↑↓ Emiten  H Geser  P Periode  T Indikator  L Alert  4 Trade  Esc Kembali" :
        split ? " ↑↓ Pilih  / Cari  F Sektor  S Urut  A Watch  T Indikator  L Alert  P Periode  R Muat  M Menu  Q Keluar" :
        width >= 75 ? " ↑↓ Pilih  / Cari  F Sektor  I IHSG  T Indikator  L Alert  P Periode  M Menu  Q Keluar" :
        " ↑↓  / Cari  F Sektor  I IHSG  T Ind  L Alert  M  Q";
    line(plain(controls, width, teal));
    std::cout << output.str() << std::flush;
}

DashboardExit Desk::run(Screen& screen) {
    COORD lastSize{};
    while (true) {
        const auto now = Clock::now();
        tick(now);
        const auto size = screen.size();
        if (redraw_ || now >= nextFrame_ || size.X != lastSize.X || size.Y != lastSize.Y) {
            draw(size, now);
            lastSize = size;
            redraw_ = false;
            nextFrame_ = now + 1s;
        }

        while (_kbhit()) {
            const int key = _getch();
            redraw_ = true;
            if (key == 3) return DashboardExit::quit;
            if (key == 0 || key == 224) {
                const int arrow = _getch();
                if (arrow == 72) move(-1);
                else if (arrow == 80) move(1);
                else if (arrow == 73) move(-pageSize_);
                else if (arrow == 81) move(pageSize_);
                else if (arrow == 71) move(-static_cast<int>(visible_.size()));
                else if (arrow == 79) move(static_cast<int>(visible_.size()));
                continue;
            }
            if (editing_) {
                searchKey(key);
                continue;
            }
            if (editingAlert_) {
                alertKey(key);
                continue;
            }
            if (pickingRange_) {
                if (key >= '1' && key < '1' + static_cast<int>(chartPeriods.size())) {
                    if (panel_ == Panel::trades) panel_ = Panel::detail;
                    changeRange(key - '1', now);
                    pickingRange_ = false;
                } else if (key == 27 || key == 'p' || key == 'P') {
                    pickingRange_ = false;
                }
                continue;
            }

            switch (std::tolower(static_cast<unsigned char>(key))) {
                case 'q': return DashboardExit::quit;
                case 'm': return DashboardExit::menu;
                case '1': switchView(View::market); break;
                case '2': case 'w': switchView(View::watch); break;
                case '3': openDetail(); break;
                case '4': panel_ = Panel::trades; break;
                case 'i':
                    view_ = View::market;
                    filter_.clear();
                    rebuild(ihsgCode);
                    openDetail();
                    selectAfter_ = now;
                    loadPeriod_ = true;
                    break;
                case 13:
                    if (panel_ != Panel::overview) panel_ = Panel::overview;
                    else openDetail();
                    break;
                case '/':
                    searchOrigin_ = selection();
                    input_.clear();
                    notice_.clear();
                    editing_ = true;
                    rebuild();
                    break;
                case 's':
                    order_ = static_cast<Order>((static_cast<int>(order_) + 1) % 4);
                    visible_.clear();
                    selected_ = top_ = 0;
                    rebuild();
                    break;
                case 'f':
                    if (view_ == View::market) cycleSector();
                    break;
                case 't':
                    indicator_ = static_cast<Indicator>((static_cast<int>(indicator_) + 1) % 4);
                    break;
                case 'l':
                    if (selection().empty() || selection() == ihsgCode) {
                        notice_ = "Price alert tersedia untuk emiten saham";
                    } else {
                        alertInput_.clear();
                        editingAlert_ = true;
                        notice_.clear();
                    }
                    break;
                case 'h':
                    if (panel_ == Panel::trades) panel_ = Panel::detail;
                    changeRange((range_ + 1) % static_cast<int>(chartPeriods.size()), now);
                    break;
                case 'p': pickingRange_ = true; break;
                case 'a': toggleWatch(); break;
                case ' ':
                    paused_ = !paused_;
                    if (!paused_) { nextMarket_ = now; nextWatch_ = now; }
                    break;
                case 'r':
                    paused_ = false;
                    nextMarket_ = now;
                    nextWatch_ = now;
                    nextTrades_ = now;
                    selectAfter_ = now;
                    if (auto item = histories_.find(historyKey()); item != histories_.end()) item->second.expires = now;
                    if (auto item = quotes_.find(selection()); item != quotes_.end()) item->second.next = now;
                    break;
                case 27:
                    if (panel_ != Panel::overview) {
                        panel_ = Panel::overview;
                        break;
                    }
                    if ((filter_.empty() && sector_.empty()) || view_ != View::market) return DashboardExit::quit;
                    filter_.clear();
                    sector_.clear();
                    selected_ = top_ = 0;
                    visible_.clear();
                    rebuild();
                    break;
            }
        }
        std::this_thread::sleep_for(60ms);
    }
}
}

DashboardExit runDashboard(TerminalData& data, bool demo, ApiLoader load) {
    Screen screen;
    return screen.active() ? Desk(data, demo, load).run(screen) : DashboardExit::unavailable;
}
