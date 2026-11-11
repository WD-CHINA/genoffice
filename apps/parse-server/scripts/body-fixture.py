"""Generate actual large DOCX body XML using bounded memory (Python standard library)."""
import argparse
import json
import zipfile
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--out', default='/tmp/docx-1g-body.docx')
parser.add_argument('--paragraphs', type=int, default=65536)
parser.add_argument('--repetitions', type=int, default=460)
args = parser.parse_args()
if args.paragraphs < 1 or args.repetitions < 1:
    parser.error('paragraphs and repetitions must be positive')
template_path = Path(__file__).resolve().parent.parent / 'tests/fixtures/docx/behavior.docx'
output = Path(args.out)
text = b'Physical education lesson paragraph. ' * args.repetitions
with zipfile.ZipFile(template_path) as template, zipfile.ZipFile(
    output, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=1
) as dest:
    for name in template.namelist():
        if name == 'word/document.xml' or name.endswith('/'):
            continue
        dest.writestr(name, template.read(name))
    with dest.open('word/document.xml', 'w', force_zip64=True) as body:
        body.write(b'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>')
        for index in range(args.paragraphs):
            body.write(b'<w:p><w:r><w:t xml:space="preserve">BODY-' + str(index).encode() + b' ' + text + b'</w:t></w:r></w:p>')
        body.write(b'<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>')
with zipfile.ZipFile(output) as archive:
    print(json.dumps({'paragraphs': args.paragraphs, 'documentXmlBytes': archive.getinfo('word/document.xml').file_size,
                      'compressedBytes': output.stat().st_size, 'lastIndex': args.paragraphs - 1}))
