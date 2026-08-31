import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth, requireRole } from "../middleware/auth";
import { resolveProjectAccess } from "../middleware/access";

export const donorAllocationsRouter = Router();
donorAllocationsRouter.use(requireAuth);

// Liste les financements affectés à un projet — un projet cofinancé a
// plusieurs bailleurs, chacun avec son propre montant.
donorAllocationsRouter.get("/:projectId/donor-allocations", async (req, res) => {
  const project = await prisma.project.findFirst({
    where: { id: req.params.projectId, organizationId: req.auth!.organizationId },
  });
  if (!project) return res.status(404).json({ error: "Projet introuvable" });

  const access = await resolveProjectAccess(req.auth!, project.id);
  if (!access.canAccess) return res.status(403).json({ error: "Aucun accès à ce projet" });

  const allocations = await prisma.donorAllocation.findMany({
    where: { projectId: project.id },
    include: { donor: true, budgetLines: { select: { id: true, code: true, label: true, allocated: true, spent: true } } },
    orderBy: { createdAt: "asc" },
  });
  res.json(allocations);
});

const allocationSchema = z.object({
  donorId: z.string().uuid(),
  allocatedAmount: z.number().positive(),
  currency: z.enum(["GNF", "USD", "EUR"]).default("GNF"),
  grantNumber: z.string().optional(),
});

// Affecte un financement précis d'un bailleur à un projet — un projet peut
// avoir plusieurs bailleurs, chacun une seule fois.
donorAllocationsRouter.post("/:projectId/donor-allocations", requireRole("ADMIN", "CHEF_PROJET"), async (req, res) => {
  const parsed = allocationSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const project = await prisma.project.findFirst({
    where: { id: req.params.projectId, organizationId: req.auth!.organizationId },
  });
  if (!project) return res.status(404).json({ error: "Projet introuvable" });

  const donor = await prisma.donor.findFirst({
    where: { id: parsed.data.donorId, organizationId: req.auth!.organizationId },
  });
  if (!donor) return res.status(404).json({ error: "Bailleur introuvable" });

  const existing = await prisma.donorAllocation.findUnique({
    where: { donorId_projectId: { donorId: parsed.data.donorId, projectId: project.id } },
  });
  if (existing) return res.status(409).json({ error: "Ce bailleur est déjà affecté à ce projet" });

  const allocation = await prisma.donorAllocation.create({
    data: { projectId: project.id, ...parsed.data },
    include: { donor: true },
  });
  res.status(201).json(allocation);
});

donorAllocationsRouter.delete("/donor-allocations/:id", requireRole("ADMIN", "CHEF_PROJET"), async (req, res) => {
  const allocation = await prisma.donorAllocation.findFirst({
    where: { id: req.params.id, project: { organizationId: req.auth!.organizationId } },
  });
  if (!allocation) return res.status(404).json({ error: "Affectation introuvable" });

  await prisma.donorAllocation.delete({ where: { id: allocation.id } });
  res.status(204).send();
});

const linkBudgetLineSchema = z.object({ donorAllocationId: z.string().uuid().nullable() });

// Rattache (ou détache, si null) une ligne budgétaire à l'affectation d'un
// bailleur précis — permet ensuite de tracer exactement quelles dépenses
// (toujours imputées via une ligne budgétaire) sont couvertes par quel
// financement.
donorAllocationsRouter.patch("/budget-lines/:id/donor-allocation", requireRole("ADMIN", "COMPTABLE", "CHEF_PROJET"), async (req, res) => {
  const parsed = linkBudgetLineSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const line = await prisma.budgetLine.findFirst({
    where: { id: req.params.id, project: { organizationId: req.auth!.organizationId } },
  });
  if (!line) return res.status(404).json({ error: "Ligne budgétaire introuvable" });

  if (parsed.data.donorAllocationId) {
    const allocation = await prisma.donorAllocation.findFirst({
      where: { id: parsed.data.donorAllocationId, projectId: line.projectId },
    });
    if (!allocation) return res.status(404).json({ error: "Affectation bailleur introuvable pour ce projet" });
  }

  const updated = await prisma.budgetLine.update({
    where: { id: line.id },
    data: { donorAllocationId: parsed.data.donorAllocationId },
  });
  res.json(updated);
});

// Rapport de dépenses par bailleur — pour chaque financement affecté au
// projet, agrège les lignes budgétaires qui lui sont rattachées et calcule
// la consommation réelle de CE financement précis, distincte du budget
// global du projet.
donorAllocationsRouter.get("/:projectId/donor-report", async (req, res) => {
  const project = await prisma.project.findFirst({
    where: { id: req.params.projectId, organizationId: req.auth!.organizationId },
  });
  if (!project) return res.status(404).json({ error: "Projet introuvable" });

  const access = await resolveProjectAccess(req.auth!, project.id);
  if (!access.canAccess) return res.status(403).json({ error: "Aucun accès à ce projet" });

  const allocations = await prisma.donorAllocation.findMany({
    where: { projectId: project.id },
    include: { donor: true, budgetLines: true },
  });

  const unallocatedLines = await prisma.budgetLine.findMany({
    where: { projectId: project.id, donorAllocationId: null },
  });

  const report = allocations.map((a) => {
    const spent = a.budgetLines.reduce((s, l) => s + Number(l.spent), 0);
    const allocated = Number(a.allocatedAmount);
    return {
      donorId: a.donor.id,
      donorName: a.donor.name,
      grantNumber: a.grantNumber,
      currency: a.currency,
      allocatedAmount: allocated,
      spent,
      remaining: allocated - spent,
      executionRate: allocated > 0 ? (spent / allocated) * 100 : 0,
      budgetLines: a.budgetLines.map((l) => ({ code: l.code, label: l.label, allocated: Number(l.allocated), spent: Number(l.spent) })),
    };
  });

  res.json({
    allocations: report,
    unallocatedBudget: unallocatedLines.reduce((s, l) => s + Number(l.allocated), 0),
    unallocatedSpent: unallocatedLines.reduce((s, l) => s + Number(l.spent), 0),
  });
});
