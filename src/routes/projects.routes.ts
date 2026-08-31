import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth, requireRole } from "../middleware/auth";
import { resolveProjectAccess, personalScopeFilter } from "../middleware/access";

export const projectsRouter = Router();
projectsRouter.use(requireAuth);

// Toutes les requêtes sont systématiquement filtrées par organizationId issu
// du token — jamais par une valeur envoyée par le client. C'est ce qui garantit
// l'isolation entre organisations sur la plateforme multi-tenant.

projectsRouter.get("/", async (req, res) => {
  const projects = await prisma.project.findMany({
    where: { organizationId: req.auth!.organizationId },
    include: { budgetLines: true },
    orderBy: { startDate: "desc" },
  });
  res.json(projects);
});

projectsRouter.get("/:id", async (req, res) => {
  const project = await prisma.project.findFirst({
    where: { id: req.params.id, organizationId: req.auth!.organizationId },
    include: { budgetLines: true, logframe: true, activities: true, sharedWith: { include: { organization: true } } },
  });
  if (!project) return res.status(404).json({ error: "Projet introuvable" });
  res.json(project);
});

const createProjectSchema = z.object({
  name: z.string().min(2),
  code: z.string().min(2),
  donor: z.string(),
  grantNumber: z.string().optional(),
  currency: z.enum(["GNF", "USD", "EUR"]).default("GNF"),
  totalBudget: z.number().positive(),
  startDate: z.string(),
  endDate: z.string(),
  budgetLines: z
    .array(z.object({ code: z.string(), label: z.string(), allocated: z.number().nonnegative() }))
    .min(1),
});

projectsRouter.post("/", requireRole("ADMIN", "CHEF_PROJET"), async (req, res) => {
  const parsed = createProjectSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const data = parsed.data;

  const project = await prisma.project.create({
    data: {
      organizationId: req.auth!.organizationId,
      name: data.name,
      code: data.code,
      donor: data.donor,
      grantNumber: data.grantNumber,
      currency: data.currency,
      totalBudget: data.totalBudget,
      startDate: new Date(data.startDate),
      endDate: new Date(data.endDate),
      budgetLines: { create: data.budgetLines },
    },
    include: { budgetLines: true },
  });

  res.status(201).json(project);
});

// Invitation d'une organisation partenaire sur un projet (collaboration inter-ONG)
projectsRouter.post("/:id/partners", requireRole("ADMIN", "CHEF_PROJET"), async (req, res) => {
  const { partnerOrganizationId } = req.body as { partnerOrganizationId: string };
  const project = await prisma.project.findFirst({
    where: { id: req.params.id, organizationId: req.auth!.organizationId },
  });
  if (!project) return res.status(404).json({ error: "Projet introuvable" });

  const link = await prisma.projectPartner.create({
    data: { projectId: project.id, organizationId: partnerOrganizationId },
  });
  res.status(201).json(link);
});

/**
 * Activités d'un projet, filtrées selon la portée d'accès de l'utilisateur :
 * - accès COMPLET (Admin/Président, Chef de projet responsable) → toutes les activités
 * - accès PERSONNEL (Membre, Partenaire) → uniquement les activités dont il est responsable
 * C'est ce endpoint qui matérialise "l'espace dédié" décrit au §2.1.1 du cahier des charges.
 */
projectsRouter.get("/:id/activities", async (req, res) => {
  const project = await prisma.project.findFirst({
    where: { id: req.params.id, organizationId: req.auth!.organizationId },
  });
  if (!project) return res.status(404).json({ error: "Projet introuvable" });

  const access = await resolveProjectAccess(req.auth!, project.id);
  if (!access.canAccess) return res.status(403).json({ error: "Aucun accès à ce projet" });

  const activities = await prisma.activity.findMany({
    where: {
      projectId: project.id,
      ...personalScopeFilter(access, req.auth!.userId, "ownerId"),
    },
    include: { owner: { select: { id: true, fullName: true } }, budgetLine: { select: { code: true, label: true } } },
    orderBy: { startDate: "asc" },
  });

  res.json({ scope: access.scope, activities });
});

