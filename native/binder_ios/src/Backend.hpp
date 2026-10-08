// The C++ backend (store, recognition, HTTP server) inside the iOS app — the counterpart of binder_android's JNI bridge.
#pragma once

#include <string>

namespace binder_ios {

// Starts the backend once and returns the port it serves on (127.0.0.1), or -1 (the reason is in the log).
// `download_now` false holds the first-launch catalog download back until start_download().
int start_backend(bool download_now);

// Starts the catalog download that start_backend(false) held back.
void start_download();

// Whether the catalog files are still missing from the app's data directory (so a download is coming).
bool catalog_missing();

}  // namespace binder_ios
