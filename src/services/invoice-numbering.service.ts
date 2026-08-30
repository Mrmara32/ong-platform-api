import { prisma } from "../lib/prisma";

/** Numérotation séquentielle simple par organisation : FAC-2026-0001, FAC-2026-0002, ... */
export async function nextInvoiceNumber(organizationId: string, year = new Date().getFullYear()) {
  const count = await prisma.invoice.count({
    where: { organizationId, number: { startsWith: `FAC-${year}-` } },
  });
  return `FAC-${year}-${String(count + 1).padStart(4, "0")}`;
}
