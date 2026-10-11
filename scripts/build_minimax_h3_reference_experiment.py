"""Build native ComfyUI API workflows for H3 reference-to-video (no image generation)."""
import argparse
import json
from pathlib import Path


def build_workflow(prompt, reference_names, width=768, height=448, length=124, steps=20, seed=20261011, guide_image=None):
    graph = {
        '1': {'class_type':'UNETLoader', 'inputs':{'unet_name':'minimax_h3_ref2va_pruned_int8_convrot.safetensors','weight_dtype':'default'}},
        '2': {'class_type':'CLIPLoader', 'inputs':{'clip_name':'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors','type':'minimax','device':'default'}},
        '3': {'class_type':'VAELoader', 'inputs':{'vae_name':'minimax_h3_video_vae_fp16.safetensors'}},
        '4': {'class_type':'MiniMaxH3ReferenceToVideo', 'inputs':{'clip':['2',0],'vae':['3',0], 'prompt':prompt,
             'width':width, 'height':height, 'length':length, 'ref_image_size':'match'}},
        '5': {'class_type':'BasicGuider', 'inputs':{'model':['1',0], 'conditioning':['4',0]}},
        '6': {'class_type':'KSamplerSelect', 'inputs':{'sampler_name':'res_multistep'}},
        '7': {'class_type':'BasicScheduler', 'inputs':{'model':['1',0], 'scheduler':'simple','steps':steps,'denoise':1.0}},
        '8': {'class_type':'RandomNoise', 'inputs':{'noise_seed':seed}},
        '9': {'class_type':'SamplerCustomAdvanced', 'inputs':{'noise':['8',0], 'guider':['5',0], 'sampler':['6',0], 'sigmas':['7',0], 'latent_image':['4',1]}},
        '10': {'class_type':'VAEDecode', 'inputs':{'samples':['9',0], 'vae':['3',0]}},
        '11': {'class_type':'CreateVideo', 'inputs':{'images':['10',0], 'fps':24.0}},
        '12': {'class_type':'SaveVideo', 'inputs':{'video':['11',0], 'filename_prefix':'story_claw_h3_lab/reference_test', 'format':'mp4','format.codec':'h264'}},
    }
    for index, name in enumerate(reference_names):
        node_id = str(20 + index)
        graph[node_id] = {'class_type':'LoadImage', 'inputs':{'image':name}}
        graph['4']['inputs'][f'ref_images.ref_image_{index}'] = [node_id,0]
    if guide_image:
        graph['40'] = {'class_type':'LoadImage', 'inputs':{'image':guide_image}}
        graph['41'] = {'class_type':'MiniMaxH3AddGuide', 'inputs':{
            'positive':['4',0], 'vae':['3',0], 'latent':['4',1],
            'image':['40',0], 'frame_idx':0}}
        graph['5']['inputs']['conditioning'] = ['41',0]
    return graph


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output')
    parser.add_argument('--prompt-file', required=True)
    parser.add_argument('--reference', action='append', required=True, help='ComfyUI input-relative image name, in Picture order')
    parser.add_argument('--width',type=int,default=768)
    parser.add_argument('--height',type=int,default=448)
    parser.add_argument('--length',type=int,default=124)
    parser.add_argument('--steps',type=int,default=20)
    parser.add_argument('--seed',type=int,default=20261011)
    parser.add_argument('--case',default='reference_test')
    parser.add_argument('--guide-image',help='Optional prior video tail frame, anchored at frame 0 without image generation')
    args = parser.parse_args()
    workflow = build_workflow(Path(args.prompt_file).read_text(encoding='utf-8-sig'),args.reference,args.width,args.height,args.length,args.steps,args.seed,args.guide_image)
    workflow['12']['inputs']['filename_prefix'] = 'story_claw_h3_lab/' + args.case
    output = Path(args.output)
    output.parent.mkdir(parents=True,exist_ok=True)
    output.write_text(json.dumps(workflow,ensure_ascii=False,indent=2),encoding='utf-8')
    print(output)
