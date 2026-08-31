import { describe, it, expect, vi, beforeEach } from "vitest";

const { createMock, findUniqueMock } = vi.hoisted(() => ({
  createMock: vi.fn(),
  findUniqueMock: vi.fn(),
}));
vi.mock("../src/lib/prisma", () => ({
  prisma: { auditLog: { create: createMock }, user: { findUnique: findUniqueMock } },
}));

import { logAudit } from "../src/services/audit.service";

describe("logAudit — piste d'audit", () => {
  beforeEach(() => {
    createMock.mockReset();
    findUniqueMock.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("enregistre l'action avec le nom de l'utilisateur capturé au moment de l'action", async () => {
    findUniqueMock.mockResolvedValue({ fullName: "Boubacar Sylla" });
    createMock.mockResolvedValue({});

    await logAudit({
      userId: "user-1",
      organizationId: "org-1",
      action: "VALIDATE_ORDER",
      entity: "PurchaseOrder",
      entityId: "po-1",
      metadata: { amount: 500000 },
    });

    expect(createMock).toHaveBeenCalledWith({
      data: {
        organizationId: "org-1",
        userId: "user-1",
        userName: "Boubacar Sylla",
        action: "VALIDATE_ORDER",
        entity: "PurchaseOrder",
        entityId: "po-1",
        metadata: { amount: 500000 },
      },
    });
  });

  it("utilise un nom de repli si l'utilisateur n'est plus retrouvable", async () => {
    findUniqueMock.mockResolvedValue(null);
    createMock.mockResolvedValue({});

    await logAudit({ userId: "user-supprime", organizationId: "org-1", action: "TEST", entity: "Test", entityId: "1" });

    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ userName: "Utilisateur inconnu" }) })
    );
  });

  it("n'échoue jamais même si l'écriture en base échoue — l'audit ne doit jamais bloquer l'action métier", async () => {
    findUniqueMock.mockResolvedValue({ fullName: "Test" });
    createMock.mockRejectedValue(new Error("Connexion base perdue"));

    await expect(
      logAudit({ userId: "user-1", organizationId: "org-1", action: "TEST", entity: "Test", entityId: "1" })
    ).resolves.not.toThrow();
  });
});
