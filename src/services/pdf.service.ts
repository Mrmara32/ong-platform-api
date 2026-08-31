import PDFDocument from "pdfkit";
import https from "https";
import http from "http";
import { amountToFrenchWordsAdministrative } from "./number-to-words.service";

/** Convertit un PDFDocument pdfkit en Buffer, sans passer par le système de fichiers. */
function toBuffer(build: (doc: PDFKit.PDFDocument) => Promise<void> | void): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    Promise.resolve(build(doc))
      .then(() => doc.end())
      .catch(reject);
  });
}

/**
 * Résout le logo de l'organisation en Buffer image, quel que soit son format
 * de stockage : data URL base64 (saisie directe dans les paramètres) ou URL
 * distante (logo hébergé ailleurs). Ne fait jamais échouer la génération du
 * document si le logo est absent ou inaccessible — le document reste valide,
 * simplement sans logo.
 */
async function resolveLogoBuffer(logoUrl?: string | null): Promise<Buffer | null> {
  if (!logoUrl) return null;
  try {
    if (logoUrl.startsWith("data:image")) {
      const base64 = logoUrl.split(",")[1];
      return base64 ? Buffer.from(base64, "base64") : null;
    }
    if (logoUrl.startsWith("http")) {
      const client = logoUrl.startsWith("https") ? https : http;
      return await new Promise((resolve) => {
        client
          .get(logoUrl, (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => resolve(Buffer.concat(chunks)));
          })
          .on("error", () => resolve(null));
      });
    }
  } catch {
    return null;
  }
  return null;
}

interface OrganizationHeader {
  name: string;
  address?: string | null;
  registrationNumber?: string | null;
  taxId?: string | null;
  phone?: string | null;
  email?: string | null;
  logoUrl?: string | null;
}

