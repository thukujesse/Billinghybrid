/**
 * Tiny dependency-free PDF writer (PDF 1.4, single page, Helvetica).
 * Enough for clean text invoices without pulling in a PDF library. Builds the
 * file as latin1 so byte offsets in the xref table line up exactly.
 */

function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

export class Pdf {
  private ops = '';

  /** Draw text. Origin is bottom-left; y grows upward. A4 is 595 x 842pt. */
  text(x: number, y: number, size: number, str: string, bold = false): this {
    this.ops += `BT /${bold ? 'F2' : 'F1'} ${size} Tf ${x} ${y} Td (${esc(str)}) Tj ET\n`;
    return this;
  }

  /** Horizontal rule across the page at height y. */
  rule(y: number, x1 = 50, x2 = 545): this {
    this.ops += `${x1} ${y} m ${x2} ${y} l 0.6 w S\n`;
    return this;
  }

  build(): Buffer {
    const objs = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ' +
        '/Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>',
      `<< /Length ${Buffer.byteLength(this.ops, 'latin1')} >>\nstream\n${this.ops}\nendstream`,
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
    ];

    let body = '%PDF-1.4\n';
    const offsets: number[] = [];
    objs.forEach((o, i) => {
      offsets[i] = Buffer.byteLength(body, 'latin1');
      body += `${i + 1} 0 obj\n${o}\nendobj\n`;
    });

    const xrefStart = Buffer.byteLength(body, 'latin1');
    let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
    for (const off of offsets) xref += `${String(off).padStart(10, '0')} 00000 n \n`;
    const trailer = `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

    return Buffer.from(body + xref + trailer, 'latin1');
  }
}
