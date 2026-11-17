#!/usr/bin/env python3
"""Build monochrome legacy symbol stand-ins from pinned OFL Noto sources.

uv run --with fonttools python tools/build-viewer-symbol-fonts.py SOURCE_DIRECTORY
Sources and SHA-256 hashes are in apps/viewer/src/web/fonts/symbol-sources.json.
The fonts reproduce the engine's Unicode stand-ins, not proprietary outlines.
"""
import ast
import hashlib
import json
import re
import sys
from pathlib import Path
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.recordingPen import DecomposingRecordingPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'apps/viewer/src/web/fonts'


def build(name, cmap, sources):
    glyphs, metrics, output = {}, {}, {}
    empty = TTGlyphPen(None)
    glyphs['.notdef'] = empty.glyph()
    metrics['.notdef'] = (600, 0)
    for cp, unicode in sorted(cmap.items()):
        key = 'u' + format(unicode, 'X')
        output[cp] = key
        if key in glyphs:
            continue
        pen = TTGlyphPen(None)
        if unicode == 0x2581:
            # Unicode LOWER ONE EIGHTH BLOCK: the one chart glyph absent from Noto.
            pen.moveTo((0, -125)); pen.lineTo((1000, -125))
            pen.lineTo((1000, 0)); pen.lineTo((0, 0)); pen.closePath()
            metrics[key] = (1000, 0)
        else:
            source = next((f for f in sources if unicode in f.getBestCmap()), None)
            if source is None:
                raise ValueError(f'{name}: no outline for U+{unicode:04X}')
            source_name = source.getBestCmap()[unicode]
            gs = source.getGlyphSet()
            recording = DecomposingRecordingPen(gs)
            gs[source_name].draw(recording)
            scale = 1000 / source['head'].unitsPerEm
            recording.replay(TransformPen(pen, (scale, 0, 0, scale, 0, 0)))
            advance, lsb = source['hmtx'][source_name]
            metrics[key] = (round(advance * scale), round(lsb * scale))
        glyphs[key] = pen.glyph()
    fb = FontBuilder(1000, isTTF=True)
    fb.setupGlyphOrder(list(glyphs))
    fb.setupCharacterMap(output)
    fb.setupGlyf(glyphs)
    fb.setupHorizontalMetrics(metrics)
    fb.setupHorizontalHeader(ascent=1000, descent=-250)
    fb.setupNameTable({
        'familyName': 'GenOffice ' + name, 'styleName': 'Regular',
        'uniqueFontIdentifier': 'GenOffice' + name.replace(' ', '') + '-Regular',
        'fullName': 'GenOffice ' + name + ' Regular',
        'psName': 'GenOffice' + name.replace(' ', '') + '-Regular',
        'copyright': 'Copyright 2013 Google LLC; Copyright 2022 The Noto Project Authors',
        'licenseDescription': 'SIL Open Font License, Version 1.1. See bundled LICENSE-Noto*.txt files.',
        'licenseInfoURL': 'https://openfontlicense.org',
    })
    fb.setupOS2(sTypoAscender=1000, sTypoDescender=-250, usWinAscent=1200, usWinDescent=400)
    fb.setupPost(); fb.setupMaxp()
    fb.font['head'].created = fb.font['head'].modified = 3846182400
    fb.font.recalcTimestamp = False
    path = OUT / ('GenOffice' + name.replace(' ', '') + '-Regular.ttf')
    fb.save(path)
    return {'file': path.name, 'encodedCharacters': len(output), 'glyphs': len(glyphs) - 1}


def main():
    specs = json.loads((OUT / 'symbol-sources.json').read_text())
    sources = []
    for spec in specs:
        path = Path(sys.argv[1]) / spec['file']
        if hashlib.sha256(path.read_bytes()).hexdigest() != spec['sha256']:
            raise ValueError(f'Unexpected source: {path}')
        font = TTFont(path, recalcTimestamp=False)
        if 'fvar' in font:
            axes = {a.axisTag: a.defaultValue for a in font['fvar'].axes}
            axes.update({'wght': 400})
            font = instantiateVariableFont(font, axes, inplace=True)
        sources.append(font)
    tables = (ROOT / 'packages/docx-engine/src/symbol-fonts.ts').read_text()
    report = {}
    unicode_chars = set(range(0x20, 0x7f))
    for key, name in [('SYMBOL', 'Symbol'), ('WINGDINGS', 'Wingdings'),
                      ('WINGDINGS_2', 'Wingdings 2'), ('WINGDINGS_3', 'Wingdings 3'),
                      ('WEBDINGS', 'Webdings')]:
        table = tables.split('const ' + key + ': Record<number, string> = {', 1)[1].split('\n}', 1)[0]
        mapping = {int(code, 16): ord(ast.literal_eval(char)) for code, char in
                   re.findall(r"0x([0-9a-f]+): ('(?:[^'\\]|\\.)*'),", table)}
        unicode_chars.update(mapping.values())
        encoded = {0x20: 0x20, 0xf020: 0x20}
        if key == 'SYMBOL':
            encoded.update({cp: cp for cp in set(mapping.values()) | set(range(0x20, 0x7f))})
        else:
            encoded.update(mapping)
        encoded.update({0xf000 + code: cp for code, cp in mapping.items()})
        report[name] = build(name, encoded, sources)
        report[name]['mappedCodes'] = len(mapping)
    # Standard Unicode symbols, including mathematical fallback outside legacy charts.
    unicode_chars.update(sources[2].getBestCmap())
    report['Symbols'] = build('Symbols', {cp: cp for cp in unicode_chars}, sources)
    (OUT / 'symbol-coverage.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
