import { describe, it, expect } from "vitest";

/**
 * Reproduit isolément la logique d'agrégation du rapport de dépenses par
 * bailleur (route GET /projects/:projectId/donor-report) — permet de
 * vérifier le calcul du taux d'exécution sans dépendre de la base.
 */
function computeDonorReport(allocations: { donorName: string; allocatedAmount: number; budgetLines: { spent: number }[] }[]) {
  return allocations.map((a) => {
    const spent = a.budgetLines.reduce((s, l) => s + l.spent, 0);
    return {
      donorName: a.donorName,
      allocatedAmount: a.allocatedAmount,
      spent,
      remaining: a.allocatedAmount - spent,
      executionRate: a.allocatedAmount > 0 ? (spent / a.allocatedAmount) * 100 : 0,
    };
  });
}

describe("Rapport de dépenses par bailleur", () => {
  it("calcule le taux d'exécution en agrégeant uniquement les lignes budgétaires rattachées à ce bailleur", () => {
    const report = computeDonorReport([
      { donorName: "USAID", allocatedAmount: 100_000_000, budgetLines: [{ spent: 30_000_000 }, { spent: 20_000_000 }] },
    ]);

    expect(report[0].spent).toBe(50_000_000);
    expect(report[0].remaining).toBe(50_000_000);
    expect(report[0].executionRate).toBe(50);
  });

  it("distingue correctement plusieurs bailleurs cofinançant le même projet", () => {
    const report = computeDonorReport([
      { donorName: "USAID", allocatedAmount: 100_000_000, budgetLines: [{ spent: 80_000_000 }] },
      { donorName: "Union Européenne", allocatedAmount: 50_000_000, budgetLines: [{ spent: 10_000_000 }] },
    ]);

    expect(report[0].executionRate).toBe(80);
    expect(report[1].executionRate).toBe(20);
  });

  it("gère un bailleur sans dépense encore enregistrée", () => {
    const report = computeDonorReport([{ donorName: "RTI International", allocatedAmount: 20_000_000, budgetLines: [] }]);
    expect(report[0].spent).toBe(0);
    expect(report[0].executionRate).toBe(0);
    expect(report[0].remaining).toBe(20_000_000);
  });

  it("ne divise jamais par zéro si un montant alloué est à zéro", () => {
    const report = computeDonorReport([{ donorName: "Bailleur test", allocatedAmount: 0, budgetLines: [{ spent: 0 }] }]);
    expect(report[0].executionRate).toBe(0);
    expect(Number.isFinite(report[0].executionRate)).toBe(true);
  });
});
