#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif

#include "httplib.h"
#include "http.hpp"
#include "market.hpp"

#include <algorithm>
#include <future>
#include <iostream>
#include <sstream>
#include <vector>

using nlohmann::json;

namespace {
constexpr int port = 8787;

void setCors(httplib::Response& response) {
    response.set_header("Access-Control-Allow-Origin", "*");
    response.set_header("Access-Control-Allow-Methods", "GET, OPTIONS");
    response.set_header("Access-Control-Allow-Headers", "Content-Type");
    response.set_header("Access-Control-Allow-Private-Network", "true");
    response.set_header("Cache-Control", "no-store");
}

void send(httplib::Response& response, int status, const json& body) {
    response.status = status;
    setCors(response);
    response.set_content(body.dump(), "application/json; charset=utf-8");
}

template<typename Action>
void respond(httplib::Response& response, Action action) {
    try {
        send(response, 200, {{"ok", true}, {"data", action()}});
    } catch (const std::invalid_argument& error) {
        send(response, 400, {{"ok", false}, {"message", error.what()}});
    } catch (const MarketError& error) {
        send(response, error.status, {{"ok", false}, {"message", error.what()}});
    } catch (const std::exception& error) {
        std::cerr << "API: " << error.what() << '\n';
        send(response, 500, {{"ok", false}, {"message", "Terjadi kesalahan pada API"}});
    }
}

json compare(Market& market, const std::string& input) {
    if (input.empty() || input.size() > 100 || input.back() == ',') {
        throw std::invalid_argument("Masukkan 1 sampai 8 kode saham dipisahkan koma");
    }
    std::istringstream stream(input);
    std::vector<std::string> codes;
    std::string item;
    while (std::getline(stream, item, ',')) {
        const auto code = stockCode(item);
        if (std::find(codes.begin(), codes.end(), code) == codes.end()) codes.push_back(code);
    }
    if (codes.size() > 8) throw std::invalid_argument("Maksimal 8 kode saham per permintaan");

    std::vector<std::future<json>> pending;
    for (const auto& code : codes) {
        pending.push_back(std::async(std::launch::async, [&market, code] {
            try {
                return market.quote(code);
            } catch (const MarketError& error) {
                return json{{"code", code}, {"error", error.what()}};
            }
        }));
    }

    std::vector<json> rows;
    for (auto& request : pending) rows.push_back(request.get());
    const auto hasChange = [](const json& row) {
        return row.contains("changePercent") && row["changePercent"].is_number();
    };
    std::stable_sort(rows.begin(), rows.end(), [hasChange](const json& a, const json& b) {
        if (hasChange(a) != hasChange(b)) return hasChange(a);
        if (!hasChange(a)) return false;
        return a["changePercent"].get<double>() > b["changePercent"].get<double>();
    });
    return rows;
}
}

int main(int argc, char** argv) {
    const bool demo = argc == 2 && std::string(argv[1]) == "--demo";
    if (argc > 1 && !demo) {
        std::cerr << "Pemakaian: StockWatchApi.exe [--demo]\n";
        return 1;
    }

    Market market(demo);
    httplib::Server server;
    server.new_task_queue = [] { return new httplib::ThreadPool(4); };
    server.Options(R"(/.*)", [](const auto&, auto& response) {
        setCors(response);
        response.status = 204;
    });
    server.Get("/health", [demo](const auto&, auto& response) {
        send(response, 200, {{"ok", true}, {"data", {{"demo", demo}}}});
    });
    server.Get("/stocks/search", [&market](const auto& request, auto& response) {
        respond(response, [&] { return market.search(request.get_param_value("q")); });
    });
    server.Get("/stocks/compare", [&market](const auto& request, auto& response) {
        respond(response, [&] { return compare(market, request.get_param_value("codes")); });
    });
    server.Get("/stocks/directory", [&market](const auto&, auto& response) {
        respond(response, [&] { return market.directory(); });
    });
    server.Get(R"(/stocks/([^/]+)/trades)", [&market](const auto& request, auto& response) {
        respond(response, [&] { return market.trades(request.matches[1].str()); });
    });
    server.Get(R"(/stocks/([^/]+)/history)", [&market](const auto& request, auto& response) {
        respond(response, [&] {
            const auto range = request.has_param("range") ? request.get_param_value("range") : "1mo";
            return market.history(request.matches[1].str(), range);
        });
    });
    server.Get(R"(/stocks/([^/]+))", [&market](const auto& request, auto& response) {
        respond(response, [&] { return market.quote(request.matches[1].str()); });
    });
    server.set_error_handler([](const auto&, auto& response) {
        if (response.body.empty()) {
            send(response, response.status, {{"ok", false}, {"message", "Permintaan API tidak tersedia"}});
        }
    });
    if (!server.bind_to_port("127.0.0.1", port)) {
        std::cerr << "API gagal membuka port " << port << ". Periksa apakah port sudah dipakai.\n";
        return 1;
    }
    std::cout << "STOCKWATCH API | " << (demo ? "DEMO - DATA CONTOH" : "PASAR - STOCKBIT / YAHOO FINANCE")
              << "\nhttp://127.0.0.1:" << port << " | Ctrl+C untuk berhenti\n" << std::flush;
    return server.listen_after_bind() ? 0 : 1;
}
