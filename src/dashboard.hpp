#pragma once

#include "portfolio.hpp"

using ApiLoader = nlohmann::json (*)(const std::string&);
enum class DashboardExit { menu, quit, unavailable };

DashboardExit runDashboard(TerminalData& data, bool demo, ApiLoader load);
