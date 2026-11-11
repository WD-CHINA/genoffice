#!/usr/bin/env python3
"""Read-only PPTX corpus / isolated FFmpeg drill. Private media stays in --out."""
import argparse
import hashlib
import json
import pathlib
import posixpath
import subprocess
import time
import zipfile
from defusedxml import minidom


def digest(path):
    h = hashlib.sha256()
    with open(path, 'rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', required=True)
    parser.add_argument('--out', required=True)
    parser.add_argument('--container')
    parser.add_argument('--report', default='transcode.json')
    parser.add_argument('--phase', choices=['scan', 'convert', 'variants'], default='scan')
    args = parser.parse_args()
    out = pathlib.Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    report_path = out / args.report

    def save(report):
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')

    def run(binary, options, timeout=1800):
        command = [binary, *map(str, options)]
        if args.container:
            # Bound the process inside the container too: killing only the
            # Docker client would leave an orphan encoder running there.
            command = ['docker', 'exec', args.container, 'timeout', '--kill-after=5s', str(timeout) + 's', *command]
        return subprocess.run(command, capture_output=True, text=True, timeout=timeout + 10)

    def runtime_path(relative):
        return str(pathlib.Path('/evidence') / relative) if args.container else str(out / relative)

    def probe(relative):
        result = run('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', runtime_path(relative)], 60)
        if result.returncode:
            raise RuntimeError(result.stderr[-2000:])
        data = json.loads(result.stdout)
        return {'format': {k: v for k, v in data.get('format', {}).items() if k in ['format_name', 'duration', 'size', 'start_time']},
                'streams': [{k: v for k, v in s.items() if k in ['index', 'codec_type', 'codec_name', 'profile', 'level', 'pix_fmt', 'width', 'height', 'sample_rate', 'channels', 'duration', 'start_time', 'avg_frame_rate', 'disposition']} for s in data.get('streams', [])]}

    if args.phase == 'scan':
        report = {'scope': 'Read-only media inventory; optional standalone conversions are distinct from production preparation', 'documents': [], 'assets': [], 'external': [], 'synthetic': []}
        unique = {}
        for source in sorted(pathlib.Path(args.input).resolve().rglob('*.pptx')):
            if source.name.startswith(('.', '~')):
                continue
            document = {'source': str(source), 'name': source.name, 'sha256': digest(source), 'media': []}
            with zipfile.ZipFile(source) as archive:
                content = minidom.parseString(archive.read('[Content_Types].xml'))
                defaults = {e.getAttribute('Extension').lower(): e.getAttribute('ContentType') for e in content.getElementsByTagName('Default')}
                overrides = {e.getAttribute('PartName').lstrip('/'): e.getAttribute('ContentType') for e in content.getElementsByTagName('Override')}
                relations = {}
                for info in archive.infolist():
                    if not info.filename.endswith('.rels'):
                        continue
                    for node in minidom.parseString(archive.read(info.filename)).getElementsByTagName('Relationship'):
                        kind = node.getAttribute('Type').rsplit('/', 1)[-1]
                        if kind not in ['media', 'video', 'audio']:
                            continue
                        target = node.getAttribute('Target')
                        if node.getAttribute('TargetMode') == 'External':
                            report['external'].append({'document': source.name, 'rels': info.filename, 'target': target})
                        else:
                            owner_dir = posixpath.dirname(posixpath.dirname(info.filename))
                            part = posixpath.normpath(posixpath.join(owner_dir, target)).lstrip('/')
                            relations.setdefault(part, []).append({'rels': info.filename, 'id': node.getAttribute('Id'), 'kind': kind})
                for info in archive.infolist():
                    mime = overrides.get(info.filename, defaults.get(info.filename.rsplit('.', 1)[-1].lower(), ''))
                    if not mime.startswith(('video/', 'audio/')):
                        continue
                    if info.file_size > 2 * 1024**3:
                        raise RuntimeError('media exceeds drill 2 GiB limit')
                    temporary = out / 'extract.tmp'
                    with archive.open(info) as src, temporary.open('wb') as dest:
                        import shutil
                        shutil.copyfileobj(src, dest, 1024 * 1024)
                    sha = digest(temporary)
                    relative = 'inputs/' + sha + pathlib.Path(info.filename).suffix.lower()
                    (out / relative).parent.mkdir(exist_ok=True)
                    if sha not in unique:
                        temporary.replace(out / relative)
                        asset = {'sha256': sha, 'input': relative, 'bytes': info.file_size, 'declaredMime': mime}
                        try:
                            asset['probe'] = probe(relative)
                        except Exception as error:
                            asset['probeError'] = str(error)
                        unique[sha] = asset
                        report['assets'].append(asset)
                    else:
                        temporary.unlink()
                    document['media'].append({'part': info.filename, 'sha256': sha, 'references': relations.get(info.filename, [])})
            report['documents'].append(document)
        save(report)
        print(json.dumps({'documents': len(report['documents']), 'embedded': sum(len(d['media']) for d in report['documents']), 'unique': len(report['assets']), 'codecs': [a.get('probe', {}).get('streams') for a in report['assets']]}, ensure_ascii=False), flush=True)
        return

    report = json.loads(report_path.read_text())
    if args.phase == 'convert':
        report['runtime'] = {'container': args.container, 'ffmpeg': run('ffmpeg', ['-version']).stdout.splitlines()[0], 'ffprobe': run('ffprobe', ['-version']).stdout.splitlines()[0]}
        (out / 'outputs').mkdir(exist_ok=True)
        for index, asset in enumerate(report['assets']):
            started = time.monotonic()
            record = {'status': 'running'}
            asset['conversion'] = record
            save(report)
            try:
                metadata = probe(asset['input'])
                asset['linuxProbe'] = metadata
                videos = [s for s in metadata['streams'] if s['codec_type'] == 'video' and not s.get('disposition', {}).get('attached_pic')]
                audios = [s for s in metadata['streams'] if s['codec_type'] == 'audio']
                if not videos and not audios:
                    raise RuntimeError('no usable video or audio stream')
                # OOXML audio objects remain audio even if their misnamed source
                # contains a video track. Do not turn a background sound into video.
                video = bool(videos) and not asset['declaredMime'].startswith('audio/')
                relative = 'outputs/' + asset['sha256'] + ('.mp4' if video else '.mp3')
                temporary = relative.replace('.mp4', '.tmp.mp4').replace('.mp3', '.tmp.mp3')
                options = ['-nostdin', '-v', 'error', '-y', '-filter_threads', '1', '-i', runtime_path(asset['input'])]
                record['kind'] = 'video' if video else 'audio'
                if video:
                    options += ['-map', '0:' + str(videos[0]['index'])]
                    if audios:
                        options += ['-map', '0:' + str(audios[0]['index'])]
                    options += ['-sn', '-dn', '-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-threads', '2', '-pix_fmt', 'yuv420p', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-movflags', '+faststart']
                else:
                    options += ['-map', '0:' + str(audios[0]['index']), '-vn', '-c:a', 'libmp3lame', '-b:a', '192k', '-ar', '44100', '-ac', '2']
                result = run('ffmpeg', [*options, runtime_path(temporary)])
                if result.returncode:
                    raise RuntimeError(result.stderr[-3000:])
                output_probe = probe(temporary)
                if video:
                    stream = next(s for s in output_probe['streams'] if s['codec_type'] == 'video')
                    assert stream['codec_name'] == 'h264' and stream['pix_fmt'] == 'yuv420p'
                    assert stream['width'] % 2 == 0 and stream['height'] % 2 == 0
                target_audio = [s for s in output_probe['streams'] if s['codec_type'] == 'audio']
                assert len(target_audio) == (1 if audios else 0), 'audio stream lost or unexpectedly created'
                if target_audio:
                    assert target_audio[0]['codec_name'] == ('aac' if video else 'mp3')
                duration_in = float(metadata['format'].get('duration', 0))
                duration_out = float(output_probe['format'].get('duration', 0))
                assert duration_out > 0 and abs(duration_in - duration_out) <= max(.15, duration_in * .01), 'duration mismatch'
                decoded = run('ffmpeg', ['-nostdin', '-v', 'error', '-xerror', '-threads', '2', '-i', runtime_path(temporary), '-f', 'null', '-'])
                if decoded.returncode:
                    raise RuntimeError('full output decode failed: ' + decoded.stderr[-2000:])
                if video:
                    # Only parse top-level atoms; searching arbitrary mdat bytes is unreliable.
                    atoms = []
                    with (out / temporary).open('rb') as stream:
                        offset = 0
                        size = (out / temporary).stat().st_size
                        while offset + 8 <= size:
                            stream.seek(offset)
                            header = stream.read(8)
                            length = int.from_bytes(header[:4], 'big')
                            if length == 1:
                                length = int.from_bytes(stream.read(8), 'big')
                            if length == 0:
                                length = size - offset
                            assert length >= 8
                            atoms.append(header[4:8].decode('ascii', errors='replace'))
                            offset += length
                    assert atoms.index('moov') < atoms.index('mdat'), 'faststart missing'
                    record['atoms'] = atoms
                (out / temporary).replace(out / relative)
                record.update({'status': 'passed', 'output': relative, 'bytes': (out / relative).stat().st_size, 'sha256': digest(out / relative), 'probe': output_probe, 'fullDecode': True})
            except Exception as error:
                record.update({'status': 'failed', 'error': str(error)})
            record['elapsedSeconds'] = round(time.monotonic() - started, 3)
            save(report)
            print(json.dumps({'asset': index + 1, 'total': len(report['assets']), **record}, ensure_ascii=False), flush=True)
        return

    assets = {a['sha256']: a for a in report['assets']}
    (out / 'pptx-converted').mkdir(exist_ok=True)
    for document in report['documents']:
        if not document['media']:
            continue
        changes = {}
        for media in document['media']:
            conversion = assets[media['sha256']].get('conversion', {})
            if conversion.get('status') != 'passed':
                continue
            extension = pathlib.Path(conversion['output']).suffix
            changes[media['part']] = ('ppt/media/compatible-' + media['sha256'] + extension, out / conversion['output'])
        target = out / 'pptx-converted' / document['name']
        with zipfile.ZipFile(document['source']) as source, zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as dest:
            for info in source.infolist():
                if info.filename in changes:
                    name, path = changes[info.filename]
                    # Derived media must be directly seekable, unlike deflated
                    # source package entries on the legacy part route.
                    dest.write(path, name, compress_type=zipfile.ZIP_STORED)
                    continue
                data = source.read(info)
                if info.filename.endswith('.rels'):
                    tree = minidom.parseString(data)
                    modified = False
                    owner_dir = posixpath.dirname(posixpath.dirname(info.filename))
                    for node in tree.getElementsByTagName('Relationship'):
                        if node.getAttribute('TargetMode') == 'External':
                            continue
                        old = posixpath.normpath(posixpath.join(owner_dir, node.getAttribute('Target'))).lstrip('/')
                        if old in changes:
                            node.setAttribute('Target', posixpath.relpath(changes[old][0], owner_dir or '.'))
                            modified = True
                    if modified:
                        data = tree.toxml(encoding='UTF-8')
                elif info.filename == '[Content_Types].xml':
                    tree = minidom.parseString(data)
                    for node in list(tree.getElementsByTagName('Override')):
                        if node.getAttribute('PartName').lstrip('/') in changes:
                            node.parentNode.removeChild(node)
                    for name, _ in changes.values():
                        node = tree.createElementNS(tree.documentElement.namespaceURI, 'Override')
                        node.setAttribute('PartName', '/' + name)
                        node.setAttribute('ContentType', 'video/mp4' if name.endswith('.mp4') else 'audio/mpeg')
                        tree.documentElement.appendChild(node)
                    data = tree.toxml(encoding='UTF-8')
                dest.writestr(info, data)
        assert digest(pathlib.Path(document['source'])) == document['sha256'], 'source document changed'
        document['converted'] = str(target)
        document['convertedMedia'] = len(changes)
        save(report)
    print(json.dumps({'variants': sum('converted' in d for d in report['documents']), 'originalsUnchanged': True}), flush=True)


if __name__ == '__main__':
    main()
