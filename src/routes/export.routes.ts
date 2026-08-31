import { Router, Request } from "express";
import { z } from "zod";
import PDFDocument from "pdfkit";
import ExcelJS from "exceljs";
import { Document as DocxDocument, Packer, Paragraph, HeadingLevel, TextRun } from "docx";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth";
import { generatePayslipPdfBuffer, generateInvoicePdfBuffer, generatePurchaseOrderPdfBuffer, generatePaymentRequestPdfBuffer, generateLetterPdfBuffer, generateDonorReportPdfBuffer, DonorReportFormat } from "../services/pdf.service";
import { purchaseOrderNumber } from "../services/invoice-numbering.service";

export const exportRouter = Router();
exportRouter.use(requireAuth);

/**
 * Détermine si le PDF doit s'ouvrir dans le navigateur (impression directe,
 * ?print=1) ou se télécharger comme fichier (comportement par défaut).
 * Répond à la demande "pouvoir imprimer tout document produit" : le
 * navigateur ouvre son visualiseur PDF natif, qui propose Ctrl+P directement,
 * sans étape de téléchargement préalable.
 */
function pdfDisposition(req: Request): "inline" | "attachment" {
  return req.query.print === "1" ? "inline" : "attachment";
}

// ---------------------------------------------------------------------------
// Documents (TDR, rapports) — export PDF et Word
// ---------------------------------------------------------------------------

exportRouter.get("/documents/:id/pdf", async (req, res) => {
  const doc = await prisma.document.findFirst({
    where: { id: req.params.id, organizationId: req.auth!.organizationId },
  });
  if (!doc) return res.status(404).json({ error: "Document introuvable" });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `${pdfDisposition(req)}; filename="${slug(doc.title)}.pdf"`);

  const pdf = new PDFDocument({ margin: 50 });
  pdf.pipe(res);
  pdf.fontSize(9).fillColor("#7A8399").text(new Date(doc.createdAt).toLocaleDateString("fr-FR"));
  pdf.moveDown(0.5);
  pdf.fontSize(18).fillColor("#101B33").text(doc.title, { underline: false });
  pdf.moveDown();
  pdf.fontSize(11).fillColor("#3D4761").text(doc.content, { align: "justify" });
  pdf.end();
});

exportRouter.get("/documents/:id/docx", async (req, res) => {
  const doc = await prisma.document.findFirst({
    where: { id: req.params.id, organizationId: req.auth!.organizationId },
  });
  if (!doc) return res.status(404).json({ error: "Document introuvable" });

  const file = new DocxDocument({
    sections: [
      {
        children: [
          new Paragraph({ text: doc.title, heading: HeadingLevel.TITLE }),
          new Paragraph({
            children: [new TextRun({ text: new Date(doc.createdAt).toLocaleDateString("fr-FR"), color: "7A8399", size: 18 })],
          }),
          new Paragraph({ text: "" }),
          ...doc.content.split("\n").map((line) => new Paragraph({ text: line })),
        ],
      },
    ],
  });

  const buffer = await Packer.toBuffer(file);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  res.setHeader("Content-Disposition", `attachment; filename="${slug(doc.title)}.docx"`);
  res.send(buffer);
});

// ---------------------------------------------------------------------------
// Budget — export Excel (une feuille par ligne + une feuille de synthèse)
// ---------------------------------------------------------------------------

