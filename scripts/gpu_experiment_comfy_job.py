"""Submit and inspect isolated MiniMax H3 ComfyUI experiments on the GPU host."""
import argparse
import json
from pathlib import Path
import time
import urllib.error
import urllib.request

BASE = Path('/root/story_claw_h3_lab')
API = 'http://127.0.0.1:8188'


def request(path, value=None):
    data = None if value is None else json.dumps(value).encode()
    req = urllib.request.Request(API + path, data=data, headers={'Content-Type':'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError(f'HTTP {error.code}: {error.read().decode()}') from error


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('action', choices=['submit', 'status'])
parser.add_argument('case')
args = parser.parse_args()
if not args.case.replace('_', '').replace('-', '').isalnum():
    raise ValueError('case must be a simple identifier')
case_dir = BASE / args.case
case_dir.mkdir(parents=True, exist_ok=True)
record_path = case_dir / 'submission.json'
if args.action == 'submit':
    if record_path.exists():
        raise RuntimeError('This case already has a submission; inspect status instead of resubmitting')
    queue = request('/queue')
    if queue.get('queue_running') or queue.get('queue_pending'):
        raise RuntimeError('ComfyUI queue is occupied; no experiment was submitted')
    workflow = json.loads((case_dir / 'workflow-api.json').read_text())
    start = time.time()
    response = request('/prompt', {'prompt': workflow, 'client_id':'story-claw-h3-experiment'})
    record = {'case':args.case, 'submitted_at':start, 'response':response}
    record_path.write_text(json.dumps(record,ensure_ascii=False,indent=2))
    print(json.dumps(record,ensure_ascii=False))
else:
    record = json.loads(record_path.read_text())
    prompt_id = record['response']['prompt_id']
    entry = request('/history/' + prompt_id).get(prompt_id)
    queue = request('/queue')
    result = {'case':args.case, 'prompt_id':prompt_id, 'elapsed_seconds':round(time.time()-record['submitted_at'],1),
              'running':any(q[1] == prompt_id for q in queue.get('queue_running',[])),
              'pending':any(q[1] == prompt_id for q in queue.get('queue_pending',[]))}
    if entry:
        (case_dir / 'history.json').write_text(json.dumps(entry,ensure_ascii=False,indent=2))
        result['status'] = entry.get('status')
        result['outputs'] = entry.get('outputs')
        messages = entry.get('status',{}).get('messages',[])
        stamps = {m[0]:m[1].get('timestamp') for m in messages if isinstance(m[1],dict)}
        if stamps.get('execution_start') and stamps.get('execution_success'):
            result['execution_seconds'] = (stamps['execution_success']-stamps['execution_start'])/1000
    else:
        result['status'] = 'running' if result['running'] else 'pending' if result['pending'] else 'unknown'
    print(json.dumps(result,ensure_ascii=False))
