"""
export_yolo.py
-----------------------------------------------------------------
One-time dev step: exports the trained YOLOv8 card detector
(backend/data/yolo_card_detector.pt) to ONNX for native/cardnet's
YoloDetector, and writes its class-id -> game-name mapping to a sidecar
JSON file. cardnet::YoloDetector only knows about integer class ids —
scanner.py maps those back to "mtg"/"pokemon"/"yugioh" using this file,
same information ultralytics' `model.names` carried before.

    pip install ultralytics
    python export_yolo.py --weights ../../app/backend/data/yolo_card_detector.pt \\
        --output ../../app/backend/data/yolo_card_detector.onnx
"""
import argparse
import json
from pathlib import Path

from ultralytics import YOLO


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--weights", type=Path, required=True, help="trained yolo_card_detector.pt")
    parser.add_argument("--output", type=Path, default=None, help="defaults to <weights>.onnx")
    parser.add_argument("--imgsz", type=int, default=640,
                        help="must match cardnet.YoloDetector's input_size (default 640) on the Python side")
    args = parser.parse_args()
    output = args.output or args.weights.with_suffix(".onnx")

    model = YOLO(str(args.weights))
    names = model.names  # {class_id: name}, from the training dataset YAML
    print(f"Classes (in trained order): {names}")

    # NMS deliberately left OUT of the graph (ultralytics' export default,
    # dynamic=False for a fixed input_size x input_size shape) — cardnet's
    # YoloDetector applies its own NMS after reading the raw
    # (1, 4+num_classes, num_anchors) head output. See src/yolo_detector.cpp.
    exported_path = Path(model.export(format="onnx", imgsz=args.imgsz, dynamic=False, simplify=True, opset=17))
    output.parent.mkdir(parents=True, exist_ok=True)
    if exported_path.resolve() != output.resolve():
        exported_path.replace(output)

    names_path = output.with_suffix(".names.json")
    names_path.write_text(json.dumps({str(k): v for k, v in names.items()}, indent=2))
    print(f"Wrote {output} and {names_path}")


if __name__ == "__main__":
    main()
