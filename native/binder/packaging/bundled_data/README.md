# Bundling a prebuilt card catalog (optional)

`binder-catalog` (see [BUILDING.md](../../../../BUILDING.md)) produces, in Binder's data directory:

```
cards.sqlite3
card-vectors.cvi
yolo_card_detector.onnx      (+ yolo_card_detector.names.json)
dinov2_vits14.onnx
ocr_det.onnx  ocr_rec.onnx  ocr_dict.txt
```

Building that is slow and network-heavy, and the model files need the original ML frameworks to export
(`native/cardnet/export/`) — not something an end user should do. Two options for a packaged app:

**Ship without it (default).** Leave this folder as it is. Desktop builds with libcurl download `cards.sqlite3` and
`card-vectors.cvi` from the `Assets` GitHub release on first launch (see BUILDING.md); `--no-download` turns that off. The app starts fine; scanning answers "the card catalog
hasn't been built yet" until someone points it at a catalog built separately (copy the files into the app's data
directory).

**Ship with it.** Copy the files above into this folder *before configuring the build*. `cmake --install` puts everything
here (except this README) into the app as `data/` (`Binder/data` on Windows and Linux, `Binder.app/Contents/Resources/data`
on macOS). On first launch the app copies it into the per-user data directory — once, and never over an existing catalog —
because the install folder can be read-only (Program Files, a signed `.app`).

CI fills this folder with `dinov2_vits14.onnx`, `ocr_det.onnx`, `ocr_rec.onnx` and `ocr_dict.txt` before it builds the desktop
apps (the `Models` job), so the release zips include them. Don't commit those files here.
