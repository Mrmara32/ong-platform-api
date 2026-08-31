import { prisma } from "../lib/prisma";

/**
 * Enregistre une action sensible dans la piste d'audit — historique complet
 * et non modifiable des changements effectués sur les données critiques
 * (comptes, rôles, validations financières, paramètres de l'organisation).
 * Le nom de l'utilisateur est capturé au moment de l'action (userName) pour
 * que l'historique reste lisible même si ce compte est supprimé plus tard.
 * N'échoue JAMAIS l'action métier en cours si la journalisation elle-même
 * rencontre un problème : l'audit ne doit jamais bloquer le travail.
 */
export async function logAudit(input: {
  userId: string;
  organizationId: string;
  action: string; // ex. "CREATE_ACCOUNT", "CHANGE_ROLE", "VALIDATE_ORDER"
  entity: string; // ex. "User", "PurchaseOrder", "Organization"
  entityId: string;
  metadata?: Record<string, unknown>;
}) {
  try {
    const user = await prisma.user.findUnique({ where: { id: input.userId }, select: { fullName: true } });

    await prisma.auditLog.create({
      data: {
        organizationId: input.organizationId,
        userId: input.userId,
        userName: user?.fullName ?? "Utilisateur inconnu",
        action: input.action,
        entity: input.entity,
        entityId: input.entityId,
        metadata: input.metadata as any,
      },
    });
  } catch (e) {
    // La journalisation ne doit jamais faire échouer l'action réelle.
    console.error("Échec de journalisation d'audit (action métier non affectée) :", e);
  }
}