/** En-tête institutionnel commun à tous les documents officiels (bulletin, facture, TDR...). */
export async function drawOrganizationHeader(doc: PDFKit.PDFDocument, org: OrganizationHeader) {
  const logo = await resolveLogoBuffer(org.logoUrl);
  const textX = logo ? 110 : 50;

  if (logo) {
    try {
      doc.image(logo, 50, 45, { width: 50, height: 50, fit: [50, 50] });
    } catch {
      // Image invalide ou format non supporté par pdfkit — on continue sans bloquer le document
    }
  }

  doc.fontSize(13).fillColor("#101B33").text(org.name, textX, 48, { width: 400 });
  doc.fontSize(8).fillColor("#7A8399");
  if (org.address) doc.text(org.address, textX, doc.y);
  const legalLine = [
    org.registrationNumber ? `N° d'agrément : ${org.registrationNumber}` : null,
    org.taxId ? `NIF : ${org.taxId}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  if (legalLine) doc.text(legalLine, textX);
  const contactLine = [org.phone, org.email].filter(Boolean).join(" · ");
  if (contactLine) doc.text(contactLine, textX);

  doc.moveDown(2);
  const lineY = Math.max(doc.y, 100);
  doc.moveTo(50, lineY).lineTo(545, lineY).strokeColor("#E4E7EE").stroke();
  doc.y = lineY + 15;
}

export async function generatePayslipPdfBuffer(payslip: {
  period: string;
  baseSalary: number;
  bonuses: number;
  deductions: number;
  netPay: number;
  staff: { fullName: string; jobTitle: string; email?: string | null; phone?: string | null; organization: OrganizationHeader };
}): Promise<Buffer> {
  return toBuffer(async (doc) => {
    await drawOrganizationHeader(doc, payslip.staff.organization);

    doc.fontSize(16).fillColor("#101B33").font("Helvetica-Bold").text("BULLETIN DE PAIE", { align: "center" });
    doc.moveDown(0.3);
    const [year, month] = payslip.period.split("-");
    const periodLabel = new Date(Number(year), Number(month) - 1, 1).toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
    doc.fontSize(10).font("Helvetica").fillColor("#3D4761").text(`Période de paie : ${periodLabel}`, { align: "center" });
    doc.moveDown(1.5);

    // --- Bloc identification employé ---
    const boxTop = doc.y;
    doc.rect(50, boxTop, 495, 60).fillAndStroke("#FAFBFC", "#E4E7EE");
    doc.fillColor("#101B33").fontSize(10).font("Helvetica-Bold").text("Employé", 60, boxTop + 8);
    doc.font("Helvetica").fontSize(9).fillColor("#3D4761");
    doc.text(`Nom et prénoms : ${payslip.staff.fullName}`, 60, boxTop + 24);
    doc.text(`Fonction : ${payslip.staff.jobTitle}`, 60, boxTop + 38);
    const contact = [payslip.staff.phone, payslip.staff.email].filter(Boolean).join(" · ");
    if (contact) doc.text(contact, 300, boxTop + 24, { width: 230 });
    doc.y = boxTop + 70;
    doc.moveDown(0.5);

    // --- Tableau des éléments de rémunération ---
    const tableTop = doc.y;
    const col1 = 60, col2 = 400;
    doc.font("Helvetica-Bold").fontSize(9).fillColor("#101B33");
    doc.text("Élément de rémunération", col1, tableTop);
    doc.text("Montant (GNF)", col2, tableTop, { width: 140, align: "right" });
    doc.moveTo(50, tableTop + 14).lineTo(545, tableTop + 14).strokeColor("#101B33").stroke();

    let y = tableTop + 22;
    const row = (label: string, amount: number, bold = false) => {
      doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(9).fillColor(bold ? "#101B33" : "#3D4761");
      doc.text(label, col1, y);
      doc.text(amount.toLocaleString("fr-FR"), col2, y, { width: 140, align: "right" });
      y += 16;
    };

    row("Salaire de base", payslip.baseSalary);
    if (payslip.bonuses > 0) row("Primes et indemnités", payslip.bonuses);
    const grossPay = payslip.baseSalary + payslip.bonuses;
    doc.moveTo(50, y).lineTo(545, y).strokeColor("#E4E7EE").stroke();
    y += 6;
    row("Salaire brut", grossPay, true);
    y += 4;
    if (payslip.deductions > 0) row("Retenues (cotisations sociales et fiscales)", -payslip.deductions);
    doc.moveTo(50, y).lineTo(545, y).strokeColor("#101B33").stroke();
    y += 8;

    doc.rect(col1 - 10, y, 495, 26).fill("#101B33");
    doc.fillColor("#E8B564").font("Helvetica-Bold").fontSize(11);
    doc.text("NET À PAYER", col1, y + 7);
    doc.text(`${payslip.netPay.toLocaleString("fr-FR")} GNF`, col2, y + 7, { width: 140, align: "right" });
    doc.y = y + 45;

    // --- Signatures ---
    doc.fontSize(8).fillColor("#7A8399").font("Helvetica");
    doc.text("Ce bulletin de paie doit être conservé sans limitation de durée.", 50, doc.y);
    doc.moveDown(2);
    const sigY = doc.y;
    doc.text("Signature de l'employeur", 60, sigY);
    doc.text("Signature de l'employé", 350, sigY);
    doc.moveTo(60, sigY + 40).lineTo(220, sigY + 40).strokeColor("#D8DCE6").stroke();
    doc.moveTo(350, sigY + 40).lineTo(510, sigY + 40).strokeColor("#D8DCE6").stroke();
  });
}

export async function generateInvoicePdfBuffer(invoice: {
  number: string;
  clientName: string;
  currency: string;
  issueDate: Date;
  dueDate: Date;
  status: string;
  lines: { description: string; quantity: number; unitPrice: number }[];
  organization: OrganizationHeader;
}): Promise<Buffer> {
  return toBuffer(async (doc) => {
    await drawOrganizationHeader(doc, invoice.organization);

    doc.fontSize(18).fillColor("#101B33").font("Helvetica-Bold").text(`FACTURE ${invoice.number}`);
    doc.moveDown(0.3);
    doc.fontSize(9).font("Helvetica").fillColor("#3D4761");
    doc.text(`Client / partenaire facturé : ${invoice.clientName}`);
    doc.text(`Émise le : ${invoice.issueDate.toLocaleDateString("fr-FR")}   ·   Échéance : ${invoice.dueDate.toLocaleDateString("fr-FR")}`);
    doc.text(`Statut : ${invoice.status}`);
    doc.moveDown(1);

    const col1 = 60, col2 = 320, col3 = 400, col4 = 470;
    let y = doc.y;
    doc.font("Helvetica-Bold").fontSize(9).fillColor("#101B33");
    doc.text("Description", col1, y);
    doc.text("Qté", col2, y, { width: 60, align: "right" });
    doc.text("P.U.", col3, y, { width: 60, align: "right" });
    doc.text("Total", col4, y, { width: 75, align: "right" });
    y += 14;
    doc.moveTo(50, y).lineTo(545, y).strokeColor("#101B33").stroke();
    y += 8;

    let total = 0;
    doc.font("Helvetica").fontSize(9).fillColor("#3D4761");
    invoice.lines.forEach((l) => {
      const lineTotal = Number(l.quantity) * Number(l.unitPrice);
      total += lineTotal;
      doc.text(l.description, col1, y, { width: 250 });
      doc.text(String(l.quantity), col2, y, { width: 60, align: "right" });
      doc.text(Number(l.unitPrice).toLocaleString("fr-FR"), col3, y, { width: 60, align: "right" });
      doc.text(lineTotal.toLocaleString("fr-FR"), col4, y, { width: 75, align: "right" });
      y += 16;
    });

    doc.moveTo(50, y).lineTo(545, y).strokeColor("#E4E7EE").stroke();
    y += 10;
    doc.rect(col1 - 10, y, 495, 26).fill("#101B33");
    doc.fillColor("#E8B564").font("Helvetica-Bold").fontSize(11);
    doc.text("TOTAL", col1, y + 7);
    doc.text(`${total.toLocaleString("fr-FR")} ${invoice.currency}`, col4 - 60, y + 7, { width: 135, align: "right" });
  });
}

export async function generatePurchaseOrderPdfBuffer(order: {
  number: string;
  item: string;
  amount: number;
  currency: string;
  createdAt: Date;
  status: string;
  validatedAt?: Date | null;
  validatedByName?: string | null;
  deliveryNoteRef?: string | null;
  budgetLine: { code: string; label: string };
  supplier: { name: string; contact?: string | null };
  organization: OrganizationHeader;
}): Promise<Buffer> {
  return toBuffer(async (doc) => {
    await drawOrganizationHeader(doc, order.organization);

    doc.fontSize(18).fillColor("#101B33").font("Helvetica-Bold").text(`BON DE COMMANDE ${order.number}`);
    doc.moveDown(0.3);
    doc.fontSize(9).font("Helvetica").fillColor("#3D4761");
    doc.text(`Émis le : ${order.createdAt.toLocaleDateString("fr-FR")}`);
    doc.moveDown(1);

    // --- Bloc fournisseur ---
    const boxTop = doc.y;
    doc.rect(50, boxTop, 495, order.supplier.contact ? 50 : 36).fillAndStroke("#FAFBFC", "#E4E7EE");
    doc.fillColor("#101B33").fontSize(10).font("Helvetica-Bold").text("Fournisseur", 60, boxTop + 8);
    doc.font("Helvetica").fontSize(9).fillColor("#3D4761").text(order.supplier.name, 60, boxTop + 22);
    if (order.supplier.contact) doc.text(order.supplier.contact, 60, boxTop + 36);
    doc.y = boxTop + (order.supplier.contact ? 60 : 46);
    doc.moveDown(0.5);

    // --- Détail de la commande ---
    const tableTop = doc.y;
    const col1 = 60, col2 = 320, col3 = 470;
    doc.font("Helvetica-Bold").fontSize(9).fillColor("#101B33");
    doc.text("Désignation", col1, tableTop);
    doc.text("Ligne budgétaire", col2, tableTop, { width: 140 });
    doc.text("Montant", col3, tableTop, { width: 75, align: "right" });
    doc.moveTo(50, tableTop + 14).lineTo(545, tableTop + 14).strokeColor("#101B33").stroke();

    let y = tableTop + 22;
    doc.font("Helvetica").fontSize(9).fillColor("#3D4761");
    doc.text(order.item, col1, y, { width: 250 });
    doc.text(`${order.budgetLine.code} — ${order.budgetLine.label}`, col2, y, { width: 140 });
    doc.text(order.amount.toLocaleString("fr-FR"), col3, y, { width: 75, align: "right" });
    y += 24;

    doc.moveTo(50, y).lineTo(545, y).strokeColor("#E4E7EE").stroke();
    y += 10;
    doc.rect(col1 - 10, y, 495, 26).fill("#101B33");
    doc.fillColor("#E8B564").font("Helvetica-Bold").fontSize(11);
    doc.text("MONTANT TOTAL", col1, y + 7);
    doc.text(`${order.amount.toLocaleString("fr-FR")} ${order.currency}`, col3 - 60, y + 7, { width: 135, align: "right" });
    doc.y = y + 45;

    // --- Statut / validation ---
    doc.fontSize(9).font("Helvetica").fillColor("#3D4761");
    if (order.validatedAt) {
      doc.text(`Validé le ${order.validatedAt.toLocaleDateString("fr-FR")}${order.validatedByName ? ` par ${order.validatedByName}` : ""}`);
    } else {
      doc.fillColor("#8A6116").text("En attente de validation");
    }
    if (order.deliveryNoteRef) {
      doc.fillColor("#3D4761").text(`Bon de livraison associé : ${order.deliveryNoteRef}`);
    }
    doc.moveDown(2);

    // --- Signatures ---
    doc.fontSize(8).fillColor("#7A8399");
    const sigY = doc.y;
    doc.text("Signature du fournisseur (accusé de réception)", 60, sigY, { width: 220 });
    doc.text("Signature du Président / Admin (validation)", 320, sigY, { width: 200 });
    doc.moveTo(60, sigY + 45).lineTo(260, sigY + 45).strokeColor("#D8DCE6").stroke();
    doc.moveTo(320, sigY + 45).lineTo(510, sigY + 45).strokeColor("#D8DCE6").stroke();
  });
}

/**
 * Demande de paiement adressée au bailleur — reproduit fidèlement le format
 * réel utilisé par le CAM avec USAID/RTI International : identification du
 * récipiendaire et de sa banque, numéro de subvention, montant en chiffres
 * ET en toutes lettres, justificatifs d'activités, puis double bloc de
 * signature (Président de l'ONG, puis Responsable technique du bailleur).
 */
export async function generatePaymentRequestPdfBuffer(request: {
  repereNumber: number;
  amountRequested: number;
  currency: string;
  requestDate: Date;
  achievements: string; // une ligne par réalisation
  preparedByName: string;
  preparedByTitle: string;
  project: { name: string; grantNumber?: string | null };
  organization: OrganizationHeader & { bankName?: string | null; bankAddress?: string | null; bankAccountNumber?: string | null };
}): Promise<Buffer> {
  return toBuffer(async (doc) => {
    await drawOrganizationHeader(doc, request.organization);

    doc.fontSize(15).fillColor("#101B33").font("Helvetica-Bold").text(`DEMANDE DE PAIEMENT — REPÈRE N° ${request.repereNumber}`, { align: "center" });
    doc.moveDown(1.2);

    const section = (title: string) => {
      doc.fontSize(10).font("Helvetica-Bold").fillColor("#101B33").text(title);
      doc.moveTo(50, doc.y + 2).lineTo(545, doc.y + 2).strokeColor("#E4E7EE").stroke();
      doc.moveDown(0.6);
    };
    const field = (label: string, value: string) => {
      doc.fontSize(9).font("Helvetica").fillColor("#3D4761").text(`${label} ${value}`);
      doc.moveDown(0.25);
    };

    section("INFORMATION SUR LE RÉCIPIENDAIRE");
    field("1. Nom du Récipiendaire :", request.organization.name);
    field("2. Adresse du Récipiendaire :", request.organization.address ?? "—");
    field("3. Nom de la Banque :", request.organization.bankName ?? "—");
    field("4. Adresse de la banque :", request.organization.bankAddress ?? "—");
    field("5. N° de compte bancaire :", request.organization.bankAccountNumber ?? "—");
    field("6. N° de Subvention :", request.project.grantNumber ?? "—");
    doc.moveDown(0.5);

    section("DÉTAILS DE LA DEMANDE DE PAIEMENT");
    field("7. Montant demandé :", `${request.amountRequested.toLocaleString("fr-FR")} ${request.currency}`);
    doc.fontSize(9).font("Helvetica-Oblique").fillColor("#3D4761").text(`(${amountToFrenchWordsAdministrative(request.amountRequested, request.currency)})`);
    doc.moveDown(0.4);
    field("8. Date de la demande :", request.requestDate.toLocaleDateString("fr-FR", { weekday: "long", year: "numeric", month: "long", day: "numeric" }));
    doc.moveDown(0.4);
    doc.fontSize(9).font("Helvetica-Bold").fillColor("#101B33").text("9. Réalisations et justificatifs :");
    doc.font("Helvetica").fillColor("#3D4761");
    request.achievements.split("\n").filter(Boolean).forEach((line) => doc.text(`• ${line.trim()}`, { indent: 10 }));
    doc.moveDown(0.6);
    field("10. Approuvé par (Nom, Titre) :", `${request.preparedByName} — ${request.preparedByTitle}`);
    doc.moveDown(0.3);
    doc.fontSize(9).text("11. Signature : ___________________________________________________________");
    doc.moveDown(1.2);

    section("POUR LE BAILLEUR SEULEMENT (Responsable Technique)");
    const line = (label: string) => { doc.fontSize(9).fillColor("#3D4761").text(`${label} ___________________________________________`); doc.moveDown(0.5); };
    line("Date de réception :");
    line("Le rapport est-il à jour ? :");
    line("Titre et date du dernier rapport reçu :");
    line("Le rapport suivant (titre) est dû (date) :");
    doc.moveDown(0.3);
    doc.fontSize(8).font("Helvetica-Oblique").text(
      "En signant en bas, vous confirmez avoir vérifié les livrables et rapports ci-dessus et confirmez que l'information est correcte et que les fonds demandés pourraient être transférés au Récipiendaire."
    );
    doc.moveDown(0.5);
    doc.font("Helvetica").fontSize(9);
    line('Veuillez écrire en toute lettre « Je confirme » :');
    line("Autorisé par :");
    line("Signature et date :");
    line("Approuvé par le Responsable des Subventions :");
    line("Signature et date :");
  });
}

/**
 * Lettre officielle sur papier à en-tête — reproduit le format réel utilisé
 * par le CAM (référence N°/CAM/BK/année, lieu et date, objet, corps libre,
 * bloc signataire). Réutilise le même en-tête institutionnel que les autres
 * documents pour une identité visuelle cohérente.
 */
export async function generateLetterPdfBuffer(letter: {
  reference?: string | null;
  createdAt: Date;
  recipientTitle: string;
  subject: string;
  body: string;
  signatoryName: string;
  signatoryTitle: string;
  organization: OrganizationHeader;
}): Promise<Buffer> {
  return toBuffer(async (doc) => {
    await drawOrganizationHeader(doc, letter.organization);

    doc.fontSize(9).fillColor("#3D4761").font("Helvetica");
    const city = letter.organization.address?.split(",").pop()?.trim() || "";
    doc.text(
      `${letter.reference ? letter.reference + "  " : ""}${city ? city + ", le " : "Le "}${letter.createdAt.toLocaleDateString("fr-FR")}`,
      { align: "right" }
    );
    doc.moveDown(1.5);

    doc.font("Helvetica-Bold").text(`Objet : ${letter.subject}`);
    doc.moveDown(1);

    doc.font("Helvetica").text(letter.recipientTitle);
    doc.moveDown(1.5);

    doc.text(letter.body, { align: "justify", lineGap: 3 });
    doc.moveDown(2);

    doc.text(letter.signatoryTitle, { align: "right" });
    doc.font("Helvetica-Bold").text(letter.signatoryName, { align: "right" });
  });
}
