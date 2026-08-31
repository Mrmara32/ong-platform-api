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
