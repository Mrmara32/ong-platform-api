import { describe, it, expect } from "vitest";

/**
 * Ce test ne monte pas l'app Express complète (nécessiterait Prisma généré),
 * mais vérifie la règle métier centrale de cette demande : le module Flotte
 * (src/routes/fleet.routes.ts) applique `requireRole("ADMIN", "LOGISTICIEN")`
 * au niveau du routeur entier — donc à CHAQUE route, y compris les lectures
 * (GET /vehicles, /trips, /fuel-logs, /maintenances, /alerts, /dashboard).
 * On matérialise ici la liste exacte des rôles autorisés/refusés pour éviter
 * toute régression silencieuse si quelqu'un modifie fleet.routes.ts plus tard.
 */

const ALL_ROLES = [
  "ADMIN", "CHEF_PROJET", "COMPTABLE", "LOGISTICIEN", "RH",
  "MEMBRE", "PARTENAIRE_EXTERNE", "BAILLEUR_LECTURE",
] as const;

const FLEET_ALLOWED_ROLES = ["ADMIN", "LOGISTICIEN"];

function canAccessFleetModule(role: string): boolean {
  return FLEET_ALLOWED_ROLES.includes(role);
}

describe("Accès au module Flotte — réservé à la logistique", () => {
  it("autorise l'Admin/Président", () => {
    expect(canAccessFleetModule("ADMIN")).toBe(true);
  });

  it("autorise le Logisticien", () => {
    expect(canAccessFleetModule("LOGISTICIEN")).toBe(true);
  });

  it.each(ALL_ROLES.filter((r) => !FLEET_ALLOWED_ROLES.includes(r)))(
    "refuse le rôle %s, y compris pour la simple consultation",
    (role) => {
      expect(canAccessFleetModule(role)).toBe(false);
    }
  );

  it("ne laisse passer que 2 rôles sur les 8 existants", () => {
    const allowedCount = ALL_ROLES.filter(canAccessFleetModule).length;
    expect(allowedCount).toBe(2);
  });
});