const activitySchema = z.object({
  title: z.string().min(2),
  startDate: z.string(),
  endDate: z.string(),
  ownerId: z.string().uuid().optional(), // par défaut, l'activité est assignée à son créateur
  budgetLineId: z.string().uuid().optional(), // ligne budgétaire du projet portant le coût de l'activité
  estimatedCost: z.number().nonnegative().optional(),
});

/**
 * Planifie une activité, avec son coût le cas échéant rattaché à une ligne
 * budgétaire précise du projet — conformément à l'exigence de planification
 * chiffrée en cohérence avec le budget disponible. Si un coût dépasse le
 * disponible de la ligne, la création reste possible (dérogation métier) mais
 * l'API renvoie `exceedsBudgetLine: true` pour que l'interface puisse alerter.
 */
projectsRouter.post("/:id/activities", async (req, res) => {
  const parsed = activitySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const project = await prisma.project.findFirst({
    where: { id: req.params.id, organizationId: req.auth!.organizationId },
  });
  if (!project) return res.status(404).json({ error: "Projet introuvable" });

  const access = await resolveProjectAccess(req.auth!, project.id);
  if (!access.canAccess) return res.status(403).json({ error: "Aucun accès à ce projet" });

  let exceedsBudgetLine = false;
  if (parsed.data.budgetLineId && parsed.data.estimatedCost) {
    const line = await prisma.budgetLine.findUnique({ where: { id: parsed.data.budgetLineId } });
    if (line) {
      const alreadyPlanned = await prisma.activity.aggregate({
        where: { budgetLineId: parsed.data.budgetLineId },
        _sum: { estimatedCost: true },
      });
      const committed = Number(alreadyPlanned._sum.estimatedCost ?? 0) + Number(line.spent);
      exceedsBudgetLine = committed + parsed.data.estimatedCost > Number(line.allocated);
    }
  }

  const activity = await prisma.activity.create({
    data: {
      projectId: project.id,
      title: parsed.data.title,
      startDate: new Date(parsed.data.startDate),
      endDate: new Date(parsed.data.endDate),
      ownerId: parsed.data.ownerId ?? req.auth!.userId,
      budgetLineId: parsed.data.budgetLineId,
      estimatedCost: parsed.data.estimatedCost,
    },
  });

  res.status(201).json({ ...activity, exceedsBudgetLine });
});

/**
 * Rattache un utilisateur à ce projet avec un rôle et une portée d'accès
 * donnés. Seul un Admin/Président ou un Responsable du projet peut le faire.
 */
const projectMembershipSchema = z.object({
  userId: z.string().uuid(),
  role: z.enum(["RESPONSABLE", "MEMBRE", "PARTENAIRE", "LECTURE_SEULE"]),
  scope: z.enum(["COMPLET", "PERSONNEL"]).default("PERSONNEL"),
});

projectsRouter.post("/:id/members", async (req, res) => {
  const project = await prisma.project.findFirst({
    where: { id: req.params.id, organizationId: req.auth!.organizationId },
  });
  if (!project) return res.status(404).json({ error: "Projet introuvable" });

  const access = await resolveProjectAccess(req.auth!, project.id);
  if (!access.canAccess || access.scope !== "COMPLET") {
    return res.status(403).json({ error: "Seul un accès complet au projet permet de gérer les membres" });
  }

  const parsed = projectMembershipSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const membership = await prisma.projectMembership.upsert({
    where: { userId_projectId: { userId: parsed.data.userId, projectId: project.id } },
    update: { role: parsed.data.role, scope: parsed.data.scope },
    create: { userId: parsed.data.userId, projectId: project.id, role: parsed.data.role, scope: parsed.data.scope },
  });

  res.status(201).json(membership);
});

/**
 * Liste les membres explicitement rattachés à ce projet (portée COMPLET ou
 * PERSONNEL). N'inclut pas l'Admin/Président de l'organisation, qui a accès
 * sans jamais avoir besoin d'un ProjectMembership — voir §2.1.1.
 */
