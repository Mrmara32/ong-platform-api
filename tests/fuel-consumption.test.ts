import { describe, it, expect, vi, beforeEach } from "vitest";

const { findManyMock } = vi.hoisted(() => ({ findManyMock: vi.fn() }));
vi.mock("../src/lib/prisma", () => ({
  prisma: { fuelLog: { findMany: findManyMock } },
}));

import { computeFuelConsumption } from "../src/services/fuel.service";

function log(id: string, mileage: number, liters: number, date = "2026-01-01") {
  return { id, mileage, liters, date: new Date(date) };
}

describe("computeFuelConsumption", () => {
  beforeEach(() => findManyMock.mockReset());

  it("renvoie null pour le tout premier plein (pas de kilométrage de référence)", async () => {
    findManyMock.mockResolvedValue([log("F1", 10000, 40)]);
    const result = await computeFuelConsumption("V1");
    expect(result[0].litersPer100Km).toBeNull();
    expect(result[0].isAnomaly).toBe(false);
  });

  it("calcule correctement la consommation en L/100km entre deux pleins", async () => {
    findManyMock.mockResolvedValue([
      log("F1", 10000, 40),
      log("F2", 10500, 40),
    ]);
    const result = await computeFuelConsumption("V1");
    const f2 = result.find((r) => r.fuelLogId === "F2");
    expect(f2!.litersPer100Km).toBeCloseTo(8, 5);
  });

  it("ne signale pas d'anomalie avec un historique insuffisant (moins de 2 pleins exploitables)", async () => {
    findManyMock.mockResolvedValue([
      log("F1", 10000, 40),
      log("F2", 10500, 80),
    ]);
    const result = await computeFuelConsumption("V1");
    const f2 = result.find((r) => r.fuelLogId === "F2");
    expect(f2!.isAnomaly).toBe(false);
  });

  it("signale une anomalie quand la consommation dépasse 130% de la moyenne historique", async () => {
    findManyMock.mockResolvedValue([
      log("F1", 10000, 40),
      log("F2", 10500, 40),
      log("F3", 11000, 40),
      log("F4", 11500, 80),
    ]);
    const result = await computeFuelConsumption("V1");
    const f4 = result.find((r) => r.fuelLogId === "F4");
    expect(f4!.litersPer100Km).toBeCloseTo(16, 5);
    expect(f4!.isAnomaly).toBe(true);
  });

  it("ne signale pas d'anomalie pour une consommation stable et cohérente", async () => {
    findManyMock.mockResolvedValue([
      log("F1", 10000, 40),
      log("F2", 10500, 41),
      log("F3", 11000, 39),
      log("F4", 11500, 40),
    ]);
    const result = await computeFuelConsumption("V1");
    const f4 = result.find((r) => r.fuelLogId === "F4");
    expect(f4!.isAnomaly).toBe(false);
  });

  it("retourne les points du plus récent au plus ancien", async () => {
    findManyMock.mockResolvedValue([log("F1", 10000, 40), log("F2", 10500, 40)]);
    const result = await computeFuelConsumption("V1");
    expect(result[0].fuelLogId).toBe("F2");
    expect(result[1].fuelLogId).toBe("F1");
  });
});
