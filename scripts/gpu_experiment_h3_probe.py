"""Inspect MiniMax H3 assets and the local ComfyUI API without submitting jobs."""
import json
import os
from pathlib import Path
import urllib.request

root = Path("/root/ComfyUI")
info = {"blueprints": [p.name for p in (root / "blueprints").glob("*.json")]}
info["h3_models"] = [{"path": str(p), "bytes": p.stat().st_size, "target": str(p.resolve())}
                     for p in (root / "models").rglob("*")
                     if p.is_file() and any(s in p.name.lower() for s in ("minimax", "h3"))]
info["source_files"] = []
for folder in (root / "comfy_extras", root / "comfy", root / "custom_nodes"):
    for current, dirs, files in os.walk(folder):
        dirs[:] = [d for d in dirs if d not in {".git", "__pycache__", "node_modules"}]
        for name in files:
            path = Path(current) / name
            if path.suffix == ".py" and any(s in str(path).lower() for s in ("minimax", "h3")):
                info["source_files"].append(str(path))
for port in (8188, 8189, 6006, 8000, 8191, 7860):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/system_stats", timeout=3) as response:
            stats = json.load(response)
        info["comfy_port"] = port
        info["system_stats"] = {"system": {k: v for k, v in stats.get("system", {}).items() if k != "argv"}, "devices": stats.get("devices")}
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/queue", timeout=3) as response:
            queue = json.load(response)
        info["queue_counts"] = {k: len(v) for k, v in queue.items() if isinstance(v, list)}
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/object_info", timeout=20) as response:
            nodes = json.load(response)
        info["h3_nodes"] = {k: v for k, v in nodes.items() if any(s in k.lower() for s in ("minimax", "h3"))}
        break
    except Exception as error:
        info.setdefault("port_errors", {})[str(port)] = str(error)
workflow_path = root / "blueprints" / "Image to Video (MiniMax H3).json"
workflow = json.loads(workflow_path.read_text())
info["workflow_keys"] = list(workflow)
info["workflow_nodes"] = [{k: n[k] for k in ("id", "type", "title", "widgets_values", "inputs", "outputs") if k in n}
                           for n in workflow.get("nodes", [])]
info["workflow_subgraphs"] = workflow.get("definitions", {})
print(json.dumps(info, ensure_ascii=False, indent=2))
