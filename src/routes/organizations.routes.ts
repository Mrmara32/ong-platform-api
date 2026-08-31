import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth, requireRole } from "../middleware/auth";

export const organizationsRouter = Router();
organizationsRouter.use(requireAuth);

/** Informations de l'organisation active de l'utilisateur connecté. */
organizationsRouter.get("/me", async (req, res) => {
  const organization = await prisma.organization.findUniqueOrThrow({
    where: { id: req.auth!.organizationId },
    include: { _count: { select: { projects: true, users: true, vehicles: true } } },
  });
  res.json(organization);
});

const updateSchema = z.object({
  name: z.string().min(2).optional(),
  type: z.enum(["ONG", "BAILLEUR", "PRESTATAIRE", "AUTRE"]).optional(),
  country: z.string().min(2).optional(),
  address: z.string().optional(),
  registrationNumber: z.string().optional(),
  taxId: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().email().optional().or(z.literal("")),
  website: z.string().optional(),
  bankName: z.string().optional(),
  bankAddress: z.string().optional(),
  bankAccountNumber: z.string().optional(),
  logoUrl: z.string().optional(), // URL hébergée ou data URL base64 (logo léger, pas d'upload de fichier volumineux)
});

/** Met à jour les informations de l'organisation — réservé à l'Admin/Président. */
organizationsRouter.patch("/me", requireRole("ADMIN"), async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  if (Object.keys(parsed.data).length === 0) return res.status(400).json({ error: "Aucun champ à mettre à jour" });

  const updated = await prisma.organization.update({
    where: { id: req.auth!.organizationId },
    data: parsed.data,
  });
  res.json(updated);
});

// -------- Comptes bancaires (multi-comptes, multi-banques) --------

organizationsRouter.get("/bank-accounts", async (req, res) => {
  const accounts = await prisma.bankAccount.findMany({
    where: { organizationId: req.auth!.organizationId },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
  });
  res.json(accounts);
});

const bankAccountSchema = z.object({
  label: z.string().min(2),
  bankName: z.string().min(1),
  bankAddress: z.string().optional(),
  accountNumber: z.string().min(1),
  currency: z.enum(["GNF", "USD", "EUR"]).default("GNF"),
  isDefault: z.boolean().optional(),
});

organizationsRouter.post("/bank-accounts", requireRole("ADMIN"), async (req, res) => {
  const parsed = bankAccountSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  if (parsed.data.isDefault) {
    await prisma.bankAccount.updateMany({
      where: { organizationId: req.auth!.organizationId },
      data: { isDefault: false },
    });
  }

  const account = await prisma.bankAccount.create({
    data: { ...parsed.data, organizationId: req.auth!.organizationId },
  });
  res.status(201).json(account);
});

organizationsRouter.delete("/bank-accounts/:id", requireRole("ADMIN"), async (req, res) => {
  const account = await prisma.bankAccount.findFirst({
    where: { id: req.params.id, organizationId: req.auth!.organizationId },
  });
  if (!account) return res.status(404).json({ error: "Compte bancaire introuvable" });

  await prisma.bankAccount.delete({ where: { id: account.id } });
  res.status(204).send();
});

// -------- Bailleurs (répertoire au niveau organisation) --------

organizationsRouter.get("/donors", async (req, res) => {
  const donors = await prisma.donor.findMany({
    where: { organizationId: req.auth!.organizationId },
    orderBy: { name: "asc" },
  });
  res.json(donors);
});

const donorSchema = z.object({
  name: z.string().min(2),
  contactName: z.string().optional(),
  contactEmail: z.string().email().optional(),
  contactPhone: z.string().optional(),
});

organizationsRouter.post("/donors", requireRole("ADMIN", "CHEF_PROJET"), async (req, res) => {
  const parsed = donorSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const donor = await prisma.donor.create({ data: { ...parsed.data, organizationId: req.auth!.organizationId } });
  res.status(201).json(donor);
});