exportRouter.get("/projects/:id/budget/xlsx", async (req, res) => {
  const project = await prisma.project.findFirst({
    where: { id: req.params.id, organizationId: req.auth!.organizationId },
    include: { budgetLines: { include: { expenses: true } } },
  });
  if (!project) return res.status(404).json({ error: "Projet introuvable" });

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Plateforme ONG";

  const summary = workbook.addWorksheet("Synthèse budgétaire");
  summary.columns = [
    { header: "Code", key: "code", width: 10 },
    { header: "Ligne budgétaire", key: "label", width: 35 },
    { header: "Alloué", key: "allocated", width: 18 },
    { header: "Dépensé", key: "spent", width: 18 },
    { header: "Disponible", key: "remaining", width: 18 },
  ];
  summary.getRow(1).font = { bold: true };
  project.budgetLines.forEach((l) => {
    summary.addRow({
      code: l.code,
      label: l.label,
      allocated: Number(l.allocated),
      spent: Number(l.spent),
      remaining: Number(l.allocated) - Number(l.spent),
    });
  });
  summary.getColumn("allocated").numFmt = "#,##0";
  summary.getColumn("spent").numFmt = "#,##0";
  summary.getColumn("remaining").numFmt = "#,##0";

  const detail = workbook.addWorksheet("Dépenses détaillées");
  detail.columns = [
    { header: "Ligne", key: "line", width: 30 },
    { header: "Libellé", key: "label", width: 40 },
    { header: "Montant", key: "amount", width: 18 },
    { header: "Date", key: "date", width: 15 },
    { header: "Statut", key: "status", width: 20 },
  ];
  detail.getRow(1).font = { bold: true };
  project.budgetLines.forEach((l) => {
    l.expenses.forEach((e) => {
      detail.addRow({ line: l.label, label: e.label, amount: Number(e.amount), date: e.date.toLocaleDateString("fr-FR"), status: e.status });
    });
  });
  detail.getColumn("amount").numFmt = "#,##0";

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="budget-${project.code}.xlsx"`);
  await workbook.xlsx.write(res);
  res.end();
});

// ---------------------------------------------------------------------------
// Journal comptable — export Excel
// ---------------------------------------------------------------------------

exportRouter.get("/journal/xlsx", async (req, res) => {
  const { projectId } = req.query;
  const entries = await prisma.journalEntry.findMany({
    where: {
      account: { organizationId: req.auth!.organizationId },
      ...(projectId ? { projectId: String(projectId) } : {}),
    },
    include: { account: true },
    orderBy: { date: "asc" },
  });

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Journal comptable");
  sheet.columns = [
    { header: "Date", key: "date", width: 14 },
    { header: "Compte", key: "account", width: 12 },
    { header: "Libellé du compte", key: "accountLabel", width: 30 },
    { header: "Libellé écriture", key: "label", width: 35 },
    { header: "Débit", key: "debit", width: 16 },
    { header: "Crédit", key: "credit", width: 16 },
  ];
  sheet.getRow(1).font = { bold: true };
  entries.forEach((e) => {
    sheet.addRow({
      date: e.date.toLocaleDateString("fr-FR"),
      account: e.account.accountCode,
      accountLabel: e.account.label,
      label: e.label,
      debit: Number(e.debit),
      credit: Number(e.credit),
    });
  });
  sheet.getColumn("debit").numFmt = "#,##0";
  sheet.getColumn("credit").numFmt = "#,##0";

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="journal-comptable.xlsx"`);
  await workbook.xlsx.write(res);
  res.end();
});

// ---------------------------------------------------------------------------
// Facture — export PDF (téléchargement ou impression directe)
// ---------------------------------------------------------------------------

exportRouter.get("/invoices/:id/pdf", async (req, res) => {
  const invoice = await prisma.invoice.findFirst({
    where: { id: req.params.id, organizationId: req.auth!.organizationId },
    include: { lines: true, organization: true },
  });
  if (!invoice) return res.status(404).json({ error: "Facture introuvable" });

  const buffer = await generateInvoicePdfBuffer({
    ...invoice,
    lines: invoice.lines.map((l) => ({ description: l.description, quantity: Number(l.quantity), unitPrice: Number(l.unitPrice) })),
  });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `${pdfDisposition(req)}; filename="${invoice.number}.pdf"`);
  res.send(buffer);
});

// ---------------------------------------------------------------------------
// Bon de commande — export PDF
// ---------------------------------------------------------------------------

exportRouter.get("/purchase-orders/:id/pdf", async (req, res) => {
  const order = await prisma.purchaseOrder.findFirst({
    where: { id: req.params.id, project: { organizationId: req.auth!.organizationId } },
    include: { budgetLine: true, supplier: true, validatedBy: { select: { fullName: true } }, project: { include: { organization: true } } },
  });
  if (!order) return res.status(404).json({ error: "Commande introuvable" });

  const number = await purchaseOrderNumber(req.auth!.organizationId, order.id);
  const buffer = await generatePurchaseOrderPdfBuffer({
    number,
    item: order.item,
    amount: Number(order.amount),
    currency: order.project.currency,
    createdAt: order.createdAt,
    status: order.status,
    validatedAt: order.validatedAt,
    validatedByName: order.validatedBy?.fullName,
    deliveryNoteRef: order.deliveryNoteRef,
    budgetLine: { code: order.budgetLine.code, label: order.budgetLine.label },
    supplier: { name: order.supplier.name, contact: order.supplier.contact },
    organization: order.project.organization,
  });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `${pdfDisposition(req)}; filename="${number}.pdf"`);
  res.send(buffer);
});

// ---------------------------------------------------------------------------
// Demande de paiement — export PDF
// ---------------------------------------------------------------------------

exportRouter.get("/payment-requests/:id/pdf", async (req, res) => {
  const request = await prisma.paymentRequest.findFirst({
    where: { id: req.params.id, project: { organizationId: req.auth!.organizationId } },
    include: { project: { include: { organization: true } }, bankAccount: true },
  });
  if (!request) return res.status(404).json({ error: "Demande de paiement introuvable" });

  // Compte bancaire spécifique à cette demande, sinon compte par défaut de
  // l'organisation — une ONG à plusieurs bailleurs peut avoir un compte
  // dédié par projet/subvention, dans des banques différentes.
  const organizationForPdf = request.bankAccount
    ? {
        ...request.project.organization,
        bankName: request.bankAccount.bankName,
        bankAddress: request.bankAccount.bankAddress,
        bankAccountNumber: request.bankAccount.accountNumber,
      }
    : request.project.organization;

  const buffer = await generatePaymentRequestPdfBuffer({
    repereNumber: request.repereNumber,
    amountRequested: Number(request.amountRequested),
    currency: request.project.currency,
    requestDate: request.requestDate,
    achievements: request.achievements,
    preparedByName: request.preparedByName,
    preparedByTitle: request.preparedByTitle,
    project: { name: request.project.name, grantNumber: request.project.grantNumber },
    organization: organizationForPdf,
  });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `${pdfDisposition(req)}; filename="demande-paiement-repere-${request.repereNumber}.pdf"`);
  res.send(buffer);
});

