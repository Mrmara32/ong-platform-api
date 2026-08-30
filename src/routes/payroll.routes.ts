import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth, requireRole } from "../middleware/auth";
import { recordPayslipPayment } from "../services/accounting.service";
import { generatePayslipPdfBuffer } from "../services/pdf.service";
import { sendMail } from "../lib/mailer";

export const payrollRouter = Router();
payrollRouter.use(requireAuth);

payrollRouter.get("/payslips", async (req, res) => {
  const { staffId } = req.query;
  const payslips = await prisma.payslip.findMany({
    where: {
      staff: { organizationId: req.auth!.organizationId },
      ...(staffId ? { staffId: String(staffId) } : {}),
    },
    include: { staff: true, payments: true },
    orderBy: { period: "desc" },
  });
  res.json(payslips);
});

const payslipSchema = z.object({
  staffId: z.string().uuid(),
  period: z.string().regex(/^\d{4}-\d{2}$/, "Format attendu : YYYY-MM"),
  baseSalary: z.number().positive(),
  bonuses: z.number().nonnegative().default(0),
  deductions: z.number().nonnegative().default(0),
});

/** Génère le bulletin de paie mensuel d'un employé (net = base + primes - retenues). */
payrollRouter.post("/payslips", requireRole("ADMIN", "RH", "COMPTABLE"), async (req, res) => {
  const parsed = payslipSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { staffId, period, baseSalary, bonuses, deductions } = parsed.data;

  const staff = await prisma.staff.findFirst({
    where: { id: staffId, organizationId: req.auth!.organizationId },
  });
  if (!staff) return res.status(404).json({ error: "Employé introuvable" });

  const netPay = baseSalary + bonuses - deductions;
  const payslip = await prisma.payslip.upsert({
    where: { staffId_period: { staffId, period } },
    update: { baseSalary, bonuses, deductions, netPay },
    create: { staffId, period, baseSalary, bonuses, deductions, netPay },
  });

  res.status(201).json(payslip);
});

const paySchema = z.object({
  projectId: z.string().uuid(),
  budgetLineId: z.string().uuid(),
  method: z.enum(["VIREMENT", "ORANGE_MONEY", "MTN_MONEY", "MOOV_MONEY", "WAVE", "ESPECES", "CHEQUE"]),
  reference: z.string().optional(),
});

/** Paie effectivement le net à payer d'un bulletin, quel que soit le canal choisi. */
payrollRouter.post("/payslips/:id/pay", requireRole("ADMIN", "COMPTABLE"), async (req, res) => {
  const parsed = paySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const payslip = await prisma.payslip.findFirst({
    where: { id: req.params.id, staff: { organizationId: req.auth!.organizationId } },
  });
  if (!payslip) return res.status(404).json({ error: "Bulletin introuvable" });

  const payment = await recordPayslipPayment({
    organizationId: req.auth!.organizationId,
    payslipId: payslip.id,
    staffId: payslip.staffId,
    amount: Number(payslip.netPay),
    ...parsed.data,
  });

  res.status(201).json(payment);
});

const shareSchema = z.object({
  channel: z.enum(["email", "whatsapp"]),
});

/**
 * Partage un bulletin de paie déjà généré, par email ou WhatsApp.
 *
 * - email : le PDF est généré à la volée (même moteur que l'export
 *   téléchargeable, cf. services/pdf.service.ts) et envoyé en pièce jointe
 *   via le service SMTP configuré (lib/mailer.ts — n'importe quel fournisseur
 *   SMTP standard). Si aucun SMTP n'est configuré, l'envoi est simulé et
 *   tracé en log plutôt que de faire échouer la requête.
 * - whatsapp : WhatsApp ne permet pas d'attacher un fichier arbitraire sans
 *   l'API Business ; on génère donc un lien de partage `wa.me` pré-rempli
 *   pointant vers l'URL sécurisée du bulletin (téléchargeable via
 *   /api/export/payslips/:id/pdf), que l'employé ouvre et télécharge lui-même.
 */
payrollRouter.post("/payslips/:id/share", requireRole("ADMIN", "RH"), async (req, res) => {
  const parsed = shareSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const payslip = await prisma.payslip.findFirst({
    where: { id: req.params.id, staff: { organizationId: req.auth!.organizationId } },
    include: { staff: { include: { organization: true } } },
  });
  if (!payslip) return res.status(404).json({ error: "Bulletin introuvable" });

  const documentUrl = `${process.env.PUBLIC_APP_URL ?? "https://app.exemple.org"}/api/export/payslips/${payslip.id}/pdf`;
  const { channel } = parsed.data;

  let shareResult: { channel: string; target?: string; link?: string; simulated?: boolean };

  if (channel === "whatsapp") {
    if (!payslip.staff.phone) return res.status(400).json({ error: "Aucun numéro de téléphone enregistré pour cet employé" });
    const text = encodeURIComponent(
      `Bonjour ${payslip.staff.fullName}, voici votre bulletin de paie pour la période ${payslip.period} : ${documentUrl}`
    );
    shareResult = { channel, target: payslip.staff.phone, link: `https://wa.me/${payslip.staff.phone.replace(/\D/g, "")}?text=${text}` };
  } else {
    if (!payslip.staff.email) return res.status(400).json({ error: "Aucun email enregistré pour cet employé" });

    const pdfBuffer = await generatePayslipPdfBuffer({
      period: payslip.period,
      baseSalary: Number(payslip.baseSalary),
      bonuses: Number(payslip.bonuses),
      deductions: Number(payslip.deductions),
      netPay: Number(payslip.netPay),
      staff: payslip.staff,
    });

    const mailResult = await sendMail({
      to: payslip.staff.email,
      subject: `Bulletin de paie — ${payslip.period}`,
      text: `Bonjour ${payslip.staff.fullName},\n\nVeuillez trouver ci-joint votre bulletin de paie pour la période ${payslip.period}.\n\nCordialement,\n${payslip.staff.organization.name}`,
      attachments: [{ filename: `bulletin-${payslip.period}.pdf`, content: pdfBuffer, contentType: "application/pdf" }],
    });

    shareResult = { channel, target: payslip.staff.email, simulated: mailResult.simulated };
  }

  const sharedVia = Array.from(new Set([...(payslip.sharedVia ?? []), channel]));
  await prisma.payslip.update({
    where: { id: payslip.id },
    data: { sharedVia, status: payslip.status === "PAYE" ? "PAYE" : "PARTAGE" },
  });

  res.json({ documentUrl, ...shareResult });
});
