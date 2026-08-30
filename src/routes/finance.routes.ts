import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth, requireRole } from "../middleware/auth";
import { recordExpense, recordDisbursement, checkBudgetLineAvailability } from "../services/accounting.service";

export const financeRouter = Router();
financeRouter.use(requireAuth);

// -------- Lignes budgétaires --------

financeRouter.get("/projects/:projectId/budget-lines", async (req, res) => {
  const project = await prisma.project.findFirst({
    where: { id: req.params.projectId, organizationId: req.auth!.organizationId },
  });
  if (!project) return res.status(404).json({ error: "Projet introuvable" });

  const lines = await prisma.budgetLine.findMany({ where: { projectId: project.id } });
  res.json(lines);
});

financeRouter.get("/budget-lines/:id/availability", async (req, res) => {
  const availability = await checkBudgetLineAvailability(req.params.id, 0);
  res.json({
    line: availability.line,
    allocated: availability.line.allocated,
    spent: availability.line.spent,
    remaining: availability.remaining,
  });
});

// -------- Dépenses --------

const expenseSchema = z.object({
  projectId: z.string().uuid(),
  budgetLineId: z.string().uuid(),
  label: z.string().min(2),
  amount: z.number().positive(),
});

/**
 * Enregistre une dépense. Toute dépense DOIT référencer une ligne budgétaire
 * (cf. cahier des charges §2.4.2) — c'est imposé ici, pas seulement côté UI.
 * Si le montant dépasse le disponible, l'API renvoie 200 avec exceeds=true
 * plutôt que de bloquer : la dérogation reste une décision métier, tracée
 * par l'écriture comptable qui est tout de même postée.
 */
financeRouter.post("/expenses", requireRole("ADMIN", "COMPTABLE", "CHEF_PROJET"), async (req, res) => {
  const parsed = expenseSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { projectId, budgetLineId, label, amount } = parsed.data;

  const project = await prisma.project.findFirst({
    where: { id: projectId, organizationId: req.auth!.organizationId },
  });
  if (!project) return res.status(404).json({ error: "Projet introuvable" });

  const result = await recordExpense({
    organizationId: req.auth!.organizationId,
    projectId,
    budgetLineId,
    label,
    amount,
  });

  res.status(201).json({
    expense: result.expense,
    remaining: result.remainingAfter,
    exceeds: result.exceeds,
  });
});

// -------- Décaissements --------

const disbursementSchema = z.object({
  projectId: z.string().uuid(),
  budgetLineId: z.string().uuid(),
  amount: z.number().positive(),
  method: z.string().min(2),
});

financeRouter.post("/disbursements", requireRole("ADMIN", "COMPTABLE"), async (req, res) => {
  const parsed = disbursementSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { projectId, budgetLineId, amount, method } = parsed.data;

  const result = await recordDisbursement({
    organizationId: req.auth!.organizationId,
    projectId,
    budgetLineId,
    amount,
    method,
  });

  res.status(201).json({
    disbursement: result.disbursement,
    remaining: result.remainingAfter,
    exceeds: result.exceeds,
  });
});

// -------- Grand livre / Journal --------

financeRouter.get("/journal", async (req, res) => {
  const { projectId } = req.query;
  const entries = await prisma.journalEntry.findMany({
    where: {
      account: { organizationId: req.auth!.organizationId },
      ...(projectId ? { projectId: String(projectId) } : {}),
    },
    include: { account: true },
    orderBy: { date: "desc" },
    take: 200,
  });
  res.json(entries);
});
