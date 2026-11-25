#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>

#include "http.hpp"
#include "dashboard.hpp"
#include "portfolio.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <ctime>
#include <filesystem>
#include <iomanip>
#include <iostream>
#include <optional>
#include <sstream>
#include <thread>

using nlohmann::json;

namespace {
struct EndOfInput {};

std::string ask(const std::string& prompt) {
    std::cout << prompt;
    std::string value;
    if (!std::getline(std::cin, value)) throw EndOfInput{};
    return trim(value);
}

double askNumber(const std::string& prompt, double minimum, double maximum, bool whole = false) {
    auto value = ask(prompt);
    std::replace(value.begin(), value.end(), ',', '.');
    std::istringstream stream(value);
    double number = 0;
    char extra = 0;
    if (!(stream >> number) || (stream >> extra) || !std::isfinite(number) ||
        number < minimum || number > maximum || (whole && std::floor(number) != number)) {
        throw std::invalid_argument("Angka tidak valid atau di luar batas");
    }
    return number;
}

json request(const std::string& path) {
    HttpResponse response;
    try {
        response = httpGet(L"127.0.0.1", 8787, path, false);
    } catch (const std::exception& error) {
        throw std::runtime_error(std::string("API lokal tidak dapat dihubungi. Jalankan StockWatchApi.exe. ") +
                                 error.what());
    }
    const auto payload = json::parse(response.body);
    if (response.status != 200 || !payload.value("ok", false)) {
        throw std::runtime_error(payload.value("message", "Permintaan gagal"));
    }
    return payload.at("data");
}

std::optional<bool> probeApi() {
    try {
        return request("/health").at("demo").get<bool>();
    } catch (const std::exception&) {
        return std::nullopt;
    }
}

class LocalApi {
public:
    LocalApi() = default;
    LocalApi(const LocalApi&) = delete;
    LocalApi& operator=(const LocalApi&) = delete;

    ~LocalApi() {
        if (job_) CloseHandle(job_);
    }

