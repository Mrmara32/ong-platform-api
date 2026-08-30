import { describe, it, expect, vi, beforeEach } from "vitest";

const { findUniqueMock } = vi.hoisted(() => ({ findUniqueMock: vi.fn() }));
vi.mock("../src/lib/prisma", () => ({
  prisma: { projectMembership: { findUnique: findUniqueMock } },
}));

import { resolveProjectAccess, personalScopeFilter } from "../src/middleware/access";

describe("resolveProjectAccess", () => {
  beforeEach(() => findUniqueMock.mockReset());

  it("donne toujours un accès COMPLET au Président/Admin, sans ProjectMembership", async () => {
    const access = await resolveProjectAccess({ userId: "u1", organizationId: "org1", role: "ADMIN" }, "proj1");
    expect(access).toEqual({ canAccess: true, scope: "COMPLET", isOrgAdmin: true });
    // L'Admin ne doit même pas déclencher de requête sur ProjectMembership.
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  it("refuse l'accès si l'utilisateur n'a aucun ProjectMembership sur ce projet", async () => {
    findUniqueMock.mockResolvedValue(null);
    const access = await resolveProjectAccess({ userId: "u2", organizationId: "org1", role: "MEMBRE" }, "proj1");
    expect(access.canAccess).toBe(false);
  });

  it("donne un accès COMPLET à un RESPONSABLE de projet même si sa portée enregistrée est PERSONNEL", async () => {
    findUniqueMock.mockResolvedValue({ role: "RESPONSABLE", scope: "PERSONNEL" });
    const access = await resolveProjectAccess({ userId: "u3", organizationId: "org1", role: "CHEF_PROJET" }, "proj1");
    expect(access.scope).toBe("COMPLET");
  });

  it("respecte la portée PERSONNEL pour un simple Membre", async () => {
    findUniqueMock.mockResolvedValue({ role: "MEMBRE", scope: "PERSONNEL" });
    const access = await resolveProjectAccess({ userId: "u4", organizationId: "org1", role: "MEMBRE" }, "proj1");
    expect(access).toEqual({ canAccess: true, scope: "PERSONNEL", isOrgAdmin: false });
  });

  it("respecte une portée COMPLET explicitement accordée à un Membre", async () => {
    findUniqueMock.mockResolvedValue({ role: "MEMBRE", scope: "COMPLET" });
    const access = await resolveProjectAccess({ userId: "u5", organizationId: "org1", role: "MEMBRE" }, "proj1");
    expect(access.scope).toBe("COMPLET");
  });
});

describe("personalScopeFilter", () => {
  it("ne filtre rien en portée COMPLET", () => {
    const filter = personalScopeFilter({ canAccess: true, scope: "COMPLET", isOrgAdmin: true }, "u1", "ownerId");
    expect(filter).toEqual({});
  });

  it("filtre sur l'utilisateur courant en portée PERSONNEL", () => {
    const filter = personalScopeFilter({ canAccess: true, scope: "PERSONNEL", isOrgAdmin: false }, "u1", "ownerId");
    expect(filter).toEqual({ ownerId: "u1" });
  });

  it("s'adapte au nom du champ fourni (createdById, authorId, ...)", () => {
    const filter = personalScopeFilter({ canAccess: true, scope: "PERSONNEL", isOrgAdmin: false }, "u1", "createdById");
    expect(filter).toEqual({ createdById: "u1" });
  });
});
