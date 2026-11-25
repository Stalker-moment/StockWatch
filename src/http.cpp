#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <winhttp.h>

#include "http.hpp"

#include <algorithm>
#include <cctype>
#include <stdexcept>
#include <utility>

namespace {
class InternetHandle {
public:
    explicit InternetHandle(HINTERNET handle) : handle_(handle) {}
    ~InternetHandle() { if (handle_) WinHttpCloseHandle(handle_); }

    InternetHandle(const InternetHandle&) = delete;
    InternetHandle& operator=(const InternetHandle&) = delete;
    HINTERNET get() const { return handle_; }

private:
    HINTERNET handle_;
};

void check(bool ok, const char* operation) {
    if (!ok) {
        const auto code = GetLastError();
        throw std::runtime_error(std::string(operation) + " (WinHTTP " +
                                 std::to_string(code) + ")");
    }
}
}

HttpResponse httpGet(const std::wstring& host, unsigned short port,
                     const std::string& path, bool https, std::size_t byteLimit,
                     const wchar_t* accept, const std::wstring& bearer) {
    if (!bearer.empty() && (!https || bearer.find_first_of(L"\r\n") != std::wstring::npos))
        throw std::invalid_argument("Header autentikasi tidak valid");
    const auto access = https ? WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY
                              : WINHTTP_ACCESS_TYPE_NO_PROXY;
    InternetHandle session(WinHttpOpen(L"Mozilla/5.0 StockWatch/1.0",
        access, WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0));
    check(session.get() != nullptr, "Tidak bisa membuka sesi HTTP");
    check(WinHttpSetTimeouts(session.get(), 4000, 4000, 4000, https ? 6000 : 22000),
          "Tidak bisa mengatur timeout HTTP");

    InternetHandle connection(WinHttpConnect(session.get(), host.c_str(), port, 0));
    check(connection.get() != nullptr, "Tidak bisa membuat koneksi HTTP");

    const std::wstring target(path.begin(), path.end());
    InternetHandle request(WinHttpOpenRequest(connection.get(), L"GET", target.c_str(),
        nullptr, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES,
        https ? WINHTTP_FLAG_SECURE : 0));
    check(request.get() != nullptr, "Tidak bisa membuat request HTTP");

    DWORD policy = WINHTTP_OPTION_REDIRECT_POLICY_NEVER;
    check(WinHttpSetOption(request.get(), WINHTTP_OPTION_REDIRECT_POLICY,
                           &policy, sizeof(policy)), "Tidak bisa mengatur redirect");
    auto headers = std::wstring(L"Accept: ") + accept + L"\r\n";
    if (!bearer.empty()) headers += L"Authorization: Bearer " + bearer + L"\r\n";
    check(WinHttpSendRequest(request.get(), headers.c_str(), -1L,
                             WINHTTP_NO_REQUEST_DATA, 0, 0, 0),
          "Gagal mengirim request HTTP");
    check(WinHttpReceiveResponse(request.get(), nullptr), "Gagal menerima respons HTTP");

    DWORD status = 0;
    DWORD size = sizeof(status);
    check(WinHttpQueryHeaders(request.get(), WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                              WINHTTP_HEADER_NAME_BY_INDEX, &status, &size,
                              WINHTTP_NO_HEADER_INDEX), "Status HTTP tidak tersedia");
    std::string body;
    char buffer[8192];
    while (true) {
        DWORD bytesRead = 0;
        check(WinHttpReadData(request.get(), buffer, sizeof(buffer), &bytesRead),
              "Gagal membaca respons HTTP");
        if (bytesRead == 0) break;
        if (body.size() + bytesRead > byteLimit) {
            throw std::runtime_error("Respons HTTP melebihi batas ukuran");
        }
        body.append(buffer, bytesRead);
    }
    DWORD retryAfter = 0;
    if (status == 429) {
        size = sizeof(retryAfter);
        WinHttpQueryHeaders(request.get(), WINHTTP_QUERY_RETRY_AFTER | WINHTTP_QUERY_FLAG_NUMBER,
                            WINHTTP_HEADER_NAME_BY_INDEX, &retryAfter, &size, WINHTTP_NO_HEADER_INDEX);
    }
    return {status, std::move(body), retryAfter};
}

std::string encodeQuery(const std::string& value) {
    const char* hex = "0123456789ABCDEF";
    std::string encoded;
    for (unsigned char c : value) {
        if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
            (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.') {
            encoded += static_cast<char>(c);
        } else {
            encoded += '%';
            encoded += hex[c >> 4];
            encoded += hex[c & 15];
        }
    }
    return encoded;
}

std::string trim(const std::string& value) {
    const auto first = value.find_first_not_of(" \t\r\n");
    if (first == std::string::npos) return {};
    return value.substr(first, value.find_last_not_of(" \t\r\n") - first + 1);
}

std::string stockCode(std::string value) {
    value = trim(value);
    for (char& c : value) c = static_cast<char>(std::toupper(static_cast<unsigned char>(c)));
    if (value.size() > 3 && value.substr(value.size() - 3) == ".JK") {
        value.resize(value.size() - 3);
    }
    if (value.size() != 4 || !std::all_of(value.begin(), value.end(),
        [](char c) { return c >= 'A' && c <= 'Z'; })) {
        throw std::invalid_argument("Kode saham IDX harus berisi 4 huruf, misalnya BBCA");
    }
    return value;
}

std::string instrumentCode(std::string value) {
    value = trim(value);
    for (char& c : value) c = static_cast<char>(std::toupper(static_cast<unsigned char>(c)));
    if (value == ihsgSymbol || value == "JKSE" || value == "COMPOSITE") return ihsgCode;
    return stockCode(value);
}
