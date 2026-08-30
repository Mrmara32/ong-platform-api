import { describe, it, expect, vi, beforeEach } from "vitest";

// On mocke entièrement lib/prisma AVANT l'import du service testé, pour que
// le vrai PrismaClient (qui exige `prisma generate`) ne soit jamais chargé.
// C'est ce qui permet de faire tourner ces tests sans base de données ni
// accès réseau — utile ici, mais aussi en CI pour des tests rapides.
// vi.mock est hoisté en haut du fichier : les mocks référencés à l'intérieur
// doivent donc être créés via vi.hoisted, sans quoi on obtient une
// ReferenceError ("Cannot access ... before initialization").
const { countMock } = vi.hoisted(() => ({ countMock: vi.fn() }));
vi.mock("../src/lib/prisma", () => ({
  prisma: { invoice: { count: countMock } },
}));

import { nextInvoiceNumber } from "../src/services/invoice-numbering.service";

describe("nextInvoiceNumber", () => {
  beforeEach(() => countMock.mockReset());

  it("produit le premier numéro de l'année quand aucune facture n'existe", async () => {
    countMock.mockResolvedValue(0);
    const number = await nextInvoiceNumber("org-1", 2026);
    expect(number).toBe("FAC-2026-0001");
    expect(countMock).toHaveBeenCalledWith({
      where: { organizationId: "org-1", number: { startsWith: "FAC-2026-" } },
    });
  });

  it("incrémente à partir du nombre de factures déjà émises cette année", async () => {
    countMock.mockResolvedValue(41);
    const number = await nextInvoiceNumber("org-1", 2026);
    expect(number).toBe("FAC-2026-0042");
  });

  it("isole la numérotation par organisation (la requête filtre sur organizationId)", async () => {
    countMock.mockResolvedValue(3);
    await nextInvoiceNumber("org-2", 2026);
    expect(countMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ organizationId: "org-2" }) })
    );
  });

  it("repart à 1 sur une nouvelle année (la numérotation est scannée par préfixe FAC-{année}-)", async () => {
    countMock.mockResolvedValue(0);
    const number = await nextInvoiceNumber("org-1", 2027);
    expect(number).toBe("FAC-2027-0001");
  });
});
