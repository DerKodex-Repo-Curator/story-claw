"""Collect local render evidence and make a continuation boundary comparison."""
import hashlib
import json
from pathlib import Path
import re
from PIL import Image, ImageChops, ImageDraw, ImageStat


root = Path(__file__).resolve().parent.parent
base = root / 'out/gpu-reference-video-lab'
cases = ['case01_sheet', 'case02_crop', 'case03_two_people', 'case04_continuation']
records = []
for case in cases:
    folder = base / case
    graph = json.loads((folder / 'workflow-api.json').read_text(encoding='utf-8'))
    history = json.loads((folder / 'history.json').read_text(encoding='utf-8'))
    submission = json.loads((folder / 'submission.json').read_text(encoding='utf-8'))
    probe = json.loads((folder / 'media-probe.json').read_text(encoding='utf-8'))
    stamps = {message[0]: message[1].get('timestamp')
              for message in history['status']['messages'] if isinstance(message[1], dict)}
    video = folder / 'result.mp4'
    load_images = {key: node['inputs']['image'] for key, node in graph.items()
                   if node['class_type'] == 'LoadImage'}
    references = []
    for key, connection in graph['4']['inputs'].items():
        if key.startswith('ref_images.'):
            index = int(key.rsplit('_', 1)[-1])
            references.append({'picture': index + 1, 'server_image': load_images[connection[0]]})
    references.sort(key=lambda reference: reference['picture'])
    record = {'case': case, 'prompt_id': submission['response']['prompt_id'],
              'status': history['status']['status_str'],
              'execution_seconds': (stamps['execution_success'] - stamps['execution_start']) / 1000,
              'duration_seconds': float(probe['format']['duration']),
              'streams': [{key: stream.get(key) for key in
                          ('codec_type', 'codec_name', 'width', 'height', 'r_frame_rate', 'nb_frames')}
                          for stream in probe['streams']],
              'references': references,
              'seed': graph['8']['inputs']['noise_seed'],
              'guide_image': graph.get('40', {}).get('inputs', {}).get('image'),
              'video_sha256': hashlib.sha256(video.read_bytes()).hexdigest(),
              'workflow_sha256': hashlib.sha256((folder / 'workflow-api.json').read_bytes()).hexdigest(),
              'artifact_directory': case}
    records.append(record)

tail = Image.open(base / 'case03_two_people/tail.png').convert('RGB')
first = Image.open(base / 'case04_continuation/first.png').convert('RGB')
if tail.size != first.size:
    raise ValueError('Boundary frames have different sizes')
stat = ImageStat.Stat(ImageChops.difference(tail, first))
boundary = {'mean_absolute_rgb_difference_0_255': sum(stat.mean) / 3,
            'interpretation': 'Pixel difference only; not a face-identity score or continuity pass threshold',
            'previous_last_frame': 123, 'next_first_frame': 0}
sheet = Image.new('RGB', (tail.width * 2, tail.height + 32), '#eeeeee')
draw = ImageDraw.Draw(sheet)
draw.text((10, 8), 'case03 last frame (n=123)', fill='black')
draw.text((tail.width + 10, 8), 'case04 first frame (n=0), AddGuide@0', fill='black')
sheet.paste(tail, (0, 32))
sheet.paste(first, (tail.width, 32))
sheet.save(base / 'continuation-boundary.jpg', quality=95)
(base / 'results.json').write_text(json.dumps({'date': '2026-10-11', 'cases': records,
                                             'continuation_boundary': boundary},
                                            ensure_ascii=False, indent=2), encoding='utf-8')

broken_links = []
for document in [base / '实验流程与工作流调整.md', base / 'story-mode-integration-notes.md']:
    for target in re.findall(r'\]\(([^)]+)\)', document.read_text(encoding='utf-8')):
        if target.startswith(('https://', 'http://')):
            continue
        target_path = re.sub(r':\d+$', '', target).strip('<>')
        resolved = Path(target_path) if Path(target_path).is_absolute() else document.parent / target_path
        if not resolved.exists():
            broken_links.append({'document': document.name, 'target': target})
if broken_links:
    raise ValueError(f'Broken artifact links: {broken_links}')
print(json.dumps({'cases': len(records), 'execution_seconds': [r['execution_seconds'] for r in records],
                  'boundary': boundary, 'broken_links': len(broken_links)}, ensure_ascii=False))
