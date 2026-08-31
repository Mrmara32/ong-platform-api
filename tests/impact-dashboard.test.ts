import { describe, it, expect } from "vitest";

/**
 * Reproduit isolément la logique de cumul du tableau de bord d'impact
 * (route GET /projects/:id/impact-dashboard) — la seule vraie logique
 * métier de ce module, testée sans dépendre de la base de données.
 */
function computeTimeline(updates: { date: Date; beneficiariesReached: number | null; activityTitle: string; note: string }[]) {
  let cumulative = 0;
  const timeline = updates.map((u) => {
    cumulative += u.beneficiariesReached ?? 0;
    return { ...u, cumulativeBeneficiaries: cumulative };
  });
  return { totalBeneficiaries: cumulative, totalUpdates: updates.length, timeline };
}

describe("Tableau de bord d'impact — cumul des bénéficiaires", () => {
  it("cumule correctement les bénéficiaires touchés dans l'ordre chronologique", () => {
    const result = computeTimeline([
      { date: new Date("2026-01-01"), beneficiariesReached: 100, activityTitle: "VAD", note: "Première tournée" },
      { date: new Date("2026-01-15"), beneficiariesReached: 150, activityTitle: "VAD", note: "Deuxième tournée" },
      { date: new Date("2026-02-01"), beneficiariesReached: 80, activityTitle: "Causerie", note: "Sensibilisation" },
    ]);

    expect(result.totalBeneficiaries).toBe(330);
    expect(result.timeline[0].cumulativeBeneficiaries).toBe(100);
    expect(result.timeline[1].cumulativeBeneficiaries).toBe(250);
    expect(result.timeline[2].cumulativeBeneficiaries).toBe(330);
  });

  it("ignore les mises à jour sans bénéficiaires renseignés (traité comme 0)", () => {
    const result = computeTimeline([
      { date: new Date("2026-01-01"), beneficiariesReached: 50, activityTitle: "VAD", note: "Tournée" },
      { date: new Date("2026-01-10"), beneficiariesReached: null, activityTitle: "VAD", note: "Observation sans chiffre" },
    ]);

    expect(result.totalBeneficiaries).toBe(50);
    expect(result.timeline[1].cumulativeBeneficiaries).toBe(50);
  });

  it("renvoie zéro pour un projet sans aucune remontée terrain", () => {
    const result = computeTimeline([]);
    expect(result.totalBeneficiaries).toBe(0);
    expect(result.totalUpdates).toBe(0);
    expect(result.timeline).toEqual([]);
  });
});
