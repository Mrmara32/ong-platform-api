import { describe, it, expect, vi } from "vitest";

vi.mock("../src/lib/prisma", () => ({ prisma: {} }));
vi.mock("../src/lib/mailer", () => ({ sendMail: vi.fn() }));

import { validateDoubleEntry } from "../src/services/accounting.service";

describe("validateDoubleEntry — garde-fou de la partie double", () => {
  it("accepte une écriture simple équilibrée à deux lignes", () => {
    const result = validateDoubleEntry([
      { accountCode: "681", accountLabel: "Dotations aux amortissements", debit: 100000 },
      { accountCode: "281", accountLabel: "Amortissements", credit: 100000 },
    ]);
    expect(result.valid).toBe(true);
    expect(result.totalDebit).toBe(100000);
    expect(result.totalCredit).toBe(100000);
  });

  it("accepte une écriture à plusieurs lignes tant que le total s'équilibre", () => {
    const result = validateDoubleEntry([
      { accountCode: "60", accountLabel: "Achats", debit: 60000 },
      { accountCode: "61", accountLabel: "Services extérieurs", debit: 40000 },
      { accountCode: "521", accountLabel: "Banque", credit: 100000 },
    ]);
    expect(result.valid).toBe(true);
  });

  it("rejette une écriture à une seule ligne", () => {
    const result = validateDoubleEntry([{ accountCode: "60", accountLabel: "Achats", debit: 1000 }]);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/au moins deux lignes/);
  });

  it("rejette une écriture déséquilibrée", () => {
    const result = validateDoubleEntry([
      { accountCode: "60", accountLabel: "Achats", debit: 1000 },
      { accountCode: "521", accountLabel: "Banque", credit: 900 },
    ]);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/déséquilibrée/);
  });

  it("rejette une ligne débitée ET créditée simultanément", () => {
    const result = validateDoubleEntry([
      { accountCode: "60", accountLabel: "Achats", debit: 500, credit: 500 },
      { accountCode: "521", accountLabel: "Banque", credit: 500 },
    ]);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/à la fois débitée et créditée/);
  });

  it("rejette une ligne sans aucun montant", () => {
    const result = validateDoubleEntry([
      { accountCode: "60", accountLabel: "Achats", debit: 0, credit: 0 },
      { accountCode: "521", accountLabel: "Banque", credit: 500 },
    ]);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/montant au débit ou au crédit/);
  });

  it("tolère un écart d'arrondi négligeable (moins d'un centime)", () => {
    const result = validateDoubleEntry([
      { accountCode: "60", accountLabel: "Achats", debit: 1000.005 },
      { accountCode: "521", accountLabel: "Banque", credit: 1000 },
    ]);
    expect(result.valid).toBe(true);
  });
});
