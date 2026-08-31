import { prisma } from "../lib/prisma";

/** Numérotation séquentielle simple par organisation : FAC-2026-0001, FAC-2026-0002, ... */
export async function nextInvoiceNumber(organizationId: string, year = new Date().getFullYear()) {
  const count = await prisma.invoice.count({
    where: { organizationId, number: { startsWith: `FAC-${year}-` } },
  });
  return `FAC-${year}-${String(count + 1).padStart(4, "0")}`;
}

/**
 * Numéro de bon de commande — dérivé de l'ordre de création dans l'année,
 * calculé à la demande (au moment de l'impression) plutôt que stocké : la
 * commande existe déjà en base avec un id, ce numéro n'est qu'un habillage
 * lisible pour le document imprimé (BC-2026-0001, BC-2026-0002...).
 */
export async function purchaseOrderNumber(organizationId: string, purchaseOrderId: string) {
  const order = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: purchaseOrderId } });
  const year = order.createdAt.getFullYear();
  const earlierCount = await prisma.purchaseOrder.count({
    where: {
      project: { organizationId },
      createdAt: { gte: new Date(`${year}-01-01`), lt: order.createdAt },
    },
  });
  return `BC-${year}-${String(earlierCount + 1).padStart(4, "0")}`;
}
