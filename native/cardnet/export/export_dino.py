"""
export_dino.py
-----------------------------------------------------------------
One-time dev step: exports DINOv2 (dinov2_vits14, the same torch.hub
model scanner.py used before switching to cardnet) to ONNX, for
native/cardnet's DinoEmbedder. Not part of the app's runtime and not
bundled into a packaged build — same role as build_scanner_models.py.

    pip install torch
    python export_dino.py --output ../../app/backend/data/dinov2_vits14.onnx

Known gotcha: torch.hub's DINOv2 implementation uses xFormers' fused
attention kernels when xFormers is importable, and those don't always
trace/export cleanly through torch.onnx.export. If export fails with an
opaque error inside an attention block, `pip uninstall xformers` first —
DINOv2 falls back to a plain-PyTorch attention implementation that
exports reliably, and produces numerically identical output (xFormers is
a fused-kernel *speed* optimization, not a different computation).
"""
import argparse
from pathlib import Path

import torch


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path("dinov2_vits14.onnx"))
    parser.add_argument("--opset", type=int, default=17)
    args = parser.parse_args()

    print("Loading dinov2_vits14 via torch.hub (same model scanner.py used before)...")
    model = torch.hub.load("facebookresearch/dinov2", "dinov2_vits14")
    model.eval()

    # cardnet::DinoEmbedder always feeds exactly one 224x224 crop — fixed
    # shapes throughout, no dynamic axes needed.
    dummy = torch.zeros(1, 3, 224, 224, dtype=torch.float32)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    print(f"Exporting to {args.output} (opset {args.opset})...")
    torch.onnx.export(
        model,
        dummy,
        str(args.output),
        input_names=["input"],
        output_names=["embedding"],
        opset_version=args.opset,
        dynamo=False,  # the legacy TorchScript-based exporter traces DINOv2's blocks more reliably
    )

    import onnx

    onnx.checker.check_model(onnx.load(str(args.output)))
    print(f"OK: {args.output} is a valid ONNX model.")


if __name__ == "__main__":
    main()
