import PDFDocument from "pdfkit";

/** Convertit un PDFDocument pdfkit en Buffer, sans passer par le système de fichiers. */
function toBuffer(build: (doc: PDFKit.PDFDocument) => void): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    build(doc);
    doc.end();
  });
}

export function generatePayslipPdfBuffer(payslip: {
  period: string;
  baseSalary: number;
  bonuses: number;
  deductions: number;
  netPay: number;
  staff: { fullName: string; jobTitle: string; organization: { name: string } };
}): Promise<Buffer> {
  return toBuffer((doc) => {
    doc.fontSize(9).fillColor("#7A8399").text(payslip.staff.organization.name);
    doc.fontSize(18).fillColor("#101B33").text("Bulletin de paie");
    doc.fontSize(11).fillColor("#3D4761").text(`Période : ${payslip.period}`);
    doc.text(`Employé : ${payslip.staff.fullName} — ${payslip.staff.jobTitle}`);
    doc.moveDown();
    doc.text(`Salaire de base : ${payslip.baseSalary.toLocaleString("fr-FR")}`);
    doc.text(`Primes : ${payslip.bonuses.toLocaleString("fr-FR")}`);
    doc.text(`Retenues : ${payslip.deductions.toLocaleString("fr-FR")}`);
    doc.moveDown(0.5);
    doc.fontSize(14).fillColor("#101B33").text(`Net à payer : ${payslip.netPay.toLocaleString("fr-FR")}`);
  });
}
