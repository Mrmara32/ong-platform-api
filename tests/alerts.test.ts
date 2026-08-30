import { describe, it, expect, vi } from "vitest";

// lib/prisma instancie un vrai PrismaClient au chargement du module, ce qui
// échoue sans `prisma generate` — on le mocke même si ces tests n'appellent
// aucune méthode Prisma, car l'import du service suffit à déclencher l'échec.
vi.mock("../src/lib/prisma", () => ({ prisma: {} }));
vi.mock("../src/lib/mailer", () => ({ sendMail: vi.fn() }));

import { urgencyFromDate, urgencyFromKm } from "../src/services/alerts.service";

describe("urgencyFromDate", () => {
  const now = new Date("2026-08-28T00:00:00Z");

  it("classe une échéance dépassée comme DEPASSEE", () => {
    expect(urgencyFromDate(new Date("2026-08-20T00:00:00Z"), now)).toBe("DEPASSEE");
  });

  it("classe une échéance dans 10 jours comme IMMINENTE (seuil 15 jours)", () => {
    expect(urgencyFromDate(new Date("2026-09-07T00:00:00Z"), now)).toBe("IMMINENTE");
  });

  it("classe une échéance exactement à 15 jours comme IMMINENTE (limite incluse)", () => {
    expect(urgencyFromDate(new Date("2026-09-12T00:00:00Z"), now)).toBe("IMMINENTE");
  });

  it("classe une échéance dans 30 jours comme A_VENIR", () => {
    expect(urgencyFromDate(new Date("2026-09-27T00:00:00Z"), now)).toBe("A_VENIR");
  });
});

describe("urgencyFromKm", () => {
  it("classe un kilométrage dépassé comme DEPASSEE", () => {
    expect(urgencyFromKm(-50)).toBe("DEPASSEE");
  });

  it("classe moins de 1000 km restants comme IMMINENTE", () => {
    expect(urgencyFromKm(500)).toBe("IMMINENTE");
  });

  it("classe exactement 1000 km restants comme IMMINENTE (limite incluse)", () => {
    expect(urgencyFromKm(1000)).toBe("IMMINENTE");
  });

  it("classe plus de 1000 km restants comme A_VENIR", () => {
    expect(urgencyFromKm(5000)).toBe("A_VENIR");
  });
});
