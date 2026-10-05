#include <fstream>
#include <map>

#include "cardpaths/cardpaths.hpp"
#include "cardtest.hpp"

namespace fs = std::filesystem;

static void touch(const fs::path& p, const std::string& content = "x") {
    fs::create_directories(p.parent_path());
    std::ofstream(p) << content;
}

static cardpaths::Environment make_env(const std::string& os, const fs::path& home, const fs::path& exe,
                                       std::map<std::string, std::string> vars = {}) {
    cardpaths::Environment e;
    e.os = os;
    e.home = home;
    e.exe_path = exe;
    e.cwd = home;  // nothing interesting under cwd unless a test says so
    e.getenv = [vars](const std::string& k) {
        auto it = vars.find(k);
        return it == vars.end() ? std::string() : it->second;
    };
    return e;
}

int main() {
    cardtest::TempDir tmp;
    const fs::path home = tmp.path() / "home";
    const fs::path nowhere = tmp.path() / "nowhere" / "bin" / "binder";

    // ---- per-OS user data directories (match what platformdirs gave the Python build)
    {
        auto p = cardpaths::resolve(make_env("linux", home, nowhere), {});
        CHECK_EQ(p.user_data_dir, home / ".local" / "share" / "Binder");
        CHECK_EQ(p.log_dir, p.user_data_dir / "logs");
        CHECK_EQ(p.data_dir, p.user_data_dir / "data");
        CHECK_EQ(p.db_path, p.user_data_dir / "db.json");
        CHECK_EQ(p.startup_log, p.user_data_dir / "logs" / "startup.log");
    }
    {
        auto p = cardpaths::resolve(make_env("linux", home, nowhere, {{"XDG_DATA_HOME", "/xdg"}}), {});
        CHECK_EQ(p.user_data_dir, fs::path("/xdg") / "Binder");
    }
    {
        auto p = cardpaths::resolve(make_env("macos", home, nowhere), {});
        CHECK_EQ(p.user_data_dir, home / "Library" / "Application Support" / "Binder");
    }
    {
        auto p = cardpaths::resolve(make_env("windows", home, nowhere, {{"APPDATA", "C:/Users/me/AppData/Roaming"}}), {});
        CHECK_EQ(p.user_data_dir, fs::path("C:/Users/me/AppData/Roaming") / "BinderCardTracker" / "Binder");
        auto q = cardpaths::resolve(make_env("windows", home, nowhere), {});
        CHECK_EQ(q.user_data_dir, home / "AppData" / "Roaming" / "BinderCardTracker" / "Binder");
    }

    // ---- overrides: Options beat env vars beat defaults (Android passes Options)
    {
        cardpaths::Options o;
        o.user_data_dir = tmp.path() / "opt-data";
        auto p = cardpaths::resolve(make_env("android", home, nowhere, {{"BINDER_USER_DATA_DIR", "/env-data"}}), o);
        CHECK_EQ(p.user_data_dir, tmp.path() / "opt-data");
        auto q = cardpaths::resolve(make_env("linux", home, nowhere, {{"BINDER_USER_DATA_DIR", "/env-data"}}), {});
        CHECK_EQ(q.user_data_dir, fs::path("/env-data"));
    }

    // ---- frontend discovery
    {
        // Windows/Linux zip layout: <exe_dir>/frontend
        fs::path exe = tmp.path() / "install" / "Binder" / "binder";
        touch(exe.parent_path() / "frontend" / "index.html");
        touch(exe.parent_path() / "data" / "cards.sqlite3");
        auto p = cardpaths::resolve(make_env("linux", home, exe), {});
        CHECK(p.frontend_found);
        CHECK_EQ(p.frontend_dir, exe.parent_path() / "frontend");
        CHECK(p.bundled_data_dir.has_value());
        CHECK_EQ(*p.bundled_data_dir, exe.parent_path() / "data");
    }
    {
        // macOS .app bundle: Contents/MacOS/binder -> Contents/Resources/frontend
        fs::path exe = tmp.path() / "Binder.app" / "Contents" / "MacOS" / "binder";
        touch(tmp.path() / "Binder.app" / "Contents" / "Resources" / "frontend" / "index.html");
        auto p = cardpaths::resolve(make_env("macos", home, exe), {});
        CHECK(p.frontend_found);
        CHECK_EQ(p.frontend_dir, tmp.path() / "Binder.app" / "Contents" / "Resources" / "frontend");
        CHECK(!p.bundled_data_dir.has_value());  // nothing shipped
    }
    {
        // dev checkout: the exe lives under <repo>/build/..., frontend is <repo>/app
        fs::path repo = tmp.path() / "checkout";
        touch(repo / "app" / "index.html");
        fs::path exe = repo / "build" / "binder" / "binder";
        auto p = cardpaths::resolve(make_env("linux", home, exe), {});
        CHECK(p.frontend_found);
        CHECK_EQ(p.frontend_dir, repo / "app");
        CHECK(!p.bundled_data_dir.has_value());  // "app" isn't an installed "frontend" dir
    }
    {
        // explicit override wins even when other candidates exist
        fs::path custom = tmp.path() / "custom-frontend";
        touch(custom / "index.html");
        cardpaths::Options o;
        o.frontend_dir = custom;
        auto p = cardpaths::resolve(make_env("linux", home, nowhere), o);
        CHECK(p.frontend_found);
        CHECK_EQ(p.frontend_dir, custom);
    }
    {
        // nothing found: reported, with the candidates that were tried
        cardpaths::Options o;
        o.frontend_dir = tmp.path() / "missing";
        auto p = cardpaths::resolve(make_env("linux", home, nowhere), o);
        CHECK(!p.frontend_found);
        CHECK_EQ(p.frontend_dir, tmp.path() / "missing");
        CHECK(p.frontend_candidates.size() > 1);
    }

    // ---- ensure_dirs + ensure_bundled_catalog
    {
        fs::path exe = tmp.path() / "i2" / "Binder" / "binder";
        touch(exe.parent_path() / "frontend" / "index.html");
        touch(exe.parent_path() / "data" / "cards.sqlite3", "catalog");
        touch(exe.parent_path() / "data" / "models" / "m.onnx", "model");
        cardpaths::Options o;
        o.user_data_dir = tmp.path() / "userdata";
        auto p = cardpaths::resolve(make_env("linux", home, exe), o);

        cardpaths::ensure_dirs(p);
        CHECK(fs::is_directory(p.user_data_dir));
        CHECK(fs::is_directory(p.log_dir));

        CHECK(cardpaths::ensure_bundled_catalog(p));  // first run copies it over
        CHECK(fs::exists(p.data_dir / "cards.sqlite3"));
        CHECK(fs::exists(p.data_dir / "models" / "m.onnx"));

        std::ofstream(p.data_dir / "cards.sqlite3") << "user-updated";
        CHECK(!cardpaths::ensure_bundled_catalog(p));  // never clobbers an existing catalog
        std::ifstream f(p.data_dir / "cards.sqlite3");
        std::string got;
        std::getline(f, got);
        CHECK_EQ(got, std::string("user-updated"));
    }

    return cardtest::finish("cardpaths");
}
