# Binder

A trading-card collection tracker with a camera scanner for **Magic: The Gathering**, **Pokémon** and **Yu-Gi-Oh!**,
for Windows, macOS, Linux and Android.

- Keep collections of cards (with condition and quantity), search the card database, and scan a card with the camera: the
  scanner finds the card in the frame, reads its set code and collector number (or title) with OCR, looks it up in a local
  catalog, and uses an image-embedding match on the card art to pick the exact printing.
- Everything runs locally. The backend is C++; the UI is plain HTML/CSS/JS (`app/`) shown in the system web view.

See **[BUILDING.md](BUILDING.md)** to build, run, test, package and build the card catalog, and
[native/README.md](native/README.md) for how the C++ code is organised into modules. Android is in
[android/README.md](android/README.md).

```
app/        the frontend
native/     the C++ modules and the app (cmake -S native ...)
android/    the Android app
```
