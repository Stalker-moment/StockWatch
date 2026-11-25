#pragma once

#include <array>

struct ChartPeriod {
    const char* range;
    const char* label;
    const char* interval;
    int demoBars;
    int secondsPerBar;
};

inline constexpr std::array<ChartPeriod, 8> chartPeriods{{
    {"1d",  "1D",  "1m",  300, 60},
    {"5d",  "5D",  "15m", 120, 15 * 60},
    {"1mo", "1M",  "1d",  22,  86400},
    {"3mo", "3M",  "1d",  66,  86400},
    {"6mo", "6M",  "1d",  132, 86400},
    {"ytd", "YTD", "1d",  234, 86400},
    {"1y",  "1Y",  "1d",  252, 86400},
    {"5y",  "5Y",  "1wk", 261, 7 * 86400},
}};
inline constexpr int defaultChartPeriod = 2;
