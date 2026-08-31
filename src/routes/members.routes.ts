import { Router } from "express";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth, requireRole } from "../middleware/auth";
import { sendMail } from "../lib/mailer";
import { logAudit } from "../services/audit.service";

export const membersRouter = Router();
membersRouter.use(requireAuth);

/** Liste des membres actuels de l'organisation (transparence pour toute l'équipe). */
membersRouter.get("/", async (req, res) => {
  const memberships = await prisma.membership.findMany({
    where: { organizationId: req.auth!.organizationId },
    include: { user: { select: { id: true, fullName: true, email: true } } },
    orderBy: { createdAt: "asc" },
  });
  res.json(memberships);
});

/** Invitations en attente de l'organisation — réservé à l'Admin/Président. */
membersRouter.get("/invitations", requireRole("ADMIN"), async (req, res) => {
  const invitations = await prisma.invitation.findMany({
    where: { organizationId: req.auth!.organizationId, status: "EN_ATTENTE" },
    orderBy: { createdAt: "desc" },
  });
  res.json(invitations);
});

const inviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(["ADMIN", "CHEF_PROJET", "COMPTABLE", "LOGISTICIEN", "RH", "MEMBRE", "PARTENAIRE_EXTERNE", "BAILLEUR_LECTURE"]),
});

/**
 * Invite un collaborateur avec un rôle donné. Seul l'Admin/Président peut
 * inviter (cf. cahier des charges §2.1). Un email contenant le lien
 * d'acceptation est envoyé ; sans SMTP configuré, il est simulé et loggé.
 */
membersRouter.post("/invite", requireRole("ADMIN"), async (req, res) => {
  const parsed = inviteSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { email, role } = parsed.data;

  const existingMembership = await prisma.membership.findFirst({
    where: { organizationId: req.auth!.organizationId, user: { email } },
  });
  if (existingMembership) return res.status(409).json({ error: "Cette personne est déjà membre de l'organisation" });

  const organization = await prisma.organization.findUniqueOrThrow({ where: { id: req.auth!.organizationId } });

  const token = crypto.randomBytes(24).toString("hex");
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 jours

  const invitation = await prisma.invitation.create({
    data: { organizationId: organization.id, email, role, token, invitedById: req.auth!.userId, expiresAt },
  });

  const acceptUrl = `${process.env.PUBLIC_APP_URL ?? "https://app.exemple.org"}/accept-invite?token=${token}`;
  const mailResult = await sendMail({
    to: email,
    subject: `Invitation à rejoindre ${organization.name}`,
    text: `Bonjour,\n\nVous êtes invité(e) à rejoindre ${organization.name} sur la plateforme, avec le rôle "${role}".\n\nPour accepter l'invitation, ouvrez ce lien (valable 7 jours) :\n${acceptUrl}\n\nSi vous n'attendiez pas cette invitation, vous pouvez l'ignorer.`,
  });

  res.status(201).json({ invitation, acceptUrl, simulated: mailResult.simulated });
});

const createAccountSchema = z.object({
  email: z.string().email(),
  fullName: z.string().min(2),
  password: z.string().min(6),
  role: z.enum(["ADMIN", "CHEF_PROJET", "COMPTABLE", "LOGISTICIEN", "RH", "MEMBRE", "PARTENAIRE_EXTERNE", "BAILLEUR_LECTURE"]),
});

/**
 * Crée directement un compte utilisateur avec mot de passe et rôle choisis
 * par l'Admin — sans passer par le circuit d'invitation par email. Utile
 * quand l'Admin veut créer les comptes lui-même (ex. connectivité limitée
 * de l'employé, ou volonté de tout contrôler depuis le départ), plutôt que
 * de dépendre d'un email d'invitation à accepter. Seul l'Admin/Président
 * peut créer des comptes et choisir leur rôle.
 */
