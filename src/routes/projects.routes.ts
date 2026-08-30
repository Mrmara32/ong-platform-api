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
  currency: z.string().default("XOF"),
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
    include: { owner: { select: { id: true, fullName: true } } },
    orderBy: { startDate: "asc" },
  });

  res.json({ scope: access.scope, activities });
});

const activitySchema = z.object({
  title: z.string().min(2),
  startDate: z.string(),
  endDate: z.string(),
  ownerId: z.string().uuid().optional(), // par défaut, l'activité est assignée à son créateur
});

projectsRouter.post("/:id/activities", async (req, res) => {
  const parsed = activitySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const project = await prisma.project.findFirst({
    where: { id: req.params.id, organizationId: req.auth!.organizationId },
  });
  if (!project) return res.status(404).json({ error: "Projet introuvable" });

  const access = await resolveProjectAccess(req.auth!, project.id);
  if (!access.canAccess) return res.status(403).json({ error: "Aucun accès à ce projet" });

  const activity = await prisma.activity.create({
    data: {
      projectId: project.id,
      title: parsed.data.title,
      startDate: new Date(parsed.data.startDate),
      endDate: new Date(parsed.data.endDate),
      ownerId: parsed.data.ownerId ?? req.auth!.userId,
    },
  });

  res.status(201).json(activity);
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
