import { Router } from "express";
import crypto from "crypto";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth, requireRole } from "../middleware/auth";
import { sendMail } from "../lib/mailer";

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
  res.status(204).send();
});
