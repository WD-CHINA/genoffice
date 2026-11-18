#!/usr/bin/env python3
"""Prepare a new read-only audit inventory or verify protected inputs. No rendering/install."""
import argparse
import hashlib
import json
import os
import platform
import subprocess
import sys
import zipfile
from datetime import datetime
from pathlib import Path
from xml.etree import ElementTree as ET

GENERATED = {'.git', 'node_modules', 'dist', 'releases', '.gradle', '.cache', '.vite', 'coverage', '__pycache__'}
MAX_XML_BYTES = 16 * 1024 * 1024
P = '{http://schemas.openxmlformats.org/presentationml/2006/main}'
W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
R = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}'


def now():
    return datetime.now().astimezone().isoformat(timespec='seconds')


def write_json(path, value):
    if path.is_symlink():
        raise ValueError(f'Refusing to overwrite a symlink: {path}')
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def git(root, *args):
    try:
        result = subprocess.run(['git', '-C', str(root), *args], capture_output=True, timeout=15)
        return result.stdout.decode('utf-8', errors='replace').strip() if result.returncode == 0 else None
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None


def entries(root, excluded):
    found = set()
    for current, dirs, files in os.walk(root, followlinks=False):
        for name in list(dirs):
            child = Path(current) / name
            if name in excluded:
                dirs.remove(name)
            elif child.is_symlink():
                found.add(child.relative_to(root).as_posix())
                dirs.remove(name)
        for name in files:
            if name not in {'.DS_Store', '.git'} or not excluded:
                found.add((Path(current) / name).relative_to(root).as_posix())
    # Tracked source/assets inside a directory named dist/coverage etc. remain protected.
    top = git(root, 'rev-parse', '--show-toplevel')
    if excluded and top and Path(top).resolve() == root:
        try:
            result = subprocess.run(['git', '-C', str(root), 'ls-files', '-z'], capture_output=True, check=True, timeout=15)
            found.update(os.fsdecode(part) for part in result.stdout.split(b'\0') if part)
        except (subprocess.SubprocessError, FileNotFoundError):
            raise RuntimeError('Cannot read tracked baseline paths; snapshot is incomplete')
    return sorted(found)


def record(root, relative):
    path = root / relative
    if path.is_symlink():
        return {'path': relative, 'kind': 'symlink', 'target': os.readlink(path)}
    if not path.is_file():
        return {'path': relative, 'kind': 'missing-or-nonfile'}
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return {'path': relative, 'kind': 'file', 'bytes': path.stat().st_size, 'sha256': digest.hexdigest()}


def snapshot(root, excluded):
    return [record(root, name) for name in entries(root, excluded)]


def xml_part(archive, name):
    if archive.getinfo(name).file_size > MAX_XML_BYTES:
        raise ValueError('XML exceeds inventory limit; use the existing document parser')
    with archive.open(name) as stream:
        data = stream.read(MAX_XML_BYTES + 1)
    if len(data) > MAX_XML_BYTES:
        raise ValueError('XML exceeds inventory limit')
    return ET.fromstring(data)


def logical_units(path):
    suffix = path.suffix.lower()
    if suffix not in {'.pptx', '.potx', '.ppsx', '.docx', '.dotx'}:
        return {'status': 'pending', 'reason': 'Requires actual format parser and/or renderer', 'physical_pages': None}
    try:
        with zipfile.ZipFile(path) as archive:
            if suffix in {'.pptx', '.potx', '.ppsx'}:
                listing = xml_part(archive, 'ppt/presentation.xml').find(P + 'sldIdLst')
                if listing is None:
                    raise ValueError('Missing presentation slide order')
                units = [{'number': i, 'slide_id': node.get('id'), 'relationship_id': node.get(R + 'id'),
                          'source': f'ppt/presentation.xml/p:sldIdLst/p:sldId[{i}]'}
                         for i, node in enumerate(listing.findall(P + 'sldId'), 1)]
                return {'status': 'logical-index-only', 'kind': 'slide', 'count': len(units), 'units': units, 'rendered': False}
            body = xml_part(archive, 'word/document.xml').find(W + 'body')
            if body is None:
                raise ValueError('Missing Word body')
            units = [{'number': i, 'kind': child.tag.rsplit('}', 1)[-1], 'source': f'word/document.xml/body/*[{i}]'}
                     for i, child in enumerate(body, 1) if child.tag != W + 'sectPr']
            return {'status': 'logical-index-only', 'kind': 'word-body-child', 'count': len(units),
                    'units': units, 'physical_pages': None, 'rendered': False}
    except (zipfile.BadZipFile, KeyError, ValueError, ET.ParseError, RuntimeError, OSError) as error:
        return {'status': 'pending', 'reason': f'{type(error).__name__}: {error}; encrypted/unsupported containers need actual recognition', 'physical_pages': None}


