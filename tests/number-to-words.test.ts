import { describe, it, expect } from "vitest";
import { numberToFrenchWords, amountToFrenchWordsAdministrative } from "../src/services/number-to-words.service";

describe("numberToFrenchWords", () => {
  it("convertit zéro", () => {
    expect(numberToFrenchWords(0)).toBe("Zéro");
  });

  it("convertit les unités et dizaines simples", () => {
    expect(numberToFrenchWords(5)).toBe("Cinq");
    expect(numberToFrenchWords(17)).toBe("Dix-sept");
    expect(numberToFrenchWords(21)).toBe("Vingt et un");
  });

  it("gère la règle du 70-79 (soixante-dix...)", () => {
    expect(numberToFrenchWords(71)).toBe("Soixante et onze");
    expect(numberToFrenchWords(75)).toBe("Soixante-quinze");
  });

  it("gère la règle du 80 (quatre-vingts avec s, mais pas 81)", () => {
    expect(numberToFrenchWords(80)).toBe("Quatre-vingts");
    expect(numberToFrenchWords(81)).toBe("Quatre-vingt-un");
  });

  it("gère la règle du 90-99 (quatre-vingt-dix...)", () => {
    expect(numberToFrenchWords(95)).toBe("Quatre-vingt-quinze");
  });

  it("gère la règle du pluriel de cent (deux cents, mais deux cent trois)", () => {
    expect(numberToFrenchWords(200)).toBe("Deux cents");
    expect(numberToFrenchWords(203)).toBe("Deux cent trois");
    expect(numberToFrenchWords(100)).toBe("Cent");
  });

  it("convertit les milliers", () => {
    expect(numberToFrenchWords(1000)).toBe("Mille");
    expect(numberToFrenchWords(2000)).toBe("Deux mille");
  });

  it("convertit les millions", () => {
    expect(numberToFrenchWords(1_000_000)).toBe("Un million");
    expect(numberToFrenchWords(2_000_000)).toBe("Deux millions");
  });

  /**
   * Vérification contre le vrai document CAM/USAID fourni : la demande de
   * paiement n°2 mentionne exactement "Cent Trente Huit Millions Six Cent
   * Soixante Six Mille Francs Guinéens" pour 138 666 000 GNF.
   */
  it("reproduit le montant exact de la demande de paiement réelle du CAM", () => {
    expect(numberToFrenchWords(138_666_000)).toBe("Cent trente-huit millions six cent soixante-six mille");
  });
});

describe("amountToFrenchWordsAdministrative — format des documents bancaires/bailleurs", () => {
  it("reproduit exactement le libellé du document réel (sans tirets, chaque mot en majuscule)", () => {
    expect(amountToFrenchWordsAdministrative(138_666_000, "GNF")).toBe(
      "Cent Trente Huit Millions Six Cent Soixante Six Mille Francs Guinéens"
    );
  });

  it("fonctionne pour un montant en dollars", () => {
    expect(amountToFrenchWordsAdministrative(50_000, "USD")).toBe("Cinquante Mille Dollars Américains");
  });

  it("fonctionne pour un montant en euros", () => {
    expect(amountToFrenchWordsAdministrative(1_500, "EUR")).toBe("Mille Cinq Cents Euros");
  });
});
