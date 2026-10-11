# Building, running and shipping Binder

Binder is a C++ app. The backend (card store, recognition, HTTP server) and the desktop shell are C++ built with CMake
from `native/`; the UI is the HTML/CSS/JS in `app/`, shown in the system web view (WebKitGTK on Linux, WKWebView on
macOS, WebView2 on Windows) or, on Android, a native `WebView`. There is no Python in the app, its build or its tests;
the only Python left is three offline model-conversion scripts (see [Models](#models)).

```
app/        the frontend (index.html, css/, js/)
native/     the C++ modules and the app — see native/README.md for the module map
android/    the Android app (Kotlin + the NDK build of native/)
```

## Prerequisites

| | Linux | macOS | Windows |
|---|---|---|---|
| Compiler | GCC ≥ 9 or Clang | Xcode command-line tools | Visual Studio 2019/2022 or Build Tools, with the "Desktop development with C++" workload |
| CMake | ≥ 3.18 | ≥ 3.18 | ≥ 3.18 |
| Window | `libgtk-3-dev libwebkit2gtk-4.1-dev` | built in | WebView2 runtime (ships with Windows 10/11) |
| Catalog tool | `libcurl4-openssl-dev zlib1g-dev` | built in | downloaded and built for you |
| Tests | `xvfb` for the window test | | |

Everything else is downloaded and, where needed, built at configure time, pinned in `native/cmake/Deps.cmake`:
nlohmann/json, cpp-httplib, webview, OpenCV (`core`, `imgproc`, `imgcodecs` only), SQLite, and a prebuilt ONNX Runtime
for your platform. OpenCV and SQLite are taken from the system when it has them, unless `-DBINDER_STATIC_DEPS=ON`
(what release builds use). The first OpenCV build takes several minutes; CI caches it.

## Build, test, run

```
cmake -S native -B build/native -DCMAKE_BUILD_TYPE=Release
cmake --build build/native --parallel
ctest --test-dir build/native --output-on-failure        # on Linux: xvfb-run -a ctest ...   (the window test needs a display)

build/native/bin/binder                                   # opens the window
build/native/bin/binder --headless                        # no window: serve the whole LAN on port 5000
```

(Executables land in `<build>/bin/`, or `<build>/bin/Release/` with the Visual Studio generator. `RunApp.bat` does all of
this on Windows.)

`RunApp.bat` uses Visual Studio when it finds it and falls back to GCC (MinGW-w64 with Ninja or `mingw32-make` on PATH)
otherwise; with GCC the executables land in `build\native\bin\`. The GCC path is untested in CI.

`binder` options: `--headless`, `--port N` (default: any free port in window mode, 5000 with `--headless`),
`--data-dir DIR`, `--frontend-dir DIR`. `--headless` exposes the API to your whole network — only use it on networks you
trust.

### Build options

| Option | Default | |
|---|---|---|
| `BINDER_BUILD_TESTS` | ON | build every module's tests |
| `BINDER_WITH_VIEW` | ON | the native window (`cardview`); OFF gives a binary that just serves |
| `BINDER_WITH_ONNX` | ON | the detector / OCR / embedder (downloads ONNX Runtime); OFF skips those pipeline stages |
| `BINDER_WITH_CATALOG_TOOL` | ON | `binder-catalog`; skipped automatically if libcurl or zlib isn't found |
| `BINDER_STATIC_DEPS` | OFF | build OpenCV and SQLite from source and link them statically |
| `BINDER_FORCE_FETCH_OPENCV` | OFF | build OpenCV from source even if the system has one |

## Where things live at run time

Everything the app *writes* is in the per-user data directory (the install folder can be read-only):

| | |
|---|---|
| Windows | `%APPDATA%\BinderCardTracker\Binder` |
| macOS | `~/Library/Application Support/Binder` |
| Linux | `$XDG_DATA_HOME/Binder` (default `~/.local/share/Binder`) |

containing `db.json` (collections and settings), `logs/` (`api.log`, `startup.log`) and `data/` (the card catalog and
models, below). `--data-dir` or `BINDER_USER_DATA_DIR` overrides it. The frontend is found next to the executable
(`frontend/`, or `Resources/frontend` in a macOS `.app`), or in `app/` of a checkout.

## The card catalog

Scanning needs a catalog and a vector index, built once by `binder-catalog` (a port of the old
`build_scanner_models.py`). It downloads card data from Scryfall (MTG, every printing incl. other languages),
PokemonTCG and YGOPRODeck, downloads each card's image, embeds it with DINOv2 and builds the index:

```
build/native/bin/binder-catalog                  # everything, into the app's data directory
build/native/bin/binder-catalog --only pokemon   # one game
build/native/bin/binder-catalog --skip-vectors   # data and images only
build/native/bin/binder-catalog --help
```

On Windows the executable is `build\native\bin\Release\binder-catalog.exe` (Visual Studio puts the build type in the path).

It is safe to re-run: bulk downloads are cached under `data/cache/`, images and vectors already done are skipped, and an
interrupted run resumes (the index is written before the catalog records rows that point into it, so a crash never leaves
dangling references). The images are a scratch copy, deleted once the vectors exist (`--keep-images` to keep them).

On Windows the build downloads and compiles its own zlib and libcurl (libcurl using the Windows TLS stack), so nothing extra
is needed there. The files it writes are portable, so you can also build the catalog on
Linux or macOS and copy `cards.sqlite3` and `card-vectors.cvi` into the data directory of any install, or into
`native/binder/packaging/bundled_data/` to ship them with the app.

### Models

The recognizer uses three trained models as ONNX files in the same `data/` directory: `yolo_card_detector.onnx`
(+ `.names.json`), `ocr_det.onnx` / `ocr_rec.onnx` / `ocr_dict.txt`, and `dinov2_vits14.onnx` (also what `binder-catalog`
embeds with). **None is required**: without a detector the card is found by contour detection, without OCR it falls back
to art matching, without the embedder there is no art matching. Producing them means converting trained PyTorch /
Ultralytics / PaddleOCR models, which needs those frameworks — `native/cardnet/export/*.py` are the only Python in the
repo, one-off developer tooling. Training the YOLO card detector needs a labelled photo dataset that doesn't exist to
download; see `native/cardnet/export/export_yolo.py`.

## Packaging

`cmake --install build/native --component binder --prefix dist` lays out the app as it is shipped (the component keeps
the downloaded dependencies' own install rules out of it), and CI zips it:

| | Layout |
|---|---|
| Windows `Binder-windows-setup.exe` | an NSIS installer (`native/binder/packaging/windows/installer.nsi`) for: `binder.exe`, `frontend/`, `onnxruntime.dll`, the MSVC runtime |
| macOS `Binder-macos-arm64.dmg` | a disk image with `Binder.app` (`Info.plist` with the camera usage string, icon, `Frameworks/libonnxruntime.dylib`) and an Applications shortcut |
| Linux `Binder-linux-amd64.deb` | a package (`native/binder/packaging/linux/make-deb.sh`) with `/opt/binder/{binder, frontend/, libonnxruntime.so*}`, `/usr/bin/binder` and a menu entry |

What `cmake --install` lays out (`Binder/…` on Windows and Linux, `Binder.app` on macOS) is what those installers wrap, and CI
installs each one (silently on Windows, with `apt` on Linux, by mounting the image on macOS) as a smoke test before it
uploads it.

- **Windows installer:** per user, no administrator prompt, into `%LOCALAPPDATA%\Programs\Binder` (Start menu shortcut,
  an entry in Settings → Apps). Run over an existing install it upgrades it; the collections, settings and card catalog
  live in the user's app-data folder, so installing and uninstalling never touch them. It is unsigned, so SmartScreen
  shows "Windows protected your PC" the first time: More info → Run anyway.
- **Linux package:** `sudo apt install ./Binder-linux-amd64.deb` (pulls in GTK and WebKitGTK). Debian/Ubuntu only; there
  is no RPM.

- **macOS:** the runners are arm64, so the app only runs on Apple Silicon, and it is **unsigned and un-notarized**.
  Gatekeeper refuses it on first launch: right-click → Open, or `xattr -dr com.apple.quarantine Binder.app`. Shipping to
  other people means signing with a Developer ID and notarizing it, which needs an Apple developer account.
- **Linux:** running it needs GTK 3 and WebKitGTK 4.1 (`libwebkit2gtk-4.1-0` on Debian/Ubuntu). It is built on Ubuntu 22.04
  so its glibc requirement stays low.
- **Windows:** the web view is the Microsoft Edge WebView2 runtime, present on Windows 10/11. Windows ships its own, older
  `onnxruntime.dll` in `System32`; the app and the tests use the copy next to the executable.
- The window's camera: Windows and macOS ask the user. WebKitGTK denies camera access unless the app allows it, so
  `cardview` allows *video-only* requests on Linux.

The Windows, macOS and Linux zips also ship the DINOv2 and OCR models. A `Models` CI job converts them with the scripts in
`native/cardnet/export/` (the one job that uses Python) and the desktop jobs drop them into
`native/binder/packaging/bundled_data/` before configuring, so `cmake --install` puts them in the app's `data/`; the app
copies that into the user data directory on first launch (only if it's empty, so an existing install keeps what it has).
The card detector and the card catalog (`cards.sqlite3`, `card-vectors.cvi`) are not bundled, but the desktop app
downloads the catalog on first launch: whichever of the two files is missing from the data directory is fetched in the
background from the [`Assets` release](https://github.com/MurderBot1/Cards/releases/tag/Assets) (about 1.2 GB; files
already there are never replaced, and a `.part` file is only renamed once complete, so an interrupted download retries on
the next launch). While it runs the app shows a "Setting up the app for you" screen with the current task (`GET /api/setup`; other
first-run work can report itself through `binder::SetupStatus`). Pass `--no-download` to skip the download. It needs the build to have libcurl (the same requirement as
`binder-catalog`); to publish a newer catalog, replace the two assets on that release. The Android APK doesn't
bundle any models.

The CI (`.github/workflows/build.yml`) runs the whole test suite first, then builds, tests, packages and uploads each
platform. A push to `main` also publishes the results to a GitHub release (see below).

## Android

`android/` is a small Kotlin app: a `WebView` plus `libbinder_native.so`, the same backend built by the NDK through CMake
(`native/binder_android`), loaded over JNI by `NativeBackend.kt`. ONNX Runtime comes from its official AAR.

```
cd android && gradle assembleDebug        # or open android/ in Android Studio
```

Needs the Android SDK (AGP downloads the NDK and CMake 3.22 it asks for), JDK 17, and builds `arm64-v8a` and `x86_64`. The
first build compiles OpenCV for each ABI, which is slow. The catalog and models are not bundled in the APK; the app
downloads the catalog on first launch (like the desktop one), or you can put
`cards.sqlite3`, `card-vectors.cvi` (and any `.onnx` files) in the app's private `files/data/` directory, e.g. for
development `adb push` them and copy with `run-as com.bindercardtracker.binder`. (Models are still not downloaded.)

## iOS

`native/binder_ios` is a small UIKit app (Objective-C++): the same C++ backend on localhost plus a `WKWebView`, with downloads
going through `NSURLSession`. CI builds it on a macOS runner (`ios` job) and attaches `Binder-ios-unsigned.ipa` to each
release. ONNX Runtime comes from its CocoaPods archive, OpenCV is built from source.

The IPA is **unsigned**, so iOS won't run it as is; sign it on the device when you install it:

- **AltStore** or **Sideloadly** (free): open the IPA with your Apple ID. A free Apple ID's signature lasts 7 days, after
  which the app has to be re-signed (AltStore does this automatically while it's running on your network).
- A paid Apple Developer account gives a year-long signature and lets you distribute through TestFlight.

Building locally needs Xcode: `cmake -S native -B build-ios -DCMAKE_SYSTEM_NAME=iOS -DCMAKE_OSX_SYSROOT=iphoneos
-DCMAKE_OSX_ARCHITECTURES=arm64 -DCMAKE_OSX_DEPLOYMENT_TARGET=15.0 -DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY
-DBINDER_STATIC_DEPS=ON -DBINDER_WITH_VIEW=OFF -DBINDER_WITH_CATALOG_TOOL=OFF -DBINDER_BUILD_TESTS=OFF`, then build the
`binder_ios` target (see the `ios` job in `.github/workflows/build.yml` for the packaging into the IPA).

## Login server

Accounts are handled by a small Cloudflare Worker with a D1 database (free tier) in [`cloudflare/`](cloudflare/README.md): sign-up
takes a username, email and password, and sign-in returns a session token the app keeps. The app calls it directly over
HTTPS; set its address as `AUTH_URL` in `app/js/config.js` (setup steps are in `cloudflare/README.md`). Until that is set,
the Sign in screen says accounts aren't set up yet and the rest of the app works as before.

Signed-in devices keep their collections in sync through the same service (the account page shows when it last synced), and
the collection screens show card prices. The Worker does accounts and collection sync and nothing else: card prices are asked of
Scryfall, pokemontcg.io and YGOPRODeck directly from the page (`app/js/priceSources.js`), with no account or setup, and are
cached only on the device.

The older `/api/auth/*` routes in the local backend, which spoke to a separate TCP LoginServer, are no longer used by the
app.

## Website

The same Cloudflare Worker that does accounts also serves the app itself (`cloudflare/wrangler.jsonc` points its static assets
at `app/`), so `https://binder.<account>.workers.dev/` is a website version of Binder. There is no local backend there, so
`app/js/env.js` switches the page into web mode whenever it is served from anything but localhost (or with `?web=1`):

- **Shop, Collection and Account** are all there. Sign-in and sync work as in the apps.
- **Collections** are kept in the browser (`app/js/webstore.js`, a port of `native/cardstore` that answers the same routes), and
  sync with the account through the same `/sync/state` and `/sync/apply` protocol, so a collection built on the website shows up in
  the apps and the other way round. Without signing in they live only in that browser.
- **Adding cards** goes straight to search (`app/js/cardSearch.js`, which asks Scryfall, pokemontcg.io and YGOPRODeck directly,
  as the prices do). There is no scanning, no card catalog download, no setup screen and no update banner: everything marked
  `data-app-only` in `index.html` is hidden.
- Prices work as in the apps (`priceSources.js`).

Previewing it locally: `cd cloudflare && npm install && npx wrangler dev --local`, then open `http://127.0.0.1:8787/?web=1`. The
Worker deploys from `main` like any other change (nothing about it is in a release: it is not an app).

## Importing and exporting collections

Each collection has an **Import** and an **Export** button (and the collection list has "Import from a file", which makes a new
collection from the file). Both are CSV.

- **Import** (`app/js/collectionCsv.js`, `importMatch.js`, `importExport.js`) reads Moxfield, Deckbox, ManaBox, TCGplayer app,
  Archidekt, Delver Lens and Binder exports, and most other CSVs with a card name column. It reads the header row and works out
  what each column is from its name (Count / Quantity / Qty, Edition / Set / Set Code, Foil / Finish / Printing, ...), tells a
  set *code* from a set *name* by what the column holds, and maps every app's condition wording ("Good (Lightly Played)",
  `lightly_played`, `NM`) onto the five conditions. Choose a file or paste the text. Magic cards are then looked up at Scryfall
  by the most exact thing the file gives (Scryfall id, then set and collector number, then name and set, then the name), which
  gives each its catalog id, rarity and picture, so prices work. Rows that can't be found are still imported as written, and
  other games are imported as written too. Identical cards stack, as when adding by search.
- **Export** writes Binder's own CSV: `Count, Name, Game, Set Code, Collector Number, Rarity, Condition, Foil, Language,
  Binder ID, Scryfall ID, Image URL, Collection`. Binder ID is the catalog id (the Scryfall id for Magic), which lets a
  re-import find the exact card again. Where the file goes depends on where it runs (`app/js/fileSave.js`): a browser download on
  the website, the Downloads folder on desktop (`POST /api/save-file`) and Android (`BinderAndroid.saveFile`), the share sheet
  on iOS (`binderSave`).
- Cards now carry `foil`, `language` (English is the default and isn't stored) and `number` (collector number) as well; they are
  part of what stacks, are synced, and a foil copy is valued at the foil price.
- The apps' column lists were collected from community posts and each app's help pages, not from an official spec; if an
  export from one of them doesn't import, send the file's first line and it is a one-line addition to the header table in
  `collectionCsv.js`.

## Kinds of list and their limits

The Collection tab holds collections, decks, a tradelist and a wishlist. They are stored alike (a name and cards); a list's
`kind` (`deck`, `tradelist`, `wishlist`; a collection has none) says which it is. Limits, by kind:

| Kind | Lists | Different cards per list | Copies of one card |
|---|---|---|---|
| Collection | 25 | 10,000 | 1,000 |
| Deck | 100 | 150 | 100 |
| Tradelist | 1 | 10,000 | no limit |
| Wishlist | 1 | 10,000 | no limit |

There is one tradelist and one wishlist, not several of each: the "New" tile is hidden once it exists, and creating a second
is refused ("You can only have one wishlist"). Deleting it frees the place. Tradelists and wishlists made while several
were allowed (v1.0.14 to v1.0.21) are left alone, none is merged or removed, but no more can be made.

Because there is only one of each, the Tradelist and Wishlist tabs open that list straight away instead of showing a grid with a
"New" tile (`openSingleList` in `app/js/collections.js`); the first time, the list is made quietly, named "Wishlist" or
"Tradelist". It is made with a fixed id, the kind's own name (`POST /api/collections` accepts `id` for these two kinds only, and
only that value; asking again for one that exists returns it with 200). That way two devices that each make theirs before
syncing end up with one list, since the same id merges, instead of two. Where there are several from before the limit, the
oldest opens. Going back (the arrow, or the Collection tab) shows the lists screen on that tab with the single list on it.

A "different card" is a row (the same card in another condition, set, finish or language is its own row). The numbers
live in three places that must agree: `native/cardstore/src/store.cpp` (`limits_for`), `app/js/listKinds.js` (`LIMITS`,
used by the website's store) and `cloudflare/src/sync.js` (`LIMITS`; the Worker checks the cards in a list it is sent,
not how many lists a person has). A list that already holds more than its limit can be read and lowered but not added to.

### Which cards of a deck you have

A deck card can say how many copies the person has: `owned`, a whole number from 1 up to the card's `quantity` (absent
means none; zero is never written). It is set per card (`PATCH .../cards/<id>` with `owned`) or for many at once
(`POST /api/collections/<id>/owned` with `{ owned: { <card id>: <copies> } }`), is refused on anything but a deck, is kept
to what the deck needs when the quantity is lowered, travels through sync with the card, and is exported as a
`Copies Owned` column (read back by an import into a deck). The deck screen's "check my collections" button fills it
from the person's collections (same game and name, any printing; only collections count) and never lowers a card.

### Moving cards between lists

`POST /api/collections/<id>/cards/<card id>/move` with `{ to: <list id>, quantity?: <copies> }` (all copies when
`quantity` is left out) moves copies to any other list, whatever its kind. The copies are added to the other list first
(stacking onto a matching row, under that list's limits, so a full deck refuses) and only then taken out of this one, so a
refusal changes nothing. It answers `{ source, target }`. An emptied row leaves a tombstone so other devices drop it too, and
a deck row's `owned` is kept to what it still needs. The card sheet's "Move to another list…" button uses it.

## Prices in your own currency

Prices come in US dollars (`prices.js`); `app/js/currency.js` shows them in the person's currency. Which one: the pick in
Settings → Prices, else a guess from the device's language region (`en-GB`) or, when the language names no region, its
time zone. No location is asked for and nothing is sent. Rates (dollars to each currency) come from Frankfurter
(`api.frankfurter.dev`, the European Central Bank's rates, free, no key) with `open.er-api.com` as a second source, read by
the page itself and kept in `localStorage` for 12 hours (an old rate still serves offline). With no rate at all, prices stay
in dollars. The price filter and price sorting work in the shown currency. Nothing about this touches the Worker or the
stored data: cards and collections stay as they were.

The picker in Settings → Prices is a card showing the currency in use (symbol, name and code, whether it is automatic or
the person's choice, what US$10 comes to and how old the rates are). Tapping it opens a sheet with a search box and every
currency that has a rate, by name, each with its symbol and the same US$10 sample, "Automatic" first and a tick on the
current pick. What it shows is plain data from `app/js/currencyPicker.js` (tested on its own); `currency.js` draws it.

## A deck's mana curve

A deck with Magic cards has a "Mana curve" panel: copies of its spells by mana value (0 to 7 or more), stacked by color
(white, blue, black, red, green, multicolor, colorless; lands aren't on a curve and are counted apart). Cards don't store
mana values or colors, and nothing here is synced: `app/js/cardInfo.js` looks them up at Scryfall when the panel is opened
(by the card's catalog id, else name and set; up to 75 per request, the same path an import uses) and keeps the answers in
`localStorage` for two weeks (a card that wasn't found, one day). The same look-up also keeps each card's legality by format,
for deck legality checks. The chart's colors are the data-viz palette's first-in-order hues, validated together in both
themes with its `validate_palette.js`; the legend and a table view carry the same numbers.

### A deck's game and format

Making a deck asks for its game (Magic, Pokémon, Yu-Gi-Oh!) and then a format of that game, stored on the deck as `game` and
`format` (`app/js/deckFormats.js`: Magic Standard, Pioneer, Modern, Legacy, Vintage, Pauper, Commander, Brawl; Pokémon
Standard, Expanded, Unlimited; Yu-Gi-Oh! Advanced, Traditional, Speed Duel). The API takes them on `POST /api/collections` and
changes them with `PATCH /api/collections/<id>` (`{game, format}`, both required, decks only); a format must belong to the
game, and nothing else has them. The lists live in three places that must agree: `native/cardstore/src/store.cpp`
(`valid_deck_format`), `app/js/deckFormats.js` and `cloudflare/src/sync.js` (`DECK_FORMATS`; the Worker keeps them only as a
matching pair and the newer copy wins when two devices differ). The deck screen shows "Magic: The Gathering · Modern" (tap it
to change); adding cards starts on the deck's game and a Magic deck's legality panel starts on its format. Only Magic decks
are checked for legality, so for the other games the format is a label. A deck made before this has neither: the screen says
"Set the game and format", starting from the game its cards share. A deck still accepts cards of any game.

## Deck legality

A deck with Magic cards has a Legality panel: pick a format (Standard, Pioneer, Modern, Legacy, Vintage, Pauper, Commander,
Brawl) and it says whether the deck is legal there, and why not (banned or not-legal cards, too few cards, too many
copies), and each card that isn't plainly legal gets a Banned / Not legal / Restricted badge. Card legality is Scryfall's,
from the same device-only look-up as the mana curve (`app/js/cardInfo.js`); the rules are in `app/js/deckLegality.js`: 60 cards
at least and 4 copies for the constructed formats, exactly 100 cards and singleton for Commander, exactly 60 and singleton for
Brawl; basic lands and the few "any number" cards are exempt, and a Vintage-restricted card is limited to one. Copies add up
across printings of the same name. Sideboards aren't tracked (the whole list is checked as a main deck) and neither are a
Commander deck's commander and color identity; the panel says so. Cards not looked up yet (offline) are reported as
unchecked, never as legal.

## Sharing a list

The share button in a list's toolbar (signed in only) makes a public, read-only link such as
`https://<site>/s/<token>`: anyone with it sees the list's name and cards, nothing about the account, and cannot change
anything. Making the link syncs first, because the page is served by the account service (`cloudflare/src/share.js`) from
the copy of the list stored on the account, so it follows later syncs. "Make a new link" replaces the link (the old one
stops working), "Stop sharing" kills it; a deleted list's link stops working too. The app side is `app/js/shareLink.js`
(syncing, retrying while the account hasn't got the list yet, asking the service) and the sheet in `collections.js`. Guests
are told to sign in. The service's table is created automatically (`cloudflare/src/schema.js`), so redeploying the Worker is
all that's needed. See `cloudflare/README.md` for the page's headers and limits.

## Updates

The app checks the project's GitHub releases on startup (and from "Check for updates" on the Account tab) and offers the
newest `vX.Y.Z` release with a banner. **Update** downloads this platform's installer inside the app and installs it:

| | What happens |
|---|---|
| Windows | `Binder-windows-setup.exe` runs silently over the old copy (no prompt: it is a per-user install), then starts the new version |
| macOS | the app mounts `Binder-macos-arm64.dmg`, swaps `Binder.app` for the new one (where the old one was) and reopens it |
| Linux | `pkexec apt-get install` the new `.deb` (a password prompt from the desktop), then starts it again; without polkit/apt it opens the package in the software installer |
| Android | downloads the APK and opens the system installer on it, which always asks for confirmation (the first time it also sends you to the "install unknown apps" switch for Binder) |
| iOS | can't install anything itself: opens the IPA download in Safari, to be sideloaded again |

The backend (`native/binder/src/updater.cpp`, `/api/update/*`; Android: `ApkUpdater.kt`) only downloads this project's
installer files from a `…/releases/download/vX.Y.Z/` URL and refuses to run one whose SHA-256 differs from the digest GitHub
publishes for that asset (so a tampered download is never started). Every launch of a released build starts with a
full-screen "Checking for updates" (it gives up after 6 seconds, so being offline doesn't hold the app up), and when there is
a newer release and "Install updates automatically" on the Account tab is on (the default) it becomes an "Updating Binder"
screen with the download's progress and ends with the app restarting into the new version ("Not now" lets the download
finish in the background and leaves a "Restart to update" button instead). On Android the screen ends with the system
installer opening. While the app stays open, later checks only download and leave a "Restart to update" button, so nothing
closes in the middle of a scan. A release that failed to install is not retried automatically. It can only do that in a *released* build: the
release workflow stamps the version into `app/js/version.js` (and Android's version name and code), while a local build or
the rolling `latest` build says `dev` and never asks to update. Versions before 1.0.8 shipped zips and don't know the
installers' names, so they send you to the release page: install v1.0.8 by hand once and it updates itself from then on.

**Android updates need a fixed signing key.** Android installs a new APK over an old one only if both were signed with the
same key, and a CI runner invents a new debug key every time, so without one the banner's download fails with "App not
installed" until the old app is uninstalled (signed-in collections come back through sync). To give the builds one key, run this on your own computer (it needs a JDK for `keytool`, plus `openssl`; with the
GitHub CLI installed and `gh auth login` done it can also store the secrets for you):

```
scripts/setup-android-signing.sh --set-secrets --repo MurderBot1/Cards
```

It creates `binder.keystore` with a random password, writes the password and instructions to
`binder.keystore.secrets.txt` next to it (**back both up**, and never commit them: `.gitignore` already skips them), and
adds the four secrets below. Without `--set-secrets` it prints the values for you to paste in by hand. To do it all by hand
instead:

```
keytool -genkeypair -v -keystore binder.keystore -alias binder -keyalg RSA -keysize 2048 -validity 10000
base64 -w0 binder.keystore            # macOS: base64 -i binder.keystore
```

and add these repository secrets (Settings → Secrets and variables → Actions): `ANDROID_KEYSTORE_B64` (that base64
text), `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` (`binder`) and `ANDROID_KEY_PASSWORD`. Keep `binder.keystore` somewhere
safe: if it is lost, the next release can't be installed over the old ones. The first build signed with it also needs one
uninstall of the throwaway-signed version.
