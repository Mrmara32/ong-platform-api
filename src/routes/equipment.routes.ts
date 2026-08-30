import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth, requireRole } from "../middleware/auth";
import { recordAssetMaintenanceExpense } from "../services/accounting.service";
import { computeAlerts, refreshNotifications, notifyLogisticsOfficers } from "../services/alerts.service";

export const equipmentRouter = Router();
equipmentRouter.use(requireAuth);

// -------- Registre du matériel (PC, imprimantes, groupes électrogènes...) --------

equipmentRouter.get("/assets", async (req, res) => {
  const assets = await prisma.asset.findMany({
    where: { organizationId: req.auth!.organizationId },
    include: { maintenances: { orderBy: { date: "desc" } } },
    orderBy: { name: "asc" },
  });
  res.json(assets);
});

const assetSchema = z.object({
  category: z.enum(["INFORMATIQUE", "GENERATEUR", "MOBILIER_BUREAU", "EQUIPEMENT_TERRAIN", "AUTRE"]),
  name: z.string().min(2),
  serialNumber: z.string().optional(),
  projectId: z.string().uuid().optional(),
  acquiredAt: z.string().optional(),
  warrantyEnd: z.string().optional(),
});

equipmentRouter.post("/assets", requireRole("ADMIN", "LOGISTICIEN"), async (req, res) => {
  const parsed = assetSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const data = parsed.data;

  const asset = await prisma.asset.create({
    data: {
      organizationId: req.auth!.organizationId,
      category: data.category,
      name: data.name,
      serialNumber: data.serialNumber,
      projectId: data.projectId,
      acquiredAt: data.acquiredAt ? new Date(data.acquiredAt) : undefined,
      warrantyEnd: data.warrantyEnd ? new Date(data.warrantyEnd) : undefined,
    },
  });
  res.status(201).json(asset);
});

// -------- Maintenance / renouvellement de licence (ex. antivirus) --------

const assetMaintenanceSchema = z.object({
  projectId: z.string().uuid().optional(),
  budgetLineId: z.string().uuid().optional(),
  type: z.enum(["PREVENTIVE", "CURATIVE", "RENOUVELLEMENT_LICENCE"]),
  provider: z.string().optional(),
  description: z.string().optional(),
  cost: z.number().nonnegative().default(0),
  nextDueDate: z.string().optional(), // ex. date de la prochaine révision ou du prochain renouvellement d'antivirus
});

/**
 * Enregistre une intervention sur un matériel : entretien préventif/curatif,
 * ou renouvellement d'une licence (antivirus, logiciel sous abonnement...).
 * Comptabilise automatiquement la dépense si une ligne budgétaire est fournie,
 * et met à jour le calcul des alertes pour ce matériel.
 */
equipmentRouter.post("/assets/:id/maintenances", requireRole("ADMIN", "LOGISTICIEN"), async (req, res) => {
  const parsed = assetMaintenanceSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const data = parsed.data;

  const asset = await prisma.asset.findFirst({
    where: { id: req.params.id, organizationId: req.auth!.organizationId },
  });
  if (!asset) return res.status(404).json({ error: "Matériel introuvable" });

  const maintenance = await prisma.assetMaintenance.create({
    data: {
      assetId: asset.id,
      budgetLineId: data.budgetLineId,
      type: data.type,
      provider: data.provider,
      description: data.description,
      cost: data.cost,
      nextDueDate: data.nextDueDate ? new Date(data.nextDueDate) : undefined,
    },
  });

  if (data.cost > 0) {
    await recordAssetMaintenanceExpense({
      organizationId: req.auth!.organizationId,
      projectId: data.projectId,
      budgetLineId: data.budgetLineId,
      assetName: asset.name,
      amount: data.cost,
      description: data.description,
    });
  }

  await refreshNotifications(req.auth!.organizationId);

  res.status(201).json(maintenance);
});

// -------- Alertes (véhicules + matériel), destinées en priorité au Logisticien --------

/** Liste les alertes actuelles (calculées à la volée, sans dépendre d'un cron). */
equipmentRouter.get("/alerts", async (req, res) => {
  const alerts = await computeAlerts(req.auth!.organizationId);
  res.json(alerts.sort((a, b) => (a.urgency === b.urgency ? 0 : a.urgency === "DEPASSEE" ? -1 : 1)));
});

/**
 * Recalcule et persiste les notifications, puis envoie un email récapitulatif
 * au(x) Logisticien(s) et à l'Admin/Président de l'organisation. Prévu pour
 * être appelé par une tâche planifiée quotidienne en production ; exposé ici
 * comme endpoint pour pouvoir le déclencher à la demande.
 */
equipmentRouter.post("/alerts/notify", requireRole("ADMIN", "LOGISTICIEN"), async (req, res) => {
  await refreshNotifications(req.auth!.organizationId);
  const result = await notifyLogisticsOfficers(req.auth!.organizationId);
  res.json(result);
});

equipmentRouter.get("/notifications", async (req, res) => {
  const { projectId } = req.query;
  const notifications = await prisma.notification.findMany({
    where: {
      organizationId: req.auth!.organizationId,
      ...(projectId ? { projectId: String(projectId) } : {}),
    },
    include: { project: { select: { id: true, name: true } } },
    orderBy: [{ status: "asc" }, { urgency: "asc" }],
  });
  res.json(notifications);
});

equipmentRouter.patch("/notifications/:id/acknowledge", requireRole("ADMIN", "LOGISTICIEN"), async (req, res) => {
  const notification = await prisma.notification.findFirst({
    where: { id: req.params.id, organizationId: req.auth!.organizationId },
  });
  if (!notification) return res.status(404).json({ error: "Alerte introuvable" });

  const updated = await prisma.notification.update({
    where: { id: notification.id },
    data: { status: "TRAITEE", acknowledgedAt: new Date() },
  });
  res.json(updated);
});