    void start(bool demo) {
        wchar_t executable[32768];
        const auto length = GetModuleFileNameW(nullptr, executable, 32768);
        if (length == 0 || length == 32768) {
            throw std::runtime_error("Lokasi terminal tidak ditemukan");
        }
        const auto api = std::filesystem::path(executable).parent_path() / L"StockWatchApi.exe";
        if (!std::filesystem::is_regular_file(api)) {
            throw std::runtime_error("StockWatchApi.exe tidak ditemukan. Build kedua proyek dahulu.");
        }

        job_ = CreateJobObjectW(nullptr, nullptr);
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if (!job_ || !SetInformationJobObject(job_, JobObjectExtendedLimitInformation,
                                              &limits, sizeof(limits))) {
            throw std::runtime_error("Tidak dapat menyiapkan proses API lokal");
        }

        std::wstring command = L"\"" + api.wstring() + L"\"";
        if (demo) command += L" --demo";
        STARTUPINFOW startup{};
        startup.cb = sizeof(startup);
        PROCESS_INFORMATION process{};
        if (!CreateProcessW(api.c_str(), command.data(), nullptr, nullptr, FALSE,
                            CREATE_NO_WINDOW | CREATE_SUSPENDED, nullptr, nullptr,
                            &startup, &process)) {
            throw std::runtime_error("StockWatchApi.exe gagal dijalankan");
        }
        const bool started = AssignProcessToJobObject(job_, process.hProcess) &&
                             ResumeThread(process.hThread) != static_cast<DWORD>(-1);
        if (!started) TerminateProcess(process.hProcess, 1);
        CloseHandle(process.hThread);
        CloseHandle(process.hProcess);
        if (!started) throw std::runtime_error("API lokal gagal dimulai");
    }

private:
    HANDLE job_ = nullptr;
};

void connectApi(LocalApi& api, bool demo) {
    auto runningMode = probeApi();
    if (!runningMode) {
        api.start(demo);
        for (int attempt = 0; attempt < 20 && !runningMode; ++attempt) {
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
            runningMode = probeApi();
        }
    }
    if (!runningMode) throw std::runtime_error("API lokal belum siap di port 8787");
    if (*runningMode != demo) {
        throw std::runtime_error("API lokal sedang berjalan dalam mode lain. Tutup API itu lalu coba lagi.");
    }
}

std::string marketTime(const json& quote) {
    if (!quote.at("marketTime").is_number_integer()) { const auto date = quote.value("date", ""); return date.empty() ? "--" : date; }
    const auto timestamp = quote.at("marketTime").get<std::time_t>() + 7 * 60 * 60;
    const auto* utc = std::gmtime(&timestamp);
    if (!utc) return "--";
    std::ostringstream out;
    out << std::put_time(utc, quote.value("timePrecision", "") == "minute"
        ? "%d/%m/%Y %H:%M" : "%d/%m/%Y %H:%M:%S") << " WIB";
    return out.str();
}

std::string dailyChange(const json& quote) {
    if (!quote["changePercent"].is_number()) return "--";
    return percentText(quote["changePercent"].get<double>());
}

void printQuote(const json& quote) {
    std::cout << '\n' << quote.at("code").get<std::string>() << " | "
              << quote.at("name").get<std::string>() << '\n'
              << (quote.value("kind", "") == "index" ? "Nilai indeks     : " : "Harga per lembar : ")
              << (quote.value("kind", "") == "index" ? indexPoints(quote.at("price").get<double>()) + " poin"
                                                     : money(quote.at("price").get<double>())) << '\n'
              << "Perubahan harian : " << dailyChange(quote);
    if (quote.value("kind", "") != "index") {
        std::cout << "\nVolume           : ";
        if (quote.at("volume").is_number()) std::cout << quote.at("volume").dump();
        else std::cout << "--";
        if ((quote.contains("bid") && quote["bid"].is_number()) ||
            (quote.contains("offer") && quote["offer"].is_number())) {
            std::cout << "\nBid / Offer      : "
                      << (quote.contains("bid") && quote["bid"].is_number() ? money(quote["bid"].get<double>()) : "--")
                      << " / "
                      << (quote.contains("offer") && quote["offer"].is_number() ? money(quote["offer"].get<double>()) : "--");
        }
    }
    const auto mStatus = quote.value("marketStatus", "");
    std::cout << "\nWaktu kuotasi    : " << marketTime(quote)
              << (mStatus == "open" ? " [BUKA]" : mStatus == "break" ? " [ISTIRAHAT]" : mStatus == "closed" ? " [TUTUP]" : "")
              << "\nSumber           : " << quote.at("source").get<std::string>() << '\n';
}

void search() {
    const auto rows = request("/stocks/search?q=" + encodeQuery(ask("Kode atau nama: ")));
    if (rows.empty()) {
        std::cout << "Tidak ada hasil saham IDX.\n";
        return;
    }
    for (const auto& row : rows) {
        std::cout << "  " << row.at("code").get<std::string>() << "  "
                  << row.at("name").get<std::string>() << '\n';
    }
    const auto selected = ask("Kode untuk lihat harga (Enter untuk kembali): ");
    if (!selected.empty()) printQuote(request("/stocks/" + instrumentCode(selected)));
}

json quoteList(const std::vector<std::string>& codes) {
    std::string query;
    for (const auto& code : codes) {
        if (!query.empty()) query += ',';
        query += code;
    }
    return request("/stocks/compare?codes=" + encodeQuery(query));
}

void showWatchlist(const TerminalData& data) {
    if (data.watchlist.empty()) {
        std::cout << "Watchlist kosong. Tambahkan kode lewat menu 4.\n";
        return;
    }
    std::cout << "\n" << std::left << std::setw(9) << "KODE" << std::setw(17) << "HARGA"
              << std::setw(13) << "HARI INI" << "WAKTU KUOTASI\n";
    for (const auto& row : quoteList(data.watchlist)) {
        std::cout << std::setw(9) << row.at("code").get<std::string>();
        if (row.contains("error")) {
            std::cout << row.at("error").get<std::string>() << '\n';
            continue;
        }
        std::cout << std::setw(17) << money(row.at("price").get<double>())
                  << std::setw(13) << dailyChange(row) << marketTime(row) << '\n';
    }
}

void editWatchlist(TerminalData& data, bool demo, bool remove) {
    auto updated = data;
    auto& codes = updated.watchlist;
    const auto code = stockCode(ask("Kode saham: "));
    if (code == ihsgCode && !remove) throw std::invalid_argument("IHSG tersedia lewat tombol I pada dashboard");
    const auto found = std::find(codes.begin(), codes.end(), code);
    if (remove) {
        if (found == codes.end()) throw std::invalid_argument("Kode belum ada di watchlist");
        codes.erase(found);
    } else {
        if (found != codes.end()) throw std::invalid_argument("Kode sudah ada di watchlist");
        if (codes.size() >= maxStocks) throw std::invalid_argument("Watchlist maksimal 8 saham");
        request("/stocks/" + code);
        codes.push_back(code);
    }
    saveData(updated, demo);
    data = std::move(updated);
    std::cout << "Watchlist tersimpan.\n";
}

void editPosition(TerminalData& data, bool demo, bool remove) {
    auto updated = data;
    auto& positions = updated.positions;
    const auto code = stockCode(ask("Kode saham: "));
    if (code == ihsgCode && !remove) throw std::invalid_argument("Portofolio menerima posisi saham");
    const auto found = std::find_if(positions.begin(), positions.end(),
        [&code](const auto& position) { return position.code == code; });
    if (remove) {
        if (found == positions.end()) throw std::invalid_argument("Posisi belum ada");
        positions.erase(found);
    } else {
        if (found == positions.end() && positions.size() >= maxStocks) {
            throw std::invalid_argument("Portofolio maksimal 8 saham");
        }
        request("/stocks/" + code);
        const int lots = static_cast<int>(askNumber("Jumlah lot (1-100000): ", 1, 100000, true));
        const auto buyPrice = askNumber("Harga beli per lembar (contoh 9750): ", 0.01, 1000000000);
        const Position position{code, lots, buyPrice};
        if (found == positions.end()) positions.push_back(position);
        else *found = position;
    }
    saveData(updated, demo);
    data = std::move(updated);
    std::cout << "Portofolio tersimpan.\n";
}

void showPortfolio(const TerminalData& data, bool scenario) {
    if (data.positions.empty()) {
        std::cout << "Portofolio kosong. Tambahkan posisi lewat menu 6.\n";
        return;
    }
    std::vector<std::string> codes;
    for (const auto& position : data.positions) codes.push_back(position.code);
    const auto quotes = quoteList(codes);
    double totalCost = 0;
    double totalCurrent = 0;
    double totalProjected = 0;
    double largestImpact = 0;
    std::string largestCode;
    bool complete = true;

    if (scenario) {
        for (const auto& quote : quotes) {
            if (quote.contains("error")) {
                std::cout << quote.at("code").get<std::string>() << ": "
                          << quote.at("error").get<std::string>() << '\n';
                complete = false;
            }
        }
        if (!complete) {
            std::cout << "Simulasi membutuhkan harga untuk semua posisi.\n";
            return;
        }
        std::cout << "Masukkan persentase perubahan (contoh -5 atau 2,5).\n";
    }

    for (const auto& position : data.positions) {
        const auto quote = std::find_if(quotes.begin(), quotes.end(), [&position](const auto& row) {
            return row.at("code") == position.code;
        });
        const auto cost = positionValue(position, position.buyPrice);
        totalCost += cost;
        if (quote == quotes.end() || quote->contains("error")) {
            complete = false;
            std::cout << position.code << " | " << position.lots << " lot | Modal "
                      << money(cost) << " | Harga tidak tersedia\n";
            continue;
        }

        const double price = quote->at("price").get<double>();
        const double current = positionValue(position, price);
        totalCurrent += current;
        if (scenario) {
            const auto percent = askNumber(position.code + " (%): ", -100, 1000);
            const auto result = simulate(position, price, percent);
            totalProjected += result.projectedValue;
            if (std::abs(result.impact) > std::abs(largestImpact)) {
                largestImpact = result.impact;
                largestCode = position.code;
            }
            std::cout << "  " << money(result.currentValue) << " -> " << money(result.projectedValue)
                      << " | Dampak " << money(result.impact) << '\n';
        } else {
            std::cout << position.code << " | " << position.lots << " lot | Modal " << money(cost)
                      << " | Nilai " << money(current) << " | P/L " << money(current - cost)
                      << " (" << percentText((current - cost) / cost * 100) << ")\n";
        }
    }
    if (scenario) {
        const double impact = totalProjected - totalCurrent;
        std::cout << "\nNilai awal        : " << money(totalCurrent)
                  << "\nNilai simulasi    : " << money(totalProjected)
                  << "\nDampak skenario   : " << money(impact) << " ("
                  << percentText(impact / totalCurrent * 100) << ")\n";
        if (!largestCode.empty()) {
            std::cout << "Dampak terbesar   : " << largestCode << " (" << money(largestImpact) << ")\n";
        }
    } else {
        std::cout << "\nTotal modal       : " << money(totalCost) << '\n';
        if (complete) {
            std::cout << "Nilai portofolio  : " << money(totalCurrent) << "\nP/L portofolio    : "
                      << money(totalCurrent - totalCost) << " ("
                      << percentText((totalCurrent - totalCost) / totalCost * 100) << ")\n";
        } else {
            std::cout << "Nilai posisi yang tersedia: " << money(totalCurrent)
                      << "\nP/L total belum dapat dihitung.\n";
        }
    }
}

void compareStocks() {
    const auto input = ask("Masukkan 2-8 kode saham dipisahkan koma (contoh BBCA,BBRI,BMRI): ");
    if (input.empty()) return;
    const auto rows = request("/stocks/compare?codes=" + encodeQuery(input));
    std::cout << "\n" << std::left << std::setw(8) << "KODE" << std::setw(14) << "HARGA"
              << std::setw(12) << "HARI INI" << std::setw(22) << "BID / OFFER" << "SUMBER\n";
    for (const auto& row : rows) {
        std::cout << std::setw(8) << row.at("code").get<std::string>();
        if (row.contains("error")) {
            std::cout << row.at("error").get<std::string>() << '\n';
            continue;
        }
        const auto bid = row.contains("bid") && row["bid"].is_number() ? money(row["bid"].get<double>()) : "--";
        const auto offer = row.contains("offer") && row["offer"].is_number() ? money(row["offer"].get<double>()) : "--";
        std::cout << std::setw(14) << money(row.at("price").get<double>())
                  << std::setw(12) << dailyChange(row)
                  << std::setw(22) << (bid + " / " + offer)
                  << row.value("source", "--") << '\n';
    }
}

void manageAlerts(TerminalData& data, bool demo) {
    if (data.alerts.empty()) {
        std::cout << "\nBelum ada price alert tersimpan.\n";
    } else {
        std::cout << "\nDaftar Price Alert:\n";
        for (std::size_t i = 0; i < data.alerts.size(); ++i) {
            const auto& a = data.alerts[i];
            std::cout << "  " << (i + 1) << ". " << a.code << (a.above ? " >= " : " <= ")
                      << money(a.target) << (a.triggered ? " [TERPICU]" : " [AKTIF]") << '\n';
        }
    }
    const auto choice = ask("Aksi (1 Tambah, 2 Hapus, Enter Kembali): ");
    if (choice.empty()) return;
    auto updated = data;
    if (choice == "1") {
        if (updated.alerts.size() >= maxAlerts) throw std::invalid_argument("Price alert maksimal 12");
        const auto code = stockCode(ask("Kode saham: "));
        request("/stocks/" + code);
        const auto dir = ask("Kondisi (>= untuk naik, <= untuk turun): ");
        if (dir != ">=" && dir != ">" && dir != "<=" && dir != "<")
            throw std::invalid_argument("Masukkan >= atau <=");
        const auto target = askNumber("Target harga (Rp): ", 1, 1000000000);
        updated.alerts.push_back({code, target, dir[0] == '>', false});
        saveData(updated, demo);
        data = std::move(updated);
        std::cout << "Price alert tersimpan.\n";
    } else if (choice == "2") {
        if (updated.alerts.empty()) throw std::invalid_argument("Belum ada alert untuk dihapus");
        const auto idx = static_cast<std::size_t>(askNumber("Nomor alert yang dihapus: ", 1,
            static_cast<double>(updated.alerts.size()), true));
        updated.alerts.erase(updated.alerts.begin() + static_cast<std::ptrdiff_t>(idx - 1));
        saveData(updated, demo);
        data = std::move(updated);
        std::cout << "Price alert dihapus.\n";
    } else {
        throw std::invalid_argument("Pilihan aksi tidak dikenali");
    }
}

void menu(bool demo) {
    std::cout << "\n========== STOCKWATCH | " << (demo ? "DEMO" : "PASAR") << " ==========\n"
              << "  1  Cari saham                  7  Hapus posisi\n"
              << "  2  Lihat harga                 8  Lihat portofolio\n"
              << "  3  Lihat watchlist             9  Simulasi skenario\n"
              << "  4  Tambah ke watchlist        10  Buka dashboard\n"
              << "  5  Hapus dari watchlist       11  Bandingkan saham\n"
              << "  6  Tambah/ubah posisi         12  Kelola price alert\n"
              << "  0  Keluar\n";
}
}

