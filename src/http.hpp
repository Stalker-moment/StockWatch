#pragma once

#include <cstddef>
#include <string>

struct HttpResponse {
    unsigned long status;
    std::string body;
    unsigned long retryAfter = 0;
};

HttpResponse httpGet(const std::wstring& host, unsigned short port,
                     const std::string& path, bool https,
                     std::size_t byteLimit = 1024 * 1024,
                     const wchar_t* accept = L"application/json",
                     const std::wstring& bearer = {});
std::string encodeQuery(const std::string& value);
std::string trim(const std::string& value);
inline constexpr const char* ihsgCode = "IHSG";
inline constexpr const char* ihsgName = "Indeks Harga Saham Gabungan";
inline constexpr const char* ihsgSymbol = "^JKSE";

std::string stockCode(std::string value);
std::string instrumentCode(std::string value);