projectsRouter.get("/:id/members", async (req, res) => {
  const project = await prisma.project.findFirst({
    where: { id: req.params.id, organizationId: req.auth!.organizationId },
  });
  if (!project) return res.status(404).json({ error: "Projet introuvable" });

  const access = await resolveProjectAccess(req.auth!, project.id);
  if (!access.canAccess) return res.status(403).json({ error: "Aucun accès à ce projet" });

  const members = await prisma.projectMembership.findMany({
    where: { projectId: project.id },
    include: { user: { select: { id: true, fullName: true, email: true } } },
    orderBy: { createdAt: "asc" },
  });
  res.json(members);
});

projectsRouter.delete("/:id/members/:userId", async (req, res) => {
  const project = await prisma.project.findFirst({
    where: { id: req.params.id, organizationId: req.auth!.organizationId },
  });
  if (!project) return res.status(404).json({ error: "Projet introuvable" });

  const access = await resolveProjectAccess(req.auth!, project.id);
  if (!access.canAccess || access.scope !== "COMPLET") {
    return res.status(403).json({ error: "Seul un accès complet au projet permet de gérer les membres" });
  }

  await prisma.projectMembership.deleteMany({
    where: { projectId: project.id, userId: req.params.userId },
  });
  res.status(204).send();
});

// ---------------------------------------------------------------------------
// Cadre logique — matrice d'indicateurs (objectifs, résultats, activités)
// ---------------------------------------------------------------------------

const logframeSchema = z.object({
  objective: z.string().min(2),
  result: z.string().min(2),
  indicator: z.string().min(2),
  target: z.number().positive(),
});

/** Ajoute un indicateur à la matrice du cadre logique du projet. */
projectsRouter.post("/:id/logframe", async (req, res) => {
  const parsed = logframeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const project = await prisma.project.findFirst({
    where: { id: req.params.id, organizationId: req.auth!.organizationId },
  });
  if (!project) return res.status(404).json({ error: "Projet introuvable" });

  const access = await resolveProjectAccess(req.auth!, project.id);
  if (!access.canAccess || access.scope !== "COMPLET") {
    return res.status(403).json({ error: "Seul un accès complet au projet permet de gérer le cadre logique" });
  }

  const indicator = await prisma.logframeResult.create({
    data: { projectId: project.id, ...parsed.data },
  });
  res.status(201).json(indicator);
});

const logframeUpdateSchema = z.object({
  achieved: z.number().nonnegative().optional(),
  target: z.number().positive().optional(),
});

/** Met à jour la valeur atteinte d'un indicateur — c'est ici que le suivi périodique se fait. */
projectsRouter.patch("/logframe/:logframeId", async (req, res) => {
  const parsed = logframeUpdateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  if (Object.keys(parsed.data).length === 0) return res.status(400).json({ error: "Aucun champ à mettre à jour" });

  const indicator = await prisma.logframeResult.findFirst({
    where: { id: req.params.logframeId, project: { organizationId: req.auth!.organizationId } },
  });
  if (!indicator) return res.status(404).json({ error: "Indicateur introuvable" });

  const access = await resolveProjectAccess(req.auth!, indicator.projectId);
  if (!access.canAccess || access.scope !== "COMPLET") {
    return res.status(403).json({ error: "Seul un accès complet au projet permet de mettre à jour le cadre logique" });
  }

  const updated = await prisma.logframeResult.update({ where: { id: indicator.id }, data: parsed.data });
  res.json(updated);
});

projectsRouter.delete("/logframe/:logframeId", async (req, res) => {
  const indicator = await prisma.logframeResult.findFirst({
    where: { id: req.params.logframeId, project: { organizationId: req.auth!.organizationId } },
  });
  if (!indicator) return res.status(404).json({ error: "Indicateur introuvable" });

  const access = await resolveProjectAccess(req.auth!, indicator.projectId);
  if (!access.canAccess || access.scope !== "COMPLET") {
    return res.status(403).json({ error: "Seul un accès complet au projet permet de gérer le cadre logique" });
  }

  await prisma.logframeResult.delete({ where: { id: indicator.id } });
  res.status(204).send();
});

