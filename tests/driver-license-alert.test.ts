import { describe, it, expect, vi, beforeEach } from "vitest";

const { vehicleFindManyMock, assetFindManyMock, driverFindManyMock } = vi.hoisted(() => ({
  vehicleFindManyMock: vi.fn(),
  assetFindManyMock: vi.fn(),
  driverFindManyMock: vi.fn(),
}));

vi.mock("../src/lib/prisma", () => ({
  prisma: {
    vehicle: { findMany: vehicleFindManyMock },
    asset: { findMany: assetFindManyMock },
    driver: { findMany: driverFindManyMock },
  },
}));
vi.mock("../src/lib/mailer", () => ({ sendMail: vi.fn() }));

import { computeAlerts } from "../src/services/alerts.service";

const NOW = new Date("2026-08-28T00:00:00Z");

describe("computeAlerts — échéance du permis de conduire", () => {
  beforeEach(() => {
    vehicleFindManyMock.mockReset().mockResolvedValue([]);
    assetFindManyMock.mockReset().mockResolvedValue([]);
    driverFindManyMock.mockReset();
  });

  it("ne remonte aucune alerte pour un permis valide encore loin de l'échéance", async () => {
    driverFindManyMock.mockResolvedValue([
      { id: "D1", licenseExpiryDate: new Date("2027-06-01"), staff: { fullName: "Moussa Traoré" } },
    ]);
    const alerts = await computeAlerts("org1", NOW);
    expect(alerts).toHaveLength(0);
  });

  it("remonte une alerte IMMINENTE pour un permis expirant dans moins de 15 jours", async () => {
    driverFindManyMock.mockResolvedValue([
      { id: "D1", licenseExpiryDate: new Date("2026-09-05T00:00:00Z"), staff: { fullName: "Moussa Traoré" } },
    ]);
    const alerts = await computeAlerts("org1", NOW);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].urgency).toBe("IMMINENTE");
    expect(alerts[0].resourceType).toBe("Driver");
    expect(alerts[0].message).toContain("Moussa Traoré");
  });

  it("remonte une alerte DEPASSEE pour un permis déjà expiré", async () => {
    driverFindManyMock.mockResolvedValue([
      { id: "D1", licenseExpiryDate: new Date("2026-08-01T00:00:00Z"), staff: { fullName: "Moussa Traoré" } },
    ]);
    const alerts = await computeAlerts("org1", NOW);
    expect(alerts[0].urgency).toBe("DEPASSEE");
    expect(alerts[0].message).toContain("expiré");
  });

  it("traite chaque chauffeur indépendamment", async () => {
    driverFindManyMock.mockResolvedValue([
      { id: "D1", licenseExpiryDate: new Date("2027-06-01"), staff: { fullName: "Chauffeur OK" } },
      { id: "D2", licenseExpiryDate: new Date("2026-08-01"), staff: { fullName: "Chauffeur expiré" } },
    ]);
    const alerts = await computeAlerts("org1", NOW);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].message).toContain("Chauffeur expiré");
  });
});
