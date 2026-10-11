"""Read-only inventory, intended to run on the experimental GPU host."""
import json
import os
from pathlib import Path
import subprocess


def run(command):
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=15)
        return {"exit_code": result.returncode, "stdout": result.stdout[:12000], "stderr": result.stderr[:2000]}
    except Exception as error:
        return {"error": str(error)}


roots = [Path(p) for p in ("/root", "/workspace", "/app", "/data", "/mnt", "/opt", "/home") if Path(p).exists()]
result = {
    "gpu": run(["nvidia-smi", "--query-gpu=name,memory.total,memory.used,utilization.gpu", "--format=csv"]),
    "disk": run(["df", "-h"]),
    "listeners": run(["ss", "-ltnp"]),
    "root_entries": {str(p): [i.name for i in p.iterdir()][:80] for p in roots},
}
models = []
workflows = []
comfy_dirs = []
excluded = {".git", "node_modules", "site-packages", "__pycache__", ".cache", ".ssh", ".config"}
model_extensions = {".safetensors", ".ckpt", ".gguf", ".pth", ".pt", ".bin"}
for root in roots:
    for current, dirs, files in os.walk(root, followlinks=False):
        depth = len(Path(current).relative_to(root).parts)
        dirs[:] = [d for d in dirs if d not in excluded and depth < 7]
        path = Path(current)
        if path.name.lower() == "comfyui":
            comfy_dirs.append(str(path))
        for name in files:
            full = path / name
            if full.suffix.lower() in model_extensions and any(s in str(full).lower() for s in ("model", "minimax", "hunyuan", "h3", "wan", "ltx")):
                try:
                    models.append({"path": str(full), "bytes": full.stat().st_size})
                except FileNotFoundError:
                    models.append({"path": str(full), "broken_symlink": True})
            if full.suffix.lower() == ".json" and any(s in str(full).lower() for s in ("workflow", "minimax", "hunyuan", "h3", "ltx", "wan", "video")):
                try:
                    workflows.append({"path": str(full), "bytes": full.stat().st_size})
                except FileNotFoundError:
                    workflows.append({"path": str(full), "broken_symlink": True})
result.update(models=models[:350], workflows=workflows[:250], comfy_dirs=comfy_dirs)
print(json.dumps(result, ensure_ascii=False, indent=2))
