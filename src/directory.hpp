#pragma once

#include "json.hpp"

#include <chrono>
#include <mutex>

class StockDirectory {
public:
    nlohmann::json snapshot();

private:
    std::mutex mutex_;
    nlohmann::json last_;
    std::chrono::steady_clock::time_point nextFetch_{};
};
