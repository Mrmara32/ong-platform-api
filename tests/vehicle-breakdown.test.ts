import { describe, it, expect, vi, beforeEach } from "vitest";

const { findFirstOrThrowMock, updateVehicleMock, createNotificationMock, findManyMembershipMock, findManyProjectMembershipMock, sendMailMock } = vi.hoisted(() => ({
  findFirstOrThrowMock: vi.fn(),
  updateVehicleMock: vi.fn(),
  createNotificationMock: vi.fn((args: any) => Promise.resolve({ id: "notif-1", ...args.data })),
  findManyMembershipMock: vi.fn(),
  findManyProjectMembershipMock: vi.fn(),
  sendMailMock: vi.fn(() => Promise.resolve({ simulated: true })),
}));

vi.mock("../src/lib/prisma", () => ({
  prisma: {
    vehicle: { findFirstOrThrow: findFirstOrThrowMock, update: updateVehicleMock },
    notification: { create: createNotificationMock },
    membership: { findMany: findManyMembershipMock },
    projectMembership: { findMany: findManyProjectMembershipMock },
  },
}));
vi.mock("../src/lib/mailer", () => ({ sendMail: sendMailMock }));

import { reportVehicleBreakdown } from "../src/services/alerts.service";

describe("reportVehicleBreakdown", () => {
  beforeEach(() => {
    findFirstOrThrowMock.mockReset();
    updateVehicleMock.mockReset();
    createNotificationMock.mockClear();
    findManyMembershipMock.mockReset();
    findManyProjectMembershipMock.mockReset();
    sendMailMock.mockClear();
  });

  it("bascule le véhicule en HORS_SERVICE", async () => {
    findFirstOrThrowMock.mockResolvedValue({
      id: "V1", brand: "Toyota", model: "Hilux", plateNumber: "NG-1",
      assignments: [{ project: { id: "P1", name: "Projet Résilience" } }],
    });
    findManyProjectMembershipMock.mockResolvedValue([]);
    findManyMembershipMock.mockResolvedValue([]);

    await reportVehicleBreakdown({ organizationId: "org1", vehicleId: "V1", description: "Moteur en panne" });

    expect(updateVehicleMock).toHaveBeenCalledWith({ where: { id: "V1" }, data: { status: "HORS_SERVICE" } });
  });

  it("crée une notification PANNE_VEHICULE par projet affecté, avec le bon projectId", async () => {
    findFirstOrThrowMock.mockResolvedValue({
      id: "V1", brand: "Toyota", model: "Hilux", plateNumber: "NG-1",
      assignments: [
        { project: { id: "P1", name: "Projet A" } },
        { project: { id: "P2", name: "Projet B" } },
      ],
    });
    findManyProjectMembershipMock.mockResolvedValue([]);
    findManyMembershipMock.mockResolvedValue([]);

    await reportVehicleBreakdown({ organizationId: "org1", vehicleId: "V1", description: "Panne" });

    expect(createNotificationMock).toHaveBeenCalledTimes(2);
    const projectIds = createNotificationMock.mock.calls.map((c: any) => c[0].data.projectId);
    expect(projectIds.sort()).toEqual(["P1", "P2"]);
    createNotificationMock.mock.calls.forEach((c: any) => {
      expect(c[0].data.type).toBe("PANNE_VEHICULE");
      expect(c[0].data.urgency).toBe("DEPASSEE");
    });
  });

  it("notifie le responsable de chaque projet affecté (ProjectMembership RESPONSABLE)", async () => {
    findFirstOrThrowMock.mockResolvedValue({
      id: "V1", brand: "Toyota", model: "Hilux", plateNumber: "NG-1",
      assignments: [{ project: { id: "P1", name: "Projet A" } }],
    });
    findManyProjectMembershipMock.mockResolvedValue([{ user: { email: "responsable@ong.org" } }]);
    findManyMembershipMock.mockResolvedValue([{ user: { email: "logisticien@ong.org" } }]);

    const result = await reportVehicleBreakdown({ organizationId: "org1", vehicleId: "V1", description: "Panne" });

    expect(result.recipients).toEqual(expect.arrayContaining(["responsable@ong.org", "logisticien@ong.org"]));
    expect(sendMailMock).toHaveBeenCalledTimes(2);
  });

  it("dédoublonne les destinataires si le responsable de projet est aussi Logisticien", async () => {
    findFirstOrThrowMock.mockResolvedValue({
      id: "V1", brand: "Toyota", model: "Hilux", plateNumber: "NG-1",
      assignments: [{ project: { id: "P1", name: "Projet A" } }],
    });
    findManyProjectMembershipMock.mockResolvedValue([{ user: { email: "meme@ong.org" } }]);
    findManyMembershipMock.mockResolvedValue([{ user: { email: "meme@ong.org" } }]);

    const result = await reportVehicleBreakdown({ organizationId: "org1", vehicleId: "V1", description: "Panne" });

    expect(result.recipients).toEqual(["meme@ong.org"]);
    expect(sendMailMock).toHaveBeenCalledTimes(1);
  });

  it("notifie quand même l'organisation si le véhicule n'est affecté à aucun projet", async () => {
    findFirstOrThrowMock.mockResolvedValue({
      id: "V1", brand: "Toyota", model: "Hilux", plateNumber: "NG-1",
      assignments: [],
    });
    findManyProjectMembershipMock.mockResolvedValue([]);
    findManyMembershipMock.mockResolvedValue([{ user: { email: "admin@ong.org" } }]);

    const result = await reportVehicleBreakdown({ organizationId: "org1", vehicleId: "V1", description: "Panne" });

    expect(createNotificationMock).toHaveBeenCalledTimes(1);
    expect(createNotificationMock.mock.calls[0][0].data.projectId).toBeUndefined();
    expect(result.recipients).toEqual(["admin@ong.org"]);
  });
});
