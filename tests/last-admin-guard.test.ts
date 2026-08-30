import { describe, it, expect, vi, beforeEach } from "vitest";

const { countMock } = vi.hoisted(() => ({ countMock: vi.fn() }));

/**
 * Reproduit la règle métier de members.routes.ts : un Admin ne peut pas être
 * rétrogradé ou retiré s'il est le dernier Admin de l'organisation. On teste
 * la fonction de décision isolément plutôt que la route Express complète
 * (qui nécessite Prisma généré, cf. tests/README.md).
 */
async function wouldRemoveLastAdmin(prismaCount: () => Promise<number>): Promise<boolean> {
  const adminCount = await prismaCount();
  return adminCount <= 1;
}

describe("Garde-fou du dernier Admin", () => {
  beforeEach(() => countMock.mockReset());

  it("bloque le retrait quand il ne reste qu'un seul Admin", async () => {
    countMock.mockResolvedValue(1);
    expect(await wouldRemoveLastAdmin(countMock)).toBe(true);
  });

  it("autorise le retrait quand il reste au moins 2 Admins", async () => {
    countMock.mockResolvedValue(2);
    expect(await wouldRemoveLastAdmin(countMock)).toBe(false);
  });

  it("bloque aussi dans le cas dégénéré à 0 (donnée incohérente, on reste prudent)", async () => {
    countMock.mockResolvedValue(0);
    expect(await wouldRemoveLastAdmin(countMock)).toBe(true);
  });
});
