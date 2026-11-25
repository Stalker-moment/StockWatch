#pragma once

#include "json.hpp"

#include <cstddef>
#include <string>
#include <vector>

constexpr std::size_t maxStocks = 8;
constexpr std::size_t maxAlerts = 12;

struct Position {
    std::string code;
    int lots;
    double buyPrice;
};

struct PriceAlert {
    std::string code;
    double target;
    bool above;
    bool triggered = false;
};

struct TerminalData {
    std::vector<std::string> watchlist;
    std::vector<Position> positions;
    std::vector<PriceAlert> alerts;
};

struct ScenarioResult {
    double currentValue;
    double projectedValue;
    double impact;
};

double positionValue(const Position& position, double price);
ScenarioResult simulate(const Position& position, double price, double percent);
std::string money(double amount);
std::string indexPoints(double value);
std::string percentText(double amount, bool signedValue = true);
TerminalData loadData(bool demo);
void saveData(const TerminalData& data, bool demo);
