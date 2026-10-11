import json
import os
from pathlib import Path
import urllib.request

root = Path('/root/ComfyUI')
with urllib.request.urlopen('http://127.0.0.1:8188/object_info', timeout=20) as r:
    nodes = json.load(r)
names = ['UNETLoader', 'CLIPLoader', 'VAELoader', 'BasicGuider', 'BasicScheduler', 'KSamplerSelect', 'RandomNoise', 'SamplerCustomAdvanced', 'VAEDecode', 'VAEDecodeTiled', 'CreateVideo', 'SaveVideo', 'LoadImage']
result = {'nodes': {n: nodes.get(n) for n in names}, 'processes': []}
for p in Path('/proc').iterdir():
    if not p.name.isdigit():
        continue
    try:
        argv = (p / 'cmdline').read_bytes().decode(errors='replace').split('\0')
        if any('main.py' in a for a in argv) and any('python' in a for a in argv):
            result['processes'].append({'pid':p.name, 'exe':os.readlink(p / 'exe'), 'flags':[a for a in argv if a.startswith('--')], 'cwd':os.readlink(p / 'cwd')})
    except (OSError, PermissionError):
        pass
result['model_readmes'] = []
model = Path('/model/ModelScope/Comfy-Org/MiniMax-H3')
for p in model.glob('*'):
    if p.is_file() and p.suffix.lower() in {'.md','.txt'}:
        result['model_readmes'].append({'path':str(p), 'text':p.read_text(errors='replace')[:20000]})
print(json.dumps(result,ensure_ascii=False,indent=2))
