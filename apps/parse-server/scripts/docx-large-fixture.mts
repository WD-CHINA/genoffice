import { readFile, writeFile } from 'node:fs/promises'
import JSZip from 'jszip'

const args = process.argv.slice(2)
const value = (name: string, fallback: string) => {
  const index = args.indexOf(name)
  return index >= 0 ? (args[index + 1] ?? fallback) : fallback
}
const targetMb = Number(value('--mb', '100'))
const output = value('--out', '/tmp/docx-large-real.docx')

const tableZip = await JSZip.loadAsync(
  await readFile('apps/viewer/src/web/public/docx-spike-table.docx'),
)
const imageZip = await JSZip.loadAsync(
  await readFile('apps/viewer/src/web/public/docx-spike-image.docx'),
)
const documentXml = await tableZip.file('word/document.xml')!.async('string')
const bodyStart = documentXml.indexOf('<w:body>') + '<w:body>'.length
const bodyEnd = documentXml.lastIndexOf('</w:body>')
const body = documentXml.slice(bodyStart, bodyEnd)
const sect = /<w:sectPr[\s\S]*?<\/w:sectPr>/.exec(body)?.[0] ?? ''
const bodyWithoutSect = body.replace(/<w:sectPr[\s\S]*?<\/w:sectPr>/, '')
const imageParagraph =
  '<w:p><w:r><w:drawing><wp:inline distB="114300" distT="114300" distL="114300" distR="114300"><wp:extent cx="2476500" cy="638175"/><wp:effectExtent b="0" l="0" r="0" t="0"/><wp:docPr id="1" name="image1.png"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="image1.png"/><pic:cNvPicPr preferRelativeResize="0"/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdImg"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="2476500" cy="638175"/></a:xfrm><a:prstGeom prst="rect"/></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>'
const one = imageParagraph + bodyWithoutSect
const repetitions = Math.max(1, Math.ceil((targetMb * 1024 * 1024) / one.length))
let next =
  documentXml.slice(0, bodyStart) + one.repeat(repetitions) + sect + documentXml.slice(bodyEnd)
next = next.replace(
  '<w:document ',
  '<w:document xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" ',
)
tableZip.file('word/document.xml', next)
tableZip.file(
  'word/media/image1.png',
  await imageZip.file('word/media/image1.png')!.async('uint8array'),
)
const rels = await tableZip.file('word/_rels/document.xml.rels')!.async('string')
if (!rels.includes('rIdImg')) {
  tableZip.file(
    'word/_rels/document.xml.rels',
    rels.replace(
      '</Relationships>',
      '<Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/></Relationships>',
    ),
  )
}
const types = await tableZip.file('[Content_Types].xml')!.async('string')
if (!types.includes('Extension="png"')) {
  tableZip.file(
    '[Content_Types].xml',
    types.replace('</Types>', '<Default Extension="png" ContentType="image/png"/></Types>'),
  )
}
await writeFile(
  output,
  await tableZip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }),
)
console.log('[docx-large] wrote', {
  output,
  mb: targetMb,
  repetitions,
  xmlMiB: +(next.length / 1024 ** 2).toFixed(1),
})
