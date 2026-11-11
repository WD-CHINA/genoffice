#!/usr/bin/env python3
"""Generate small, explicitly synthetic PPTX codec cases; never use business content."""
import argparse
import base64
import pathlib
import subprocess
import zipfile
from defusedxml import minidom

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--out', required=True)
parser.add_argument('--template', default='packages/pptx-engine/tests/fixtures/01_standard_business.pptx')
args = parser.parse_args()
out = pathlib.Path(args.out).resolve()
out.mkdir(parents=True, exist_ok=True)
cases = [
    ('wmv-wma', 'wmv', 'video/x-ms-wmv', 'video', ['-c:v', 'wmv2', '-c:a', 'wmav2']),
    ('mpeg4-mp3', 'avi', 'video/x-msvideo', 'video', ['-c:v', 'mpeg4', '-c:a', 'libmp3lame']),
    ('hevc10-aac', 'mp4', 'video/mp4', 'video', ['-c:v', 'libx265', '-pix_fmt', 'yuv420p10le', '-x265-params', 'pools=1:frame-threads=1:log-level=error', '-c:a', 'aac']),
    ('odd-silent', 'mkv', 'video/x-matroska', 'video', ['-an', '-c:v', 'ffv1']),
    ('wma', 'wma', 'audio/x-ms-wma', 'audio', ['-c:a', 'wmav2']),
    ('flac', 'flac', 'audio/flac', 'audio', ['-c:a', 'flac']),
]
poster = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOioAAAAASUVORK5CYII=')
for name, extension, mime, kind, options in cases:
    media = out / (name + '.' + extension)
    command = ['ffmpeg', '-nostdin', '-v', 'error', '-y']
    if kind == 'video':
        source = 'testsrc=size=321x241:rate=12' if name == 'odd-silent' else 'testsrc2=size=320x240:rate=12'
        command += ['-f', 'lavfi', '-i', source]
    if name != 'odd-silent':
        command += ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100']
    command += ['-t', '2', '-threads', '1', *options, str(media)]
    subprocess.run(command, check=True)
    part = 'ppt/media/sample.' + extension
    shape = f'''<p:pic xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:nvPicPr><p:cNvPr id="900" name="Synthetic codec validation"/><p:cNvPicPr/><p:nvPr><a:{kind}File r:link="rIdCodec"/><p:extLst><p:ext uri="{{DAA4B4D4-6D71-4841-9C94-3DE7FCFBEDDE}}"><p14:media xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" r:embed="rIdCodecMedia"/></p:ext></p:extLst></p:nvPr></p:nvPicPr><p:blipFill><a:blip r:embed="rIdCodecPoster"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="914400" y="1828800"/><a:ext cx="3657600" cy="2286000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>'''
    with zipfile.ZipFile(args.template) as source, zipfile.ZipFile(out / (name + '.pptx'), 'w', zipfile.ZIP_DEFLATED) as dest:
        for info in source.infolist():
            data = source.read(info)
            if info.filename == 'ppt/slides/slide1.xml':
                tree = minidom.parseString(data)
                tree.getElementsByTagName('p:spTree')[0].appendChild(tree.importNode(minidom.parseString(shape).documentElement, True))
                data = tree.toxml(encoding='UTF-8')
            elif info.filename == 'ppt/slides/_rels/slide1.xml.rels':
                tree = minidom.parseString(data)
                for ident, type_url, target in [
                    ('rIdCodec', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/' + kind, '../media/sample.' + extension),
                    ('rIdCodecMedia', 'http://schemas.microsoft.com/office/2007/relationships/media', '../media/sample.' + extension),
                    ('rIdCodecPoster', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image', '../media/poster.png'),
                ]:
                    node = tree.createElementNS(tree.documentElement.namespaceURI, 'Relationship')
                    for key, value in [('Id', ident), ('Type', type_url), ('Target', target)]:
                        node.setAttribute(key, value)
                    tree.documentElement.appendChild(node)
                data = tree.toxml(encoding='UTF-8')
            elif info.filename == '[Content_Types].xml':
                tree = minidom.parseString(data)
                for file, content_type in [(part, mime), ('ppt/media/poster.png', 'image/png')]:
                    node = tree.createElementNS(tree.documentElement.namespaceURI, 'Override')
                    node.setAttribute('PartName', '/' + file)
                    node.setAttribute('ContentType', content_type)
                    tree.documentElement.appendChild(node)
                data = tree.toxml(encoding='UTF-8')
            dest.writestr(info, data)
        dest.writestr(part, media.read_bytes(), compress_type=zipfile.ZIP_STORED)
        dest.writestr('ppt/media/poster.png', poster)
    print(name, flush=True)