// ---------------------------------------------------------------------------
// Collecte de données terrain — mises à jour d'activités
// ---------------------------------------------------------------------------

const activityUpdateSchema = z.object({
  note: z.string().min(3),
  beneficiariesReached: z.number().int().nonnegative().optional(),
  progressPct: z.number().int().min(0).max(100).optional(),
});

/**
 * Formulaire de remontée terrain — tout utilisateur ayant accès à
 * l'activité peut soumettre une mise à jour (avancement, bénéficiaires
 * touchés, observations), sans attendre un rapport formel. Si un
 * pourcentage d'avancement est fourni, il met aussi à jour l'activité
 * elle-même.
 */
projectsRouter.post("/activities/:activityId/updates", async (req, res) => {
  const parsed = activityUpdateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const activity = await prisma.activity.findFirst({
    where: { id: req.params.activityId, project: { organizationId: req.auth!.organizationId } },
  });
  if (!activity) return res.status(404).json({ error: "Activité introuvable" });

  const access = await resolveProjectAccess(req.auth!, activity.projectId);
  if (!access.canAccess) return res.status(403).json({ error: "Aucun accès à ce projet" });

  const update = await prisma.activityUpdate.create({
    data: { activityId: activity.id, submittedById: req.auth!.userId, ...parsed.data },
  });

  if (parsed.data.progressPct !== undefined) {
    await prisma.activity.update({ where: { id: activity.id }, data: { progressPct: parsed.data.progressPct } });
  }

  res.status(201).json(update);
});

projectsRouter.get("/activities/:activityId/updates", async (req, res) => {
  const activity = await prisma.activity.findFirst({
    where: { id: req.params.activityId, project: { organizationId: req.auth!.organizationId } },
  });
  if (!activity) return res.status(404).json({ error: "Activité introuvable" });

  const access = await resolveProjectAccess(req.auth!, activity.projectId);
  if (!access.canAccess) return res.status(403).json({ error: "Aucun accès à ce projet" });

  const updates = await prisma.activityUpdate.findMany({
    where: { activityId: activity.id },
    orderBy: { date: "desc" },
  });
  res.json(updates);
});

// ---------------------------------------------------------------------------
// Tableau de bord d'impact — évolution des bénéficiaires en temps réel
// ---------------------------------------------------------------------------

/**
 * Agrège toutes les remontées terrain d'un projet pour visualiser
 * l'évolution cumulée des bénéficiaires touchés dans le temps — c'est le
 * "temps réel" demandé : chaque mise à jour terrain alimente immédiatement
 * ce tableau de bord, sans attendre un rapport de fin de projet.
 */
projectsRouter.get("/:id/impact-dashboard", async (req, res) => {
  const project = await prisma.project.findFirst({
    where: { id: req.params.id, organizationId: req.auth!.organizationId },
  });
  if (!project) return res.status(404).json({ error: "Projet introuvable" });

  const access = await resolveProjectAccess(req.auth!, project.id);
  if (!access.canAccess) return res.status(403).json({ error: "Aucun accès à ce projet" });

  const updates = await prisma.activityUpdate.findMany({
    where: { activity: { projectId: project.id }, beneficiariesReached: { not: null } },
    orderBy: { date: "asc" },
    include: { activity: { select: { title: true } } },
  });

  let cumulative = 0;
  const timeline = updates.map((u) => {
    cumulative += u.beneficiariesReached ?? 0;
    return {
      date: u.date,
      activityTitle: u.activity.title,
      beneficiariesReached: u.beneficiariesReached,
      cumulativeBeneficiaries: cumulative,
      note: u.note,
    };
  });

  res.json({
    totalBeneficiaries: cumulative,
    totalUpdates: updates.length,
    timeline,
  });
});
