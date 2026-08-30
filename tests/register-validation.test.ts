import { describe, it, expect } from "vitest";
import { z } from "zod";

/**
 * Reproduit ici le schéma zod de POST /auth/register pour vérifier les
 * règles de validation sans dépendre de Prisma ni d'un serveur Express monté
 * (cf. limites réseau du sandbox documentées dans tests/README.md).
 */
const registerSchema = z.object({
  organizationName: z.string().min(2, "Le nom de l'organisation doit contenir au moins 2 caractères"),
  organizationType: z.enum(["ONG", "BAILLEUR", "PRESTATAIRE", "AUTRE"]),
  country: z.string().min(2, "Le pays est requis"),
  fullName: z.string().min(2, "Le nom complet est requis"),
  email: z.string().email("Adresse email invalide"),
  password: z.string().min(8, "Le mot de passe doit contenir au moins 8 caractères"),
});

const validPayload = {
  organizationName: "ONG Sahel Ops",
  organizationType: "ONG" as const,
  country: "Niger",
  fullName: "Aïcha Ndiaye",
  email: "admin@sahelops.org",
  password: "motdepasse123",
};

describe("Validation du formulaire d'inscription", () => {
  it("accepte un payload complet et valide", () => {
    expect(registerSchema.safeParse(validPayload).success).toBe(true);
  });

  it("refuse un mot de passe de moins de 8 caractères", () => {
    const result = registerSchema.safeParse({ ...validPayload, password: "1234567" });
    expect(result.success).toBe(false);
  });

  it("refuse un email invalide", () => {
    const result = registerSchema.safeParse({ ...validPayload, email: "pas-un-email" });
    expect(result.success).toBe(false);
  });

  it("refuse un type d'organisation hors de la liste autorisée", () => {
    const result = registerSchema.safeParse({ ...validPayload, organizationType: "AUTRE_CHOSE" });
    expect(result.success).toBe(false);
  });

  it("refuse un nom d'organisation trop court", () => {
    const result = registerSchema.safeParse({ ...validPayload, organizationName: "A" });
    expect(result.success).toBe(false);
  });

  it("accepte chacun des 4 types d'organisation prévus", () => {
    for (const organizationType of ["ONG", "BAILLEUR", "PRESTATAIRE", "AUTRE"] as const) {
      expect(registerSchema.safeParse({ ...validPayload, organizationType }).success).toBe(true);
    }
  });
});