int main(int argc, char** argv) {
    SetConsoleOutputCP(CP_UTF8);
    SetConsoleCP(CP_UTF8);
    const bool demo = argc == 2 && std::string(argv[1]) == "--demo";
    if (argc > 1 && !demo) {
        std::cerr << "Pemakaian: StockWatch.exe [--demo]\n";
        return 1;
    }
    try {
        LocalApi api;
        connectApi(api, demo);
        auto data = loadData(demo);
        if (runDashboard(data, demo, request) == DashboardExit::quit) return 0;
        while (true) {
            menu(demo);
            try {
                switch (static_cast<int>(askNumber("Pilihan: ", 0, 12, true))) {
                    case 0: return 0;
                    case 1: search(); break;
                    case 2: printQuote(request("/stocks/" + instrumentCode(ask("Kode saham atau IHSG: ")))); break;
                    case 3: showWatchlist(data); break;
                    case 4: editWatchlist(data, demo, false); break;
                    case 5: editWatchlist(data, demo, true); break;
                    case 6: editPosition(data, demo, false); break;
                    case 7: editPosition(data, demo, true); break;
                    case 8: showPortfolio(data, false); break;
                    case 9: showPortfolio(data, true); break;
                    case 10: {
                        const auto action = runDashboard(data, demo, request);
                        if (action == DashboardExit::quit) return 0;
                        if (action == DashboardExit::unavailable) {
                            std::cout << "Dashboard membutuhkan terminal interaktif Windows.\n";
                        }
                        break;
                    }
                    case 11: compareStocks(); break;
                    case 12: manageAlerts(data, demo); break;
                }
            } catch (const std::exception& error) {
                std::cout << "Pesan: " << error.what() << '\n';
            }
        }
    } catch (const EndOfInput&) {
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "Gagal memulai terminal: " << error.what() << '\n';
        return 1;
    }
}
