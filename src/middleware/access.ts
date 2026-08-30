import { prisma } from "../lib/prisma";
import { AuthPayload } from "./auth";

export interface ProjectAccess {
  canAccess: boolean;
  scope: "COMPLET" | "PERSONNEL";
  isOrgAdmin: boolean;
}

/**
 * Détermine la portée d'accès d'un utilisateur sur un projet donné
 * (cf. cahier des charges §2.1.1) :
 * - L'Admin/Président de l'organisation a TOUJOURS un accès complet,
 *   sans avoir besoin d'un ProjectMembership explicite.
 * - Le Chef de projet organisationnel (role CHEF_PROJET) qui est aussi
 *   RESPONSABLE de ce projet précis a un accès complet.
 * - Tout autre utilisateur suit la portée définie par son ProjectMembership
 *   (COMPLET ou PERSONNEL) ; s'il n'a aucun ProjectMembership sur ce projet,
 *   il n'a pas accès du tout.
 */
export async function resolveProjectAccess(auth: AuthPayload, projectId: string): Promise<ProjectAccess> {
  if (auth.role === "ADMIN") {
    return { canAccess: true, scope: "COMPLET", isOrgAdmin: true };
  }

  const membership = await prisma.projectMembership.findUnique({
    where: { userId_projectId: { userId: auth.userId, projectId } },
  });

  if (!membership) {
    return { canAccess: false, scope: "PERSONNEL", isOrgAdmin: false };
  }

  const scope = membership.role === "RESPONSABLE" ? "COMPLET" : membership.scope;
  return { canAccess: true, scope, isOrgAdmin: false };
}

/**
 * Construit la clause Prisma "where" additionnelle à appliquer à une requête
 * pour respecter la portée d'accès : en PERSONNEL, ne retourne que les
 * enregistrements liés à l'utilisateur (via le champ fourni : ownerId,
 * createdById, authorId...).
 */
export function personalScopeFilter(access: ProjectAccess, userId: string, field: string) {
  if (access.scope === "COMPLET") return {};
  return { [field]: userId };
}
