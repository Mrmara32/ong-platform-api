import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth, requireRole } from "../middleware/auth";
import { recordInvoicePayment } from "../services/accounting.service";
import { nextInvoiceNumber } from "../services/invoice-numbering.service";

export const invoicesRouter = Router();
invoicesRouter.use(requireAuth);

invoicesRouter.get("/", async (req, res) => {
  const invoices = await prisma.invoice.findMany({
    where: { organizationId: req.auth!.organizationId },
    include: { lines: true, payments: true },
    orderBy: { issueDate: "desc" },
  });
  res.json(invoices);
});

const invoiceSchema = z.object({
  projectId: z.string().uuid().optional(),
  clientName: z.string().min(2),
  currency: z.string().default("XOF"),
  dueDate: z.string(),
  lines: z.array(z.object({ description: z.string().min(2), quantity: z.number().positive().default(1), unitPrice: z.number().positive() })).min(1),
});

invoicesRouter.post("/", requireRole("ADMIN", "COMPTABLE"), async (req, res) => {
  const parsed = invoiceSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const data = parsed.data;

  const number = await nextInvoiceNumber(req.auth!.organizationId);
  const invoice = await prisma.invoice.create({
    data: {
      organizationId: req.auth!.organizationId,
      projectId: data.projectId,
      clientName: data.clientName,
      currency: data.currency,
      number,
      dueDate: new Date(data.dueDate),
      lines: { create: data.lines },
    },
    include: { lines: true },
  });

  res.status(201).json(invoice);
});

invoicesRouter.post("/:id/send", requireRole("ADMIN", "COMPTABLE"), async (req, res) => {
  const invoice = await prisma.invoice.findFirst({
    where: { id: req.params.id, organizationId: req.auth!.organizationId },
  });
  if (!invoice) return res.status(404).json({ error: "Facture introuvable" });

  // NOTE prototype : l'envoi effectif de l'email est délégué à un service de
  // messagerie (ex. Nodemailer + SMTP, ou Sendgrid). Ici on trace seulement
  // le changement de statut ; brancher le provider e-mail en phase suivante.
  const updated = await prisma.invoice.update({ where: { id: invoice.id }, data: { status: "ENVOYEE" } });
  res.json(updated);
});

const paymentSchema = z.object({
  amount: z.number().positive(),
  method: z.enum(["VIREMENT", "ORANGE_MONEY", "MTN_MONEY", "MOOV_MONEY", "WAVE", "ESPECES", "CHEQUE"]),
  reference: z.string().optional(),
});

/** Enregistre l'encaissement d'une facture, tous canaux confondus. */
invoicesRouter.post("/:id/payments", requireRole("ADMIN", "COMPTABLE"), async (req, res) => {
  const parsed = paymentSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const invoice = await prisma.invoice.findFirst({
    where: { id: req.params.id, organizationId: req.auth!.organizationId },
  });
  if (!invoice) return res.status(404).json({ error: "Facture introuvable" });

  const payment = await recordInvoicePayment({
    organizationId: req.auth!.organizationId,
    invoiceId: invoice.id,
    ...parsed.data,
  });
  res.status(201).json(payment);
});
