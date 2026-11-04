/** Builds small but valid PDFs for tests (correct xref offsets). */
export function makePdf(objects: Buffer[]): Buffer {
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n', 'latin1')]
  const offsets: number[] = []
  let pos = parts[0]!.length
  objects.forEach((body, i) => {
    offsets.push(pos)
    const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), body, Buffer.from('\nendobj\n', 'latin1')])
    parts.push(chunk)
    pos += chunk.length
  })
  const xref = [
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`,
    ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`),
  ].join('')
  parts.push(
    Buffer.from(`${xref}trailer<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${pos}\n%%EOF`, 'latin1'),
  )
  return Buffer.concat(parts)
}

function pdfStream(dict: string, data: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`<<${dict}/Length ${data.length}>>stream\n`, 'latin1'),
    data,
    Buffer.from('\nendstream', 'latin1'),
  ])
}

/** One A4 page holding a single 2496×3488 grey image (a 300 dpi scan) and no text. */
export function makeScannedPdf(imageData: Buffer, filter = ''): Buffer {
  return makePdf([
    Buffer.from('<</Type/Catalog/Pages 2 0 R>>', 'latin1'),
    Buffer.from('<</Type/Pages/Kids[3 0 R]/Count 1>>', 'latin1'),
    Buffer.from(
      '<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Resources<</XObject<</Im1 4 0 R>>>>/Contents 5 0 R>>',
      'latin1',
    ),
    pdfStream(
      `/Type/XObject/Subtype/Image/Width 2496/Height 3488/ColorSpace/DeviceGray/BitsPerComponent 8${filter}`,
      imageData,
    ),
    pdfStream('', Buffer.from('q 595 0 0 842 0 0 cm /Im1 Do Q', 'latin1')),
  ])
}

/** One empty A4 page: no text, no image. */
export function makeBlankPdf(): Buffer {
  return makePdf([
    Buffer.from('<</Type/Catalog/Pages 2 0 R>>', 'latin1'),
    Buffer.from('<</Type/Pages/Kids[3 0 R]/Count 1>>', 'latin1'),
    Buffer.from('<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>', 'latin1'),
  ])
}
