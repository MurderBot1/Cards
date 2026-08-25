#pragma once
//
// Logger.h
// -----------------------------------------------------------------
// Small thread-safe logger. Writes timestamped lines to stdout and,
// if opened, to a log file — used to record login attempts (success
// and failure, with source address) plus general server lifecycle
// events (startup, client connect/disconnect, errors).
// -----------------------------------------------------------------
#include <fstream>
#include <mutex>
#include <string>

enum class LogLevel { Info, Warn, Error };

class Logger {
public:
    static Logger& instance();

    // Opens (appending) a log file in addition to stdout. Safe to call
    // more than once; the previous file (if any) is closed first.
    void openFile(const std::string& path);

    void log(LogLevel level, const std::string& message);

    void info(const std::string& message)  { log(LogLevel::Info, message); }
    void warn(const std::string& message)  { log(LogLevel::Warn, message); }
    void error(const std::string& message) { log(LogLevel::Error, message); }

private:
    Logger() = default;

    static std::string timestamp();
    static const char* levelName(LogLevel level);

    std::mutex mutex_;
    std::ofstream file_;
};