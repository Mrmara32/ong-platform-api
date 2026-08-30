import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { signToken } from "../middleware/auth";

export const authRouter = Router();

const registerSchema = z.object({
  organizationName: z.string().min(2, "Le nom de l'organisation doit contenir au moins 2 caractères"),
  organizationType: z.enum(["ONG", "BAILLEUR", "PRESTATAIRE", "AUTRE"]),
  country: z.string().min(2, "Le pays est requis"),
  fullName: z.string().min(2, "Le nom complet est requis"),
  email: z.string().email("Adresse email invalide"),
  password: z.string().min(8, "Le mot de passe doit contenir au moins 8 caractères"),
});

/**
 * Inscription d'une nouvelle organisation (ONG, bailleur, prestataire...) et
 * de son premier utilisateur, automatiquement Admin/Président de cette
 * organisation (cf. cahier des charges §2.1). C'est le seul moyen de créer
 * une organisation sur la plateforme — toute personne supplémentaire est
 * ensuite invitée par cet Admin depuis l'application.
 */
authRouter.post("/register", async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { organizationName, organizationType, country, fullName, email, password } = parsed.data;

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return res.status(409).json({ error: "Un compte existe déjà avec cet email" });

  const passwordHash = await bcrypt.hash(password, 10);

  const { organization, user, membership } = await prisma.$transaction(async (tx) => {
    const organization = await tx.organization.create({
      data: { name: organizationName, type: organizationType, country },
    });
    const user = await tx.user.create({
      data: { email, fullName, passwordHash },
    });
    const membership = await tx.membership.create({
      data: { userId: user.id, organizationId: organization.id, role: "ADMIN" },
    });
    return { organization, user, membership };
  });

  const token = signToken({ userId: user.id, organizationId: organization.id, role: membership.role });
  res.status(201).json({ token, organization: organization.name, role: membership.role });
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  organizationId: z.string().uuid().optional(), // si l'utilisateur appartient à plusieurs ONG
});

/**
 * Connexion. Si l'utilisateur appartient à plusieurs organisations et n'a pas
 * précisé laquelle, on renvoie la liste pour qu'il choisisse — le token émis
 * porte toujours une seule organisation active (isolation multi-tenant).
 */
authRouter.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { email, password, organizationId } = parsed.data;
  const user = await prisma.user.findUnique({
    where: { email },
    include: { memberships: { include: { organization: true } } },
  });
  if (!user) return res.status(401).json({ error: "Identifiants invalides" });

  const validPassword = await bcrypt.compare(password, user.passwordHash);
  if (!validPassword) return res.status(401).json({ error: "Identifiants invalides" });

  if (user.memberships.length === 0) {
    return res.status(403).json({ error: "Aucune organisation associée à ce compte" });
  }

  const membership = organizationId
    ? user.memberships.find((m) => m.organizationId === organizationId)
    : user.memberships[0];

  if (!membership) {
    if (!organizationId) {
      return res.status(200).json({
        needsOrganizationChoice: true,
        organizations: user.memberships.map((m) => ({ id: m.organizationId, name: m.organization.name, role: m.role })),
      });
    }
    return res.status(403).json({ error: "Utilisateur non membre de cette organisation" });
  }

  if (user.memberships.length > 1 && !organizationId) {
    return res.status(200).json({
      needsOrganizationChoice: true,
      organizations: user.memberships.map((m) => ({ id: m.organizationId, name: m.organization.name, role: m.role })),
    });
  }

  const token = signToken({ userId: user.id, organizationId: membership.organizationId, role: membership.role });
  res.json({ token, organization: membership.organization.name, role: membership.role });
});

/**
 * Consultation publique d'une invitation (avant acceptation) — permet à
 * l'écran d'acceptation d'afficher l'organisation et le rôle proposés sans
 * exposer d'information sensible.
 */
authRouter.get("/invitations/:token", async (req, res) => {
  const invitation = await prisma.invitation.findUnique({
    where: { token: req.params.token },
    include: { organization: true },
  });
  if (!invitation || invitation.status !== "EN_ATTENTE") {
    return res.status(404).json({ error: "Invitation introuvable ou déjà traitée" });
  }
  if (invitation.expiresAt < new Date()) {
    await prisma.invitation.update({ where: { id: invitation.id }, data: { status: "EXPIREE" } });
    return res.status(410).json({ error: "Cette invitation a expiré" });
  }

  const existingUser = await prisma.user.findUnique({ where: { email: invitation.email } });

  res.json({
    email: invitation.email,
    role: invitation.role,
    organizationName: invitation.organization.name,
    accountAlreadyExists: Boolean(existingUser),
  });
});

const acceptInvitationSchema = z.object({
  fullName: z.string().min(2).optional(), // requis seulement si le compte n'existe pas encore
  password: z.string().min(1), // pour un compte existant : mot de passe de vérification ; sinon : mot de passe à créer (min 8, validé plus bas)
});

/**
 * Accepte une invitation : si l'email correspond à un compte existant, le
 * mot de passe sert à en vérifier la propriété avant de rattacher
 * l'organisation ; sinon, un nouveau compte est créé avec ce mot de passe.
 * Dans les deux cas, une session (token) est ouverte directement sur la
 * nouvelle organisation, comme après une inscription classique.
 */
authRouter.post("/invitations/:token/accept", async (req, res) => {
  const invitation = await prisma.invitation.findUnique({ where: { token: req.params.token } });
  if (!invitation || invitation.status !== "EN_ATTENTE") {
    return res.status(404).json({ error: "Invitation introuvable ou déjà traitée" });
  }
  if (invitation.expiresAt < new Date()) {
    await prisma.invitation.update({ where: { id: invitation.id }, data: { status: "EXPIREE" } });
    return res.status(410).json({ error: "Cette invitation a expiré" });
  }

  const parsed = acceptInvitationSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { fullName, password } = parsed.data;

  let user = await prisma.user.findUnique({ where: { email: invitation.email } });

  if (user) {
    const validPassword = await bcrypt.compare(password, user.passwordHash);
    if (!validPassword) return res.status(401).json({ error: "Mot de passe incorrect pour ce compte existant" });
  } else {
    if (!fullName) return res.status(400).json({ error: "Le nom complet est requis pour créer votre compte" });
    if (password.length < 8) return res.status(400).json({ error: "Le mot de passe doit contenir au moins 8 caractères" });
    const passwordHash = await bcrypt.hash(password, 10);
    user = await prisma.user.create({ data: { email: invitation.email, fullName, passwordHash } });
  }

  const membership = await prisma.membership.upsert({
    where: { userId_organizationId: { userId: user.id, organizationId: invitation.organizationId } },
    update: { role: invitation.role },
    create: { userId: user.id, organizationId: invitation.organizationId, role: invitation.role },
  });

  await prisma.invitation.update({ where: { id: invitation.id }, data: { status: "ACCEPTEE" } });

  const jwtToken = signToken({ userId: user.id, organizationId: invitation.organizationId, role: membership.role });
  const organization = await prisma.organization.findUniqueOrThrow({ where: { id: invitation.organizationId } });
  res.json({ token: jwtToken, organization: organization.name, role: membership.role });
});
