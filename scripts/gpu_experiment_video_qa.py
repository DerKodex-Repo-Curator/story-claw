"""Probe an experiment video and export timestamped contact-sheet frames."""
import argparse
import json
from pathlib import Path
import subprocess
from PIL import Image, ImageDraw

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('video')
args = parser.parse_args()
video = Path(args.video).resolve()
root = Path(__file__).resolve().parent.parent
ffmpeg = root / 'node_modules/@ffmpeg-installer/win32-x64/ffmpeg.exe'
ffprobe = root / 'node_modules/@ffprobe-installer/win32-x64/ffprobe.exe'
probe = json.loads(subprocess.check_output([str(ffprobe),'-v','error','-show_streams','-show_format','-of','json',str(video)]))
duration = float(probe['format']['duration'])
times = [0.1,1,2,3,4,min(5,duration-0.1)]
frames = video.parent / 'frames'
frames.mkdir(exist_ok=True)
sheet = Image.new('RGB',(768,3*258),'#eeeeee')
draw = ImageDraw.Draw(sheet)
for index, timestamp in enumerate(times):
    output = frames / f'{index:02d}_{timestamp:.2f}s.png'
    subprocess.run([str(ffmpeg),'-hide_banner','-loglevel','error','-y','-ss',str(timestamp),'-i',str(video),'-frames:v','1',str(output)],check=True)
    image = Image.open(output).convert('RGB')
    image.thumbnail((384,224))
    x = (index%2)*384
    y = (index//2)*258
    sheet.paste(image,(x,y+26))
    draw.text((x+8,y+7),f'{timestamp:.2f} seconds',fill='black')
sheet.save(video.parent / 'contact-sheet.jpg',quality=95)
(video.parent / 'media-probe.json').write_text(json.dumps(probe,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'duration':duration,'streams':[{k:s.get(k) for k in ('codec_type','codec_name','width','height','r_frame_rate','nb_frames')} for s in probe['streams']], 'contact_sheet':str(video.parent / 'contact-sheet.jpg')},ensure_ascii=False))
