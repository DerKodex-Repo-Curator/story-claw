"""Lightweight progress and memory snapshot for the GPU experiment."""
import json
from pathlib import Path
import subprocess
import urllib.request

result = {}
for name, command in {'gpu':['nvidia-smi','--query-gpu=name,memory.used,utilization.gpu','--format=csv'], 'memory':['free','-m']}.items():
    result[name] = subprocess.run(command,capture_output=True,text=True,timeout=10).stdout
with urllib.request.urlopen('http://127.0.0.1:8188/queue', timeout=10) as response:
    queue = json.load(response)
result['queue'] = {k:[{'number':v[0],'prompt_id':v[1]} for v in values] for k,values in queue.items() if isinstance(values,list)}
logs = []
for p in Path('/proc').iterdir():
    if p.name.isdigit():
        try:
            cmd = (p / 'cmdline').read_bytes()
            if b'main.py' in cmd and b'python' in cmd:
                target = (p / 'fd' / '1').resolve()
                result['stdout_path'] = str(target)
                if target.is_file():
                    logs.append(target)
        except OSError:
            pass
result['logs'] = []
for log in set(logs):
    if log.exists():
        with log.open('rb') as file:
            file.seek(max(0,log.stat().st_size-5000))
            result['logs'].append({'path':str(log),'tail':file.read().decode(errors='replace')})
print(json.dumps(result,ensure_ascii=False,indent=2))
