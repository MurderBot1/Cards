#include "Logger.h"

#include <chrono>
#include <ctime>
#include <iomanip>
#include <iostream>
#include <sstream>

Logger& Logger::instance() {
    static Logger logger;
    return logger;
}

void Logger::openFile(const std::string& path) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (file_.is_open()) {
        file_.close();
    }
    file_.open(path, std::ios::app);
}

std::string Logger::timestamp() {
    auto now = std::chrono::system_clock::now();
    std::time_t t = std::chrono::system_clock::to_time_t(now);
    std::tm tmBuf{};
#ifdef _WIN32
    localtime_s(&tmBuf, &t);   // MSVC/Windows: reversed args, returns errno_t
#else
    localtime_r(&t, &tmBuf);   // POSIX: thread-safe localtime
#endif

    std::ostringstream oss;
    oss << std::put_time(&tmBuf, "%Y-%m-%d %H:%M:%S");
    return oss.str();
}

const char* Logger::levelName(LogLevel level) {
    switch (level) {
        case LogLevel::Info:  return "INFO ";
        case LogLevel::Warn:  return "WARN ";
        case LogLevel::Error: return "ERROR";
    }
    return "?????";
}

void Logger::log(LogLevel level, const std::string& message) {
    std::lock_guard<std::mutex> lock(mutex_);
    std::ostringstream line;
    line << "[" << timestamp() << "] [" << levelName(level) << "] " << message;

    std::ostream& out = (level == LogLevel::Error) ? std::cerr : std::cout;
    out << line.str() << std::endl;

    if (file_.is_open()) {
        file_ << line.str() << std::endl;
        file_.flush();
    }
}