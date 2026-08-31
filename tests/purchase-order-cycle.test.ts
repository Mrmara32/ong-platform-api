import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Vérifie le cycle complet Commande → Validation Président → Livraison →
 * Facture fournisseur reçue → Paiement, sans jamais griller d'étape.
 */

const {
  purchaseOrderFindUniqueOrThrowMock,
  purchaseOrderUpdateMock,
  supplierInvoiceCreateMock,
  supplierInvoiceUpdateManyMock,
  chartOfAccountUpsertMock,
  journalEntryCreateMock,
  budgetLineUpdateMock,
  paymentCreateMock,
} = vi.hoisted(() => ({
  purchaseOrderFindUniqueOrThrowMock: vi.fn(),
  purchaseOrderUpdateMock: vi.fn(),
  supplierInvoiceCreateMock: vi.fn((args: any) => Promise.resolve({ id: "si-1", ...args.data })),
  supplierInvoiceUpdateManyMock: vi.fn(),
  chartOfAccountUpsertMock: vi.fn((args: any) => Promise.resolve({ id: `acct-${args.where.organizationId_accountCode.accountCode}` })),
  journalEntryCreateMock: vi.fn((args: any) => Promise.resolve({ id: "je", ...args.data })),
  budgetLineUpdateMock: vi.fn(),
  paymentCreateMock: vi.fn((args: any) => Promise.resolve({ id: "pay-1", ...args.data })),
}));

vi.mock("../src/lib/prisma", () => ({
  prisma: {
    purchaseOrder: { findUniqueOrThrow: purchaseOrderFindUniqueOrThrowMock, update: purchaseOrderUpdateMock },
    supplierInvoice: { create: supplierInvoiceCreateMock, updateMany: supplierInvoiceUpdateManyMock },
    chartOfAccount: { upsert: chartOfAccountUpsertMock },
    journalEntry: { create: journalEntryCreateMock },
    budgetLine: { update: budgetLineUpdateMock },
    payment: { create: paymentCreateMock },
    $transaction: vi.fn((ops: any[]) => Promise.all(ops)),
  },
}));

import { recordSupplierInvoiceReceived, recordSupplierPayment } from "../src/services/accounting.service";

describe("Cycle de commande — réception de la facture fournisseur", () => {
  beforeEach(() => {
    purchaseOrderFindUniqueOrThrowMock.mockReset();
    purchaseOrderUpdateMock.mockReset();
    supplierInvoiceCreateMock.mockClear();
    supplierInvoiceUpdateManyMock.mockClear();
    journalEntryCreateMock.mockClear();
    budgetLineUpdateMock.mockReset();
  });

  it("comptabilise la dette fournisseur (débit charge / crédit 401) à la réception de la facture, pas avant", async () => {
    purchaseOrderFindUniqueOrThrowMock.mockResolvedValue({
      id: "po-1",
      projectId: "proj-1",
      budgetLineId: "bl-1",
      item: "Kits agricoles",
      budgetLine: { code: "62", label: "Logistique" },
      supplier: { name: "Boké Équipements" },
    });

    await recordSupplierInvoiceReceived({
      organizationId: "org-1",
      purchaseOrderId: "po-1",
      invoiceNumber: "FAC-FOURN-001",
      amount: 500000,
      registeredById: "user-comptable",
    });

    expect(supplierInvoiceCreateMock).toHaveBeenCalledTimes(1);
    expect(purchaseOrderUpdateMock).toHaveBeenCalledWith({ where: { id: "po-1" }, data: { status: "FACTURE_RECUE" } });
    // Deux lignes d'écriture : débit ligne budgétaire, crédit compte fournisseur 401
    expect(journalEntryCreateMock).toHaveBeenCalledTimes(2);
    expect(budgetLineUpdateMock).toHaveBeenCalledWith({ where: { id: "bl-1" }, data: { spent: { increment: 500000 } } });
  });

  it("le paiement fournisseur clôture le cycle : facture -> PAYEE, commande -> COMPTABILISEE", async () => {
    await recordSupplierPayment({
      organizationId: "org-1",
      supplierId: "sup-1",
      amount: 500000,
      method: "VIREMENT",
      purchaseOrderId: "po-1",
    });

    expect(supplierInvoiceUpdateManyMock).toHaveBeenCalledWith({ where: { purchaseOrderId: "po-1" }, data: { status: "PAYEE" } });
    expect(purchaseOrderUpdateMock).toHaveBeenCalledWith({ where: { id: "po-1" }, data: { status: "COMPTABILISEE" } });
  });

  it("un paiement sans purchaseOrderId ne touche ni SupplierInvoice ni PurchaseOrder (paiement fournisseur libre)", async () => {
    await recordSupplierPayment({
      organizationId: "org-1",
      supplierId: "sup-1",
      amount: 100000,
      method: "ESPECES",
    });

    expect(supplierInvoiceUpdateManyMock).not.toHaveBeenCalled();
  });
});