membersRouter.post("/create-account", requireRole("ADMIN"), async (req, res) => {
  const parsed = createAccountSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { email, fullName, password, role } = parsed.data;

  const existingUser = await prisma.user.findUnique({ where: { email } });
  if (existingUser) {
    const existingMembership = await prisma.membership.findFirst({
      where: { organizationId: req.auth!.organizationId, userId: existingUser.id },
    });
    if (existingMembership) return res.status(409).json({ error: "Cette personne est déjà membre de l'organisation" });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const user = existingUser ?? (await prisma.user.create({ data: { email, fullName, passwordHash } }));

  const membership = await prisma.membership.create({
    data: { userId: user.id, organizationId: req.auth!.organizationId, role },
    include: { user: { select: { id: true, fullName: true, email: true } } },
  });

  await logAudit({
    userId: req.auth!.userId,
    organizationId: req.auth!.organizationId,
    action: "CREATE_ACCOUNT",
    entity: "User",
    entityId: user.id,
    metadata: { email, role, createdBy: "admin_direct" },
  });

  res.status(201).json(membership);
});

membersRouter.delete("/invitations/:id", requireRole("ADMIN"), async (req, res) => {
  const invitation = await prisma.invitation.findFirst({
    where: { id: req.params.id, organizationId: req.auth!.organizationId },
  });
  if (!invitation) return res.status(404).json({ error: "Invitation introuvable" });

  await prisma.invitation.update({ where: { id: invitation.id }, data: { status: "REVOQUEE" } });
  res.status(204).send();
});

const roleUpdateSchema = z.object({
  role: z.enum(["ADMIN", "CHEF_PROJET", "COMPTABLE", "LOGISTICIEN", "RH", "MEMBRE", "PARTENAIRE_EXTERNE", "BAILLEUR_LECTURE"]),
});

/** Change le rôle d'un membre existant. Un Admin ne peut pas se rétrograder lui-même s'il est le seul Admin restant. */
membersRouter.patch("/:userId/role", requireRole("ADMIN"), async (req, res) => {
  const parsed = roleUpdateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const membership = await prisma.membership.findFirst({
    where: { userId: req.params.userId, organizationId: req.auth!.organizationId },
  });
  if (!membership) return res.status(404).json({ error: "Membre introuvable" });

  if (membership.userId === req.auth!.userId && membership.role === "ADMIN" && parsed.data.role !== "ADMIN") {
    const adminCount = await prisma.membership.count({
      where: { organizationId: req.auth!.organizationId, role: "ADMIN" },
    });
    if (adminCount <= 1) {
      return res.status(409).json({ error: "Impossible : vous êtes le dernier Admin de l'organisation" });
    }
  }

  const updated = await prisma.membership.update({ where: { id: membership.id }, data: { role: parsed.data.role } });
  await logAudit({
    userId: req.auth!.userId,
    organizationId: req.auth!.organizationId,
    action: "CHANGE_ROLE",
    entity: "Membership",
    entityId: membership.id,
    metadata: { targetUserId: membership.userId, oldRole: membership.role, newRole: parsed.data.role },
  });
  res.json(updated);
});

/** Retire un membre de l'organisation (même garde-fou sur le dernier Admin). */
membersRouter.delete("/:userId", requireRole("ADMIN"), async (req, res) => {
  const membership = await prisma.membership.findFirst({
    where: { userId: req.params.userId, organizationId: req.auth!.organizationId },
  });
  if (!membership) return res.status(404).json({ error: "Membre introuvable" });

  if (membership.role === "ADMIN") {
    const adminCount = await prisma.membership.count({
      where: { organizationId: req.auth!.organizationId, role: "ADMIN" },
    });
    if (adminCount <= 1) {
      return res.status(409).json({ error: "Impossible de retirer le dernier Admin de l'organisation" });
    }
  }

  await prisma.membership.delete({ where: { id: membership.id } });
  await logAudit({
    userId: req.auth!.userId,
    organizationId: req.auth!.organizationId,
    action: "REMOVE_MEMBER",
    entity: "Membership",
    entityId: membership.id,
    metadata: { targetUserId: membership.userId, role: membership.role },
  });
  res.status(204).send();
});

/**
 * Piste d'audit — historique complet des actions sensibles, réservé à
 * l'Admin/Président. Garantit la transparence et l'intégrité des données
 * exigée par les bailleurs (traçabilité de qui a fait quoi et quand).
 */
membersRouter.get("/audit-log", requireRole("ADMIN"), async (req, res) => {
  const logs = await prisma.auditLog.findMany({
    where: { organizationId: req.auth!.organizationId },
    orderBy: { timestamp: "desc" },
    take: 300,
  });
  res.json(logs);
});
