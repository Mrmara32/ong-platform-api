import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth";

export const documentsRouter = Router();
documentsRouter.use(requireAuth);

const documentSchema = z.object({
  projectId: z.string().uuid().optional(),
  title: z.string().min(2),
  type: z.enum(["TDR", "RAPPORT_ACTIVITE", "RAPPORT_FINANCIER", "AUTRE"]),
  content: z.string(),
});

documentsRouter.post("/", async (req, res) => {
  const parsed = documentSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const doc = await prisma.document.create({
    data: { ...parsed.data, organizationId: req.auth!.organizationId },
  });
  res.status(201).json(doc);
});

documentsRouter.get("/", async (req, res) => {
  const docs = await prisma.document.findMany({
    where: { organizationId: req.auth!.organizationId },
    orderBy: { createdAt: "desc" },
  });
  res.json(docs);
});

/**
 * Bascule le partage d'un document avec une organisation partenaire.
 * Le partage est toujours une décision explicite de l'organisation
 * propriétaire — jamais automatique (cf. cahier des charges §2.8).
 */
documentsRouter.post("/:id/share", async (req, res) => {
  const { partnerOrganizationId } = req.body as { partnerOrganizationId: string };
  const doc = await prisma.document.findFirst({
    where: { id: req.params.id, organizationId: req.auth!.organizationId },
  });
  if (!doc) return res.status(404).json({ error: "Document introuvable" });

  await prisma.document.update({ where: { id: doc.id }, data: { visibility: "PARTAGE" } });
  const shared = await prisma.sharedResource.upsert({
    where: { documentId_organizationId: { documentId: doc.id, organizationId: partnerOrganizationId } },
    update: {},
    create: { documentId: doc.id, organizationId: partnerOrganizationId },
  });
  res.status(201).json(shared);
});

documentsRouter.delete("/:id/share/:partnerOrganizationId", async (req, res) => {
  const doc = await prisma.document.findFirst({
    where: { id: req.params.id, organizationId: req.auth!.organizationId },
  });
  if (!doc) return res.status(404).json({ error: "Document introuvable" });

  await prisma.sharedResource.deleteMany({
    where: { documentId: doc.id, organizationId: req.params.partnerOrganizationId },
  });
  res.status(204).send();
});

/** Documents visibles par l'organisation courante parce que partagés par un partenaire. */
documentsRouter.get("/shared-with-us", async (req, res) => {
  const shared = await prisma.sharedResource.findMany({
    where: { organizationId: req.auth!.organizationId },
    include: { document: { include: { organization: true } } },
  });
  res.json(shared.map((s) => s.document));
});
