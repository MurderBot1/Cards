// Opening a download in the system browser, for the app's "update available" banner. The page can't do it itself:
// inside the app's window a link to a download would replace the app.
#pragma once

#include <string>

namespace binder {

// Only this project's GitHub release pages and downloads may be opened: https://github.com/MurderBot1/Cards/releases/...
// with nothing in the URL a shell or the OS could treat specially.
bool is_release_url(const std::string& url);

// Hands `url` to the OS's default browser (ShellExecute / `open` / `xdg-open`, no shell involved). false if it isn't
// a release URL or the opener couldn't be started. Always false on Android, whose WebView has its own bridge.
bool open_release_url(const std::string& url);

}  // namespace binder