// ---------------------------------------------------------------------------
// Lettre — export PDF
// ---------------------------------------------------------------------------

exportRouter.get("/letters/:id/pdf", async (req, res) => {
  const letter = await prisma.letter.findFirst({
    where: { id: req.params.id, organizationId: req.auth!.organizationId },
  });
  if (!letter) return res.status(404).json({ error: "Lettre introuvable" });

  const organization = await prisma.organization.findUniqueOrThrow({ where: { id: req.auth!.organizationId } });
  const buffer = await generateLetterPdfBuffer({ ...letter, organization });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `${pdfDisposition(req)}; filename="lettre-${letter.reference || letter.id}.pdf"`);
  res.send(buffer);
});

// ---------------------------------------------------------------------------
// Bulletin de paie — export PDF
// ---------------------------------------------------------------------------

exportRouter.get("/payslips/:id/pdf", async (req, res) => {
  const payslip = await prisma.payslip.findFirst({
    where: { id: req.params.id, staff: { organizationId: req.auth!.organizationId } },
    include: { staff: { include: { organization: true } } },
  });
  if (!payslip) return res.status(404).json({ error: "Bulletin introuvable" });

  const buffer = await generatePayslipPdfBuffer({
    period: payslip.period,
    baseSalary: Number(payslip.baseSalary),
    bonuses: Number(payslip.bonuses),
    deductions: Number(payslip.deductions),
    netPay: Number(payslip.netPay),
    staff: payslip.staff,
  });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `${pdfDisposition(req)}; filename="bulletin-${payslip.staff.fullName.replace(/\s+/g, "-")}-${payslip.period}.pdf"`);
  res.send(buffer);
});

// ---------------------------------------------------------------------------
// Registres logistiques (véhicules, stocks) — export Excel
// ---------------------------------------------------------------------------

exportRouter.get("/vehicles/xlsx", async (req, res) => {
  const vehicles = await prisma.vehicle.findMany({
    where: { organizationId: req.auth!.organizationId },
    include: { fuelLogs: true, maintenances: true },
  });

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Parc véhicules");
  sheet.columns = [
    { header: "Immatriculation", key: "plate", width: 18 },
    { header: "Modèle", key: "model", width: 25 },
    { header: "Statut", key: "status", width: 16 },
    { header: "Kilométrage", key: "mileage", width: 14 },
    { header: "Coût carburant cumulé", key: "fuelCost", width: 20 },
    { header: "Coût maintenance cumulé", key: "maintCost", width: 22 },
  ];
  sheet.getRow(1).font = { bold: true };
  vehicles.forEach((v) => {
    sheet.addRow({
      plate: v.plateNumber,
      model: `${v.brand} ${v.model}`,
      status: v.status,
      mileage: v.currentMileage,
      fuelCost: v.fuelLogs.reduce((s, f) => s + Number(f.cost), 0),
      maintCost: v.maintenances.reduce((s, m) => s + Number(m.cost), 0),
    });
  });

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="parc-vehicules.xlsx"`);
  await workbook.xlsx.write(res);
  res.end();
});

function slug(title: string) {
  return title.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").slice(0, 60);
}

// ---------------------------------------------------------------------------
// Rapport bailleur (UE / ONU / USAID) — export PDF
// ---------------------------------------------------------------------------

const donorReportSchema = z.object({
  format: z.enum(["UE", "ONU", "USAID", "GENERIQUE"]).default("GENERIQUE"),
  periodLabel: z.string().min(2),
  narrative: z.string().min(10),
  challenges: z.string().optional(),
});

exportRouter.post("/projects/:id/donor-report-pdf", async (req, res) => {
  const parsed = donorReportSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const project = await prisma.project.findFirst({
    where: { id: req.params.id, organizationId: req.auth!.organizationId },
    include: { organization: true, logframe: true, budgetLines: true },
  });
  if (!project) return res.status(404).json({ error: "Projet introuvable" });

  const buffer = await generateDonorReportPdfBuffer({
    format: parsed.data.format as DonorReportFormat,
    periodLabel: parsed.data.periodLabel,
    narrative: parsed.data.narrative,
    challenges: parsed.data.challenges,
    project: { name: project.name, code: project.code, donor: project.donor, grantNumber: project.grantNumber, currency: project.currency },
    logframe: project.logframe.map((l) => ({ objective: l.objective, result: l.result, indicator: l.indicator, target: l.target, achieved: l.achieved })),
    budgetLines: project.budgetLines.map((l) => ({ code: l.code, label: l.label, allocated: Number(l.allocated), spent: Number(l.spent) })),
    organization: project.organization,
  });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `${pdfDisposition(req)}; filename="rapport-${parsed.data.format.toLowerCase()}-${project.code}.pdf"`);
  res.send(buffer);
});
