#include "UserStore.h"
#include "Sha256.h"
#include "Logger.h"

#include <fstream>
#include <random>
#include <sstream>
#include <iomanip>

std::string UserStore::generateSaltHex() {
    static thread_local std::mt19937_64 rng{std::random_device{}()};
    std::uniform_int_distribution<int> dist(0, 255);

    std::ostringstream oss;
    oss << std::hex << std::setfill('0');
    for (int i = 0; i < 16; ++i) { // 16 bytes = 128-bit salt
        oss << std::setw(2) << dist(rng);
    }
    return oss.str();
}

std::string UserStore::computeHash(const std::string& saltHex, const std::string& password) {
    return Sha256::hashHex(saltHex + password);
}

bool UserStore::load(const std::string& path) {
    std::lock_guard<std::mutex> lock(mutex_);
    path_ = path;

    std::ifstream in(path);
    if (!in.is_open()) {
        // no file yet — not an error, just an empty store
        return true;
    }

    accounts_.clear();
    std::string line;
    while (std::getline(in, line)) {
        if (line.empty() || line[0] == '#') continue;

        // format: username|saltHex|hashHex
        size_t p1 = line.find('|');
        if (p1 == std::string::npos) continue;
        size_t p2 = line.find('|', p1 + 1);
        if (p2 == std::string::npos) continue;

        std::string username = line.substr(0, p1);
        Account acc;
        acc.saltHex = line.substr(p1 + 1, p2 - p1 - 1);
        acc.hashHex = line.substr(p2 + 1);
        accounts_[username] = acc;
    }
    return true;
}

bool UserStore::save() const {
    if (path_.empty()) return true; // nowhere to persist to — in-memory only

    std::ofstream out(path_, std::ios::trunc);
    if (!out.is_open()) return false;

    out << "# username|saltHex|sha256(saltHex+password)\n";
    for (const auto& [username, acc] : accounts_) {
        out << username << "|" << acc.saltHex << "|" << acc.hashHex << "\n";
    }
    return true;
}

bool UserStore::verify(const std::string& username, const std::string& password) const {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = accounts_.find(username);
    if (it == accounts_.end()) return false;
    return computeHash(it->second.saltHex, password) == it->second.hashHex;
}

bool UserStore::addUser(const std::string& username, const std::string& password) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (accounts_.find(username) != accounts_.end()) {
        return false;
    }

    Account acc;
    acc.saltHex = generateSaltHex();
    acc.hashHex = computeHash(acc.saltHex, password);
    accounts_[username] = acc;

    if (!save()) {
        Logger::instance().warn("UserStore: failed to persist accounts to " + path_);
    }
    return true;
}

bool UserStore::exists(const std::string& username) const {
    std::lock_guard<std::mutex> lock(mutex_);
    return accounts_.find(username) != accounts_.end();
}

size_t UserStore::count() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return accounts_.size();
}