import { describe, it, expect, vi, beforeEach } from "vitest";

const { findUniqueOrThrowMock } = vi.hoisted(() => ({ findUniqueOrThrowMock: vi.fn() }));
vi.mock("../src/lib/prisma", () => ({
  prisma: {
    budgetLine: { findUniqueOrThrow: findUniqueOrThrowMock },
    chartOfAccount: { upsert: vi.fn() },
    journalEntry: { create: vi.fn() },
    $transaction: vi.fn(async (ops: any[]) => Promise.all(ops)),
  },
}));

import { checkBudgetLineAvailability } from "../src/services/accounting.service";

describe("checkBudgetLineAvailability", () => {
  beforeEach(() => findUniqueOrThrowMock.mockReset());

  it("calcule un disponible positif quand le montant reste dans le budget", async () => {
    findUniqueOrThrowMock.mockResolvedValue({ id: "L1", allocated: "1000000", spent: "300000", code: "61", label: "Personnel" });
    const result = await checkBudgetLineAvailability("L1", 200000);
    expect(result.remaining).toBe(700000);
    expect(result.remainingAfter).toBe(500000);
    expect(result.exceeds).toBe(false);
  });

  it("détecte un dépassement sans bloquer le calcul (la décision reste métier)", async () => {
    findUniqueOrThrowMock.mockResolvedValue({ id: "L1", allocated: "1000000", spent: "900000", code: "61", label: "Personnel" });
    const result = await checkBudgetLineAvailability("L1", 200000);
    expect(result.remaining).toBe(100000);
    expect(result.remainingAfter).toBe(-100000);
    expect(result.exceeds).toBe(true);
  });

  it("traite un montant exactement égal au disponible comme non dépassant", async () => {
    findUniqueOrThrowMock.mockResolvedValue({ id: "L1", allocated: "500000", spent: "300000", code: "61", label: "Personnel" });
    const result = await checkBudgetLineAvailability("L1", 200000);
    expect(result.remainingAfter).toBe(0);
    expect(result.exceeds).toBe(false);
  });
});
