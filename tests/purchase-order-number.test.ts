import { describe, it, expect, vi, beforeEach } from "vitest";

const { findUniqueOrThrowMock, countMock } = vi.hoisted(() => ({
  findUniqueOrThrowMock: vi.fn(),
  countMock: vi.fn(),
}));

vi.mock("../src/lib/prisma", () => ({
  prisma: {
    purchaseOrder: { findUniqueOrThrow: findUniqueOrThrowMock, count: countMock },
  },
}));

import { purchaseOrderNumber } from "../src/services/invoice-numbering.service";

describe("purchaseOrderNumber", () => {
  beforeEach(() => {
    findUniqueOrThrowMock.mockReset();
    countMock.mockReset();
  });

  it("génère BC-<année>-0001 pour la toute première commande de l'année", async () => {
    findUniqueOrThrowMock.mockResolvedValue({ id: "po-1", createdAt: new Date("2026-03-15") });
    countMock.mockResolvedValue(0);

    const number = await purchaseOrderNumber("org-1", "po-1");

    expect(number).toBe("BC-2026-0001");
  });

  it("incrémente le numéro selon le nombre de commandes déjà créées avant celle-ci dans l'année", async () => {
    findUniqueOrThrowMock.mockResolvedValue({ id: "po-9", createdAt: new Date("2026-06-01") });
    countMock.mockResolvedValue(41);

    const number = await purchaseOrderNumber("org-1", "po-9");

    expect(number).toBe("BC-2026-0042");
  });

  it("repart de zéro pour une nouvelle année civile", async () => {
    findUniqueOrThrowMock.mockResolvedValue({ id: "po-1", createdAt: new Date("2027-01-05") });
    countMock.mockResolvedValue(0);

    const number = await purchaseOrderNumber("org-1", "po-1");

    expect(number).toBe("BC-2027-0001");
  });
});
