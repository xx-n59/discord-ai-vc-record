"""Local-only speech recognition; input is a JSON job on stdin, outputs are cache files."""
import argparse
import json
import os
from pathlib import Path
import sys


def atomic_json(file, value):
    temp = file.with_suffix('.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False), encoding='utf-8')
    os.chmod(temp, 0o600)
    temp.replace(file)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--download-model')
    parser.add_argument('--cache-dir', default='./data/models')
    args = parser.parse_args()
    from faster_whisper import WhisperModel

    if args.download_model:
        WhisperModel(args.download_model, device='cpu', compute_type='int8', download_root=args.cache_dir)
        print('Model ready:', args.download_model)
        return
    job = json.load(sys.stdin)
    pending = []
    for item in job['segments']:
        cache_file = Path(item['cacheFile'])
        try:
            cached = json.loads(cache_file.read_text(encoding='utf-8'))
            if (cached['model'] == job['model'] and cached['language'] == job['language']
                    and isinstance(cached['text'], str)):
                continue
        except (OSError, ValueError, KeyError, TypeError):
            pass
        pending.append(item)
    if not pending:
        return
    model = WhisperModel(job['model'], device='cpu', compute_type='int8',
                         download_root=job['modelDir'])
    for item in pending:
        segments, _ = model.transcribe(item['file'], language=job['language'],
                                       vad_filter=True, beam_size=5,
                                       condition_on_previous_text=False)
        text = ''.join(segment.text for segment in segments).strip()
        atomic_json(Path(item['cacheFile']), {'model': job['model'], 'language': job['language'], 'text': text})
        print(json.dumps({'completed': item['id']}), flush=True)


if __name__ == '__main__':
    main()