def init(args):
    project, baseline, corpus, out = [Path(value).expanduser().resolve() for value in (args.project, args.baseline, args.corpus, args.out)]
    for root in (project, baseline, corpus):
        if not root.is_dir():
            raise ValueError(f'Input directory not found: {root}')
    if baseline == project:
        raise ValueError('Baseline must be separate from the target project')
    for protected in (project, baseline, corpus):
        if out.is_relative_to(protected) or protected.is_relative_to(out):
            raise ValueError('Output must be independent from the project, baseline and courseware')
    if out.exists():
        raise ValueError('Run directory already exists; do not overwrite evidence')
    baseline_files = snapshot(baseline, GENERATED)
    corpus_files = snapshot(corpus, set())
    inventory, duplicates = [], {}
    for number, item in enumerate(corpus_files, 1):
        path = corpus / item['path']
        row = {**item, 'id': f'F{number:04d}', 'absolute_path': str(path), 'rules_review': 'pending'}
        if item['kind'] == 'file':
            previous = duplicates.setdefault(item['sha256'], row['id'])
            row['same_content_as'] = previous if previous != row['id'] else None
            row['logical_index'] = logical_units(path)
        else:
            row['logical_index'] = {'status': 'pending', 'reason': 'Symlinks are recorded without reading external targets'}
        inventory.append(row)
    out.mkdir(parents=True, exist_ok=False)
    (out / 'evidence').mkdir()
    write_json(out / 'run.json', {
        'schema_version': 1, 'created_at': now(), 'project': str(project), 'baseline': str(baseline), 'corpus': str(corpus),
        'mode': args.mode, 'install_policy': args.install_policy,
        'authorization_evidence': 'pending: record the current user instruction before dependent actions',
        'requested_version': args.version, 'release_url': args.release_url,
        'version_verification': {'status': 'pending', 'tag_commit': None, 'source_metadata': None, 'runtime_app_version': None, 'evidence': []},
        'project_head': git(project, 'rev-parse', 'HEAD'), 'initial_worktree_status': git(project, 'status', '--short'),
        'host': {'system': platform.system(), 'release': platform.release(), 'machine': platform.machine(), 'python': platform.python_version()},
        'accepted_designs': [{'id': value, 'authorization_evidence': 'pending'} for value in args.accepted],
        'runtime_environments': {port: {'status': 'pending'} for port in ('electron', 'web', 'server', 'android')},
        'display_acceptance': 'not_evaluated',
    })
    write_json(out / 'inventory.json', {'entry_count': len(inventory), 'regular_file_count': sum(x['kind'] == 'file' for x in inventory),
                                      'unique_content_count': len(duplicates), 'files': inventory})
    protection = {'schema_version': 1,
        'baseline': {'root': str(baseline), 'excluded_directory_names': sorted(GENERATED), 'files': baseline_files},
        'corpus': {'root': str(corpus), 'excluded_directory_names': [], 'files': corpus_files},
        'note': 'Excluded untracked generated paths and .git/.DS_Store metadata are not protected. Tracked paths remain included; external symlink targets are not read.'}
    if args.mode != 'repair':
        protection['project'] = {'root': str(project), 'excluded_directory_names': sorted(GENERATED), 'files': snapshot(project, GENERATED)}
    write_json(out / 'protection.json', protection)
    print(json.dumps({'run': str(out), 'entries': len(inventory), 'display_acceptance': 'not_evaluated'}, ensure_ascii=False))


def verify(args):
    run = Path(args.run).expanduser().resolve()
    protection = json.loads((run / 'protection.json').read_text(encoding='utf-8'))
    changes = {}
    for label in ('baseline', 'corpus', 'project'):
        if label not in protection:
            continue
        data = protection[label]
        expected = {item['path']: item for item in data['files']}
        root = Path(data['root'])
        if not root.is_dir():
            changes[label] = [{'path': '.', 'change': 'root-missing'}]
            continue
        current = {item['path']: item for item in snapshot(root, set(data['excluded_directory_names']))}
        changes[label] = [{'path': name, 'change': 'added' if name not in expected else 'removed' if name not in current else 'modified'}
                          for name in sorted(expected.keys() | current.keys()) if expected.get(name) != current.get(name)]
    unchanged = not any(changes.values())
    result = {'checked_at': now(), 'protected_inputs_unchanged': unchanged, 'changes': changes, 'display_acceptance': 'not_evaluated'}
    history = run / 'integrity-history.jsonl'
    if history.is_symlink():
        raise ValueError('Refusing to append to a symlink')
    with history.open('a', encoding='utf-8') as stream:
        stream.write(json.dumps(result, ensure_ascii=False) + '\n')
    write_json(run / 'integrity.json', result)
    print(json.dumps(result, ensure_ascii=False))
    return 0 if unchanged else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    prepare = commands.add_parser('init', help='Create a new inventory, protection snapshot and pending run manifest')
    for name in ('project', 'baseline', 'corpus', 'out', 'version', 'release-url'):
        prepare.add_argument('--' + name, required=True)
    prepare.add_argument('--mode', choices=['audit', 'repair', 'retest'], default='audit')
    prepare.add_argument('--install-policy', choices=['forbid', 'allowed'], default='forbid')
    prepare.add_argument('--accepted', action='append', default=[], help='Previously accepted issue ID; repeat as needed and record evidence in run.json')
    check = commands.add_parser('verify', help='Verify only the protected input set; not visual acceptance')
    check.add_argument('--run', required=True)
    args = parser.parse_args()
    try:
        return (init(args) or 0) if args.command == 'init' else verify(args)
    except (ValueError, OSError, RuntimeError, zipfile.BadZipFile, json.JSONDecodeError) as error:
        print(f'ERROR: {error}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
