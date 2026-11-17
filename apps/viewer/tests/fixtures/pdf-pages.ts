/** A real three-page PDF; the damaged variant has a counted page-tree branch pointing at a missing object. */
export function pdfPageFixture(damaged = false, label = 'PDF_ISOLATION') {
  const stream = (text: string) => {
    const body = `BT /F1 18 Tf 20 400 Td (${text}) Tj ET`
    return `<< /Length ${body.length} >>\nstream\n${body}\nendstream`
  }
  const resources = '/Resources << /Font << /F1 9 0 R >> >>'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 7 0 R 5 0 R] /Count 3 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 500] ${resources} /Contents 4 0 R >>`,
    stream(label + '_PAGE_ONE'),
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 594] /Rotate 90 ${resources} /Contents 6 0 R >>`,
    stream(label + '_PAGE_THREE'),
    damaged
      ? '<< /Type /Pages /Parent 2 0 R /Kids [99 0 R] /Count 1 >>'
      : `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 500] ${resources} /Contents 8 0 R >>`,
    stream(label + '_PAGE_TWO'),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xref = Buffer.byteLength(pdf)
  pdf +=
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  return Buffer.from(pdf)
}
