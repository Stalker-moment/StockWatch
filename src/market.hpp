#pragma once

#include "directory.hpp"

#include <chrono>
#include <map>
#include <mutex>
#include <stdexcept>
#include <string>

struct MarketError : std::runtime_error {
    int status;
    MarketError(int status, const std::string& message)
        : std::runtime_error(message), status(status) {}
};

class Market {
public:
    explicit Market(bool demo) : demo_(demo) {}
    nlohmann::json quote(const std::string& code);
    nlohmann::json search(const std::string& query);
    nlohmann::json directory();
    nlohmann::json history(const std::string& code, const std::string& range);
    nlohmann::json trades(const std::string& symbol);

private:
    struct CachedQuote {
        nlohmann::json quote;
        std::chrono::steady_clock::time_point fetched;
    };

    bool demo_;
    std::mutex cacheMutex_;
    std::map<std::string, CachedQuote> cache_;
    std::map<std::string, CachedQuote> histories_;
    std::map<std::string, CachedQuote> sessionStats_;
    std::mutex tradesMutex_;
    std::map<std::string, CachedQuote> tradePages_;
    std::chrono::steady_clock::time_point retryTrades_{};
    std::string tradesError_;
    int tradesStatus_ = 0;
    StockDirectory directory_;
    std::mutex stockbitMutex_;
    std::chrono::steady_clock::time_point stockbitBackoff_{};
    std::chrono::steady_clock::time_point stockbitSlot_{};

    nlohmann::json stockbitQuote(const std::string& code);
};
