import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth, requireRole } from "../middleware/auth";
import { logAudit } from "../services/audit.service";

export const paymentRequestsRouter = Router();
paymentRequestsRouter.use(requireAuth);

paymentRequestsRouter.get("/", async (req, res) => {
  const { projectId } = req.query;
  const requests = await prisma.paymentRequest.findMany({
    where: {
      project: { organizationId: req.auth!.organizationId },
      ...(projectId ? { projectId: String(projectId) } : {}),
    },
    include: { project: { select: { name: true, code: true, currency: true } } },
    orderBy: { createdAt: "desc" },
  });
  res.json(requests);
});

const createSchema = z.object({
  projectId: z.string().uuid(),
  bankAccountId: z.string().uuid().optional(),
  repereNumber: z.number().int().positive(),
  amountRequested: z.number().positive(),
  achievements: z.string().min(3),
  preparedByName: z.string().min(2),
  preparedByTitle: z.string().min(2),
});

/**
 * Crée une demande de paiement (brouillon) — réservée au Comptable/Admin,
 * qui prépare le document avant transmission au Président pour signature.
 */
paymentRequestsRouter.post("/", requireRole("ADMIN", "COMPTABLE"), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const project = await prisma.project.findFirst({
    where: { id: parsed.data.projectId, organizationId: req.auth!.organizationId },
  });
  if (!project) return res.status(404).json({ error: "Projet introuvable" });

  const request = await prisma.paymentRequest.create({ data: parsed.data });
  res.status(201).json(request);
});

const decideSchema = z.object({ status: z.enum(["APPROUVEE_PRESIDENT", "ENVOYEE_BAILLEUR", "PAYEE"]) });

/** Fait avancer le statut de la demande — l'approbation Président est le passage obligé avant envoi au bailleur. */
paymentRequestsRouter.patch("/:id", requireRole("ADMIN", "COMPTABLE"), async (req, res) => {
  const parsed = decideSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const request = await prisma.paymentRequest.findFirst({
    where: { id: req.params.id, project: { organizationId: req.auth!.organizationId } },
  });
  if (!request) return res.status(404).json({ error: "Demande introuvable" });

  if (parsed.data.status === "APPROUVEE_PRESIDENT" && req.auth!.role !== "ADMIN") {
    return res.status(403).json({ error: "Seul le Président/Admin peut approuver une demande de paiement" });
  }

  const updated = await prisma.paymentRequest.update({
    where: { id: request.id },
    data: {
      status: parsed.data.status,
      ...(parsed.data.status === "APPROUVEE_PRESIDENT" ? { approvedById: req.auth!.userId, approvedAt: new Date() } : {}),
    },
  });
  await logAudit({
    userId: req.auth!.userId,
    organizationId: req.auth!.organizationId,
    action: `PAYMENT_REQUEST_${parsed.data.status}`,
    entity: "PaymentRequest",
    entityId: request.id,
    metadata: { repereNumber: request.repereNumber, amount: Number(request.amountRequested) },
  });
  res.json(updated);
});

// ---------------------------------------------------------------------------
// Lettres de transmission — bibliothèque de modèles + lettres générées
// ---------------------------------------------------------------------------

export const lettersRouter = Router();
lettersRouter.use(requireAuth);

lettersRouter.get("/templates", async (req, res) => {
  const templates = await prisma.letterTemplate.findMany({
    where: { organizationId: req.auth!.organizationId },
    orderBy: [{ category: "asc" }, { title: "asc" }],
  });
  res.json(templates);
});

const templateSchema = z.object({
  title: z.string().min(2),
  category: z.string().min(2),
  bodySample: z.string().min(10),
});

/** Enregistre un nouveau modèle dans la bibliothèque — la bibliothèque grandit avec l'usage de l'organisation. */
lettersRouter.post("/templates", requireRole("ADMIN", "CHEF_PROJET"), async (req, res) => {
  const parsed = templateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const template = await prisma.letterTemplate.create({
    data: { ...parsed.data, organizationId: req.auth!.organizationId },
  });
  res.status(201).json(template);
});

lettersRouter.delete("/templates/:id", requireRole("ADMIN"), async (req, res) => {
  const template = await prisma.letterTemplate.findFirst({
    where: { id: req.params.id, organizationId: req.auth!.organizationId },
  });
  if (!template) return res.status(404).json({ error: "Modèle introuvable" });
  if (template.isSystem) return res.status(403).json({ error: "Les modèles fournis par défaut ne peuvent pas être supprimés (duplique-le pour le modifier)" });

  await prisma.letterTemplate.delete({ where: { id: template.id } });
  res.status(204).send();
});

lettersRouter.get("/", async (req, res) => {
  const letters = await prisma.letter.findMany({
    where: { organizationId: req.auth!.organizationId },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  res.json(letters);
});

const letterSchema = z.object({
  templateId: z.string().uuid().optional(),
  reference: z.string().optional(),
  recipientTitle: z.string().min(2),
  subject: z.string().min(2),
  body: z.string().min(10),
  signatoryName: z.string().min(2),
  signatoryTitle: z.string().min(2),
  projectId: z.string().uuid().optional(),
});

lettersRouter.post("/", async (req, res) => {
  const parsed = letterSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const letter = await prisma.letter.create({
    data: { ...parsed.data, organizationId: req.auth!.organizationId },
  });
  res.status(201).json(letter);
});
