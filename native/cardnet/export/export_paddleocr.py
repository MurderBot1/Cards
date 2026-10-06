"""
export_paddleocr.py
-----------------------------------------------------------------
One-time dev step: converts PaddleOCR's English detection + recognition
models to ONNX for native/cardnet's OcrPipeline, via paddle2onnx (the
standard, actively-maintained PaddlePaddle->ONNX converter).

    pip install paddle2onnx

--det-model-dir / --rec-model-dir must each point at a directory
containing a PaddleOCR/PaddleX *inference* model — an
inference.pdmodel + inference.pdiparams pair (older .pdmodel/.pdiparams
naming) or an inference.json + inference.pdiparams pair (PaddleX's
newer format). Finding that directory is the one step this script can't
do for you sight-unseen, since PaddleOCR 3.x's model cache location and
folder-naming convention are internal, version-sensitive details of
whatever paddleocr/paddlex version is installed:

  1. Run the PaddleOCR(...) call the app used to make (English, with its default detection and recognition models) once
     (lang="en", use_textline_orientation=True) — its first run downloads
     the det+rec models and logs where to.
  2. Look for two directories, one per model, generally under something
     like ~/.paddlex/official_models/ — one whose name contains "det",
     one containing "rec". Pass those two directories to this script.

If paddle2onnx complains about an unsupported op, that's a real
incompatibility with the specific PP-OCR model version installed, not a
sign this script is wrong — check paddle2onnx's own issue tracker for
that op, or pin an older/newer PP-OCRv* model release.

Usage:
    python export_paddleocr.py \\
        --det-model-dir /path/to/det_infer_dir \\
        --rec-model-dir /path/to/rec_infer_dir \\
        --output-dir <data dir>

Writes <output-dir>/ocr_det.onnx and <output-dir>/ocr_rec.onnx, and
copies this repo's own assets/en_dict.txt to <output-dir>/ocr_dict.txt
(cardnet's OcrPipeline needs all three — see native/cardnet/README.md).
"""
import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

THIS_DIR = Path(__file__).resolve().parent


def convert(model_dir: Path, output_file: Path):
    model_filename = "inference.pdmodel" if (model_dir / "inference.pdmodel").exists() else "inference.json"
    params_filename = "inference.pdiparams"
    if not (model_dir / model_filename).exists() or not (model_dir / params_filename).exists():
        raise SystemExit(
            f"{model_dir} doesn't look like a PaddleOCR/PaddleX inference model dir "
            f"(expected {model_filename} + {params_filename} in it)"
        )
    output_file.parent.mkdir(parents=True, exist_ok=True)
    # paddle2onnx 2.x is only runnable through its console script; 1.x also works as `python -m paddle2onnx`
    script = shutil.which("paddle2onnx", path=str(Path(sys.executable).parent) + os.pathsep + os.environ.get("PATH", ""))
    cmd = [script] if script else [sys.executable, "-m", "paddle2onnx"]
    cmd += [
        "--model_dir", str(model_dir),
        "--model_filename", model_filename,
        "--params_filename", params_filename,
        "--save_file", str(output_file),
        "--opset_version", "17",
    ]
    print("Running:", " ".join(cmd))
    subprocess.run(cmd, check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--det-model-dir", type=Path, required=True)
    parser.add_argument("--rec-model-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()

    convert(args.det_model_dir, args.output_dir / "ocr_det.onnx")
    convert(args.rec_model_dir, args.output_dir / "ocr_rec.onnx")

    dict_src = THIS_DIR.parent / "assets" / "en_dict.txt"
    dict_dst = args.output_dir / "ocr_dict.txt"
    shutil.copyfile(dict_src, dict_dst)

    # The recognizer's outputs are [CTC blank] + dictionary lines (+ a space, for PP-OCR models trained with
    # use_space_char, which the dictionary file doesn't list). Make the dictionary match the model.
    import onnx

    rec = onnx.load(str(args.output_dir / "ocr_rec.onnx"))
    classes = rec.graph.output[0].type.tensor_type.shape.dim[-1].dim_value
    entries = len(dict_dst.read_text(encoding="utf-8").splitlines())
    if classes == entries + 2:
        with open(dict_dst, "a", encoding="utf-8", newline="\n") as f:
            f.write(" \n")  # cardnet::load_dictionary keeps a literal space line
        print("ocr_rec predicts a space character: appended it to ocr_dict.txt")
    elif classes != entries + 1:
        raise SystemExit(f"ocr_rec has {classes} classes but the dictionary has {entries} entries (+1 for the CTC blank)")

    print(f"Wrote {args.output_dir / 'ocr_det.onnx'}, {args.output_dir / 'ocr_rec.onnx'}, and {dict_dst}")
    print(
        "ocr_dict.txt has been made to match the recognizer's class count; cardnet's "
        "ctc_greedy_decode raises a clear error if they ever disagree, rather than silently misreading characters."
    )


if __name__ == "__main__":
    main()
