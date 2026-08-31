import crypto from "crypto";
import { prisma } from "../lib/prisma";
import { JournalSource, SyncStatus, PaymentMethod } from "@prisma/client";

/**
 * Ce service centralise TOUTE écriture comptable générée automatiquement par
 * la plateforme (dépense, décaissement, livraison, plein de carburant,
 * maintenance...). Aucune autre partie du code ne doit écrire directement
 * dans JournalEntry ou modifier BudgetLine.spent — cela garantit que le
 * plan comptable SYCEBNL et les lignes budgétaires restent toujours
 * synchronisés, quel que soit le module d'origine.
 */

interface PostEntryParams {
  organizationId: string;
  projectId?: string;
  budgetLineId?: string;
  chargeAccountCode: string; // compte à débiter (classe 6 en général)
  chargeAccountLabel: string;
  counterpartAccountCode: string; // compte à créditer (classe 5 trésorerie ou classe 4 tiers)
  counterpartAccountLabel: string;
  counterpartClassNumber: number;
  amount: number;
  label: string;
  sourceType: JournalSource;
  sourceId?: string;
  syncStatus?: SyncStatus;
}

// Récupère un compte du plan comptable de l'organisation, ou le crée s'il n'existe pas encore
async function getOrCreateAccount(organizationId: string, accountCode: string, label: string) {
  const classNumber = parseInt(accountCode[0], 10);
  return prisma.chartOfAccount.upsert({
    where: { organizationId_accountCode: { organizationId, accountCode } },
    update: {},
    create: { organizationId, accountCode, label, classNumber },
  });
}

/**
 * Poste une écriture comptable en partie double simplifiée :
 * une ligne au débit du compte de charge, une ligne au crédit de la contrepartie.
 * Les deux lignes partagent le même sourceType/sourceId pour rester traçables.
 */
export async function postJournalEntry(params: PostEntryParams) {
  const {
    organizationId, projectId, budgetLineId,
    chargeAccountCode, chargeAccountLabel,
    counterpartAccountCode, counterpartAccountLabel,
    amount, label, sourceType, sourceId,
    syncStatus = "SYNCED",
  } = params;

  const chargeAccount = await getOrCreateAccount(organizationId, chargeAccountCode, chargeAccountLabel);
  const counterpartAccount = await getOrCreateAccount(organizationId, counterpartAccountCode, counterpartAccountLabel);

  return prisma.$transaction([
    prisma.journalEntry.create({
      data: {
        accountId: chargeAccount.id,
        projectId,
        budgetLineId,
        debit: amount,
        credit: 0,
        label,
        sourceType,
        sourceId,
        syncStatus,
      },
    }),
    prisma.journalEntry.create({
      data: {
        accountId: counterpartAccount.id,
        projectId,
        budgetLineId,
        debit: 0,
        credit: amount,
        label,
        sourceType,
        sourceId,
        syncStatus,
      },
    }),
  ]);
}

/**
 * Vérifie le disponible d'une ligne budgétaire avant un mouvement financier.
 * Ne bloque pas le dépassement (une dérogation métier peut être nécessaire)
 * mais renvoie l'information pour que l'appelant décide (alerte, validation
 * manuelle, etc.), conformément au cahier des charges.
 */
export async function checkBudgetLineAvailability(budgetLineId: string, amount: number) {
  const line = await prisma.budgetLine.findUniqueOrThrow({ where: { id: budgetLineId } });
  const remaining = Number(line.allocated) - Number(line.spent);
  return { line, remaining, remainingAfter: remaining - amount, exceeds: remaining - amount < 0 };
}

/** Incrémente le "spent" d'une ligne budgétaire — appelé uniquement depuis ce service. */
async function increaseBudgetLineSpent(budgetLineId: string, amount: number) {
  return prisma.budgetLine.update({
    where: { id: budgetLineId },
    data: { spent: { increment: amount } },
  });
}

// ---------------------------------------------------------------------------
// Cas d'usage métier — un par type d'événement générant une écriture
// ---------------------------------------------------------------------------

export async function recordExpense(input: {
  organizationId: string;
  projectId: string;
  budgetLineId: string;
  label: string;
  amount: number;
  syncStatus?: SyncStatus;
}) {
  const { organizationId, projectId, budgetLineId, label, amount, syncStatus } = input;
  const availability = await checkBudgetLineAvailability(budgetLineId, amount);
  const line = availability.line;

  const expense = await prisma.expense.create({
    data: { budgetLineId, label, amount, status: "DECAISSE", syncStatus: syncStatus ?? "SYNCED" },
  });

  await postJournalEntry({
    organizationId,
    projectId,
    budgetLineId,
    chargeAccountCode: line.code,
    chargeAccountLabel: line.label,
    counterpartAccountCode: "521",
    counterpartAccountLabel: "Banque",
    counterpartClassNumber: 5,
    amount,
    label: `Dépense — ${label}`,
    sourceType: "DEPENSE",
    sourceId: expense.id,
    syncStatus,
  });

  await increaseBudgetLineSpent(budgetLineId, amount);

  return { expense, ...availability };
}

export async function recordDisbursement(input: {
  organizationId: string;
  projectId: string;
  budgetLineId: string;
  amount: number;
  method: string;
  syncStatus?: SyncStatus;
}) {
  const { organizationId, projectId, budgetLineId, amount, method, syncStatus } = input;
  const availability = await checkBudgetLineAvailability(budgetLineId, amount);
  const line = availability.line;

  const disbursement = await prisma.disbursement.create({
    data: { budgetLineId, amount, method, syncStatus: syncStatus ?? "SYNCED" },
  });

  await postJournalEntry({
    organizationId,
    projectId,
    budgetLineId,
    chargeAccountCode: line.code,
    chargeAccountLabel: line.label,
    counterpartAccountCode: "521",
    counterpartAccountLabel: "Banque",
    counterpartClassNumber: 5,
    amount,
    label: `Décaissement (${method})`,
    sourceType: "DECAISSEMENT",
    sourceId: disbursement.id,
    syncStatus,
  });

  await increaseBudgetLineSpent(budgetLineId, amount);

  return { disbursement, ...availability };
}

/** Déclenché lors de la confirmation de livraison d'une commande (module Logistique). */
/**
 * Confirme la RÉCEPTION PHYSIQUE d'une commande validée (bon de livraison +
 * marchandise reçus). Purement opérationnel — aucune écriture comptable ici :
 * la dette envers le fournisseur n'est légalement constatée qu'à réception
 * de sa facture (voir recordSupplierInvoiceReceived), conformément au cycle
 * Commande → Validation Président → Livraison → Facture reçue → Paiement.
 */
export async function recordPurchaseOrderDelivery(purchaseOrderId: string, deliveryNoteRef?: string) {
  return prisma.purchaseOrder.update({
    where: { id: purchaseOrderId },
    data: { status: "LIVREE", deliveredAt: new Date(), deliveryNoteRef },
  });
}

/**
 * Enregistre la facture fournisseur reçue pour une commande livrée — c'est
 * CE moment, et lui seul, qui comptabilise la dette (débit charge / crédit
 * compte fournisseur 401) et impute la dépense sur la ligne budgétaire.
 * Rôle réservé au Comptable (cf. cahier des charges) : c'est lui qui reçoit
 * matériellement la facture papier et la rapproche de la commande.
 */
export async function recordSupplierInvoiceReceived(input: {
  organizationId: string;
  purchaseOrderId: string;
  invoiceNumber: string;
  amount: number;
  registeredById?: string;
}) {
  const { organizationId, purchaseOrderId, invoiceNumber, amount, registeredById } = input;
  const order = await prisma.purchaseOrder.findUniqueOrThrow({
    where: { id: purchaseOrderId },
    include: { budgetLine: true, supplier: true },
  });

  const supplierInvoice = await prisma.supplierInvoice.create({
    data: { purchaseOrderId, invoiceNumber, amount, registeredById },
  });

  await prisma.purchaseOrder.update({ where: { id: purchaseOrderId }, data: { status: "FACTURE_RECUE" } });

  await postJournalEntry({
    organizationId,
    projectId: order.projectId,
    budgetLineId: order.budgetLineId,
    chargeAccountCode: order.budgetLine.code,
    chargeAccountLabel: order.budgetLine.label,
    counterpartAccountCode: "401",
    counterpartAccountLabel: `Fournisseur — ${order.supplier.name}`,
    counterpartClassNumber: 4,
    amount,
    label: `Facture fournisseur ${invoiceNumber} — ${order.item}`,
    sourceType: "LIVRAISON",
    sourceId: order.id,
  });

  await increaseBudgetLineSpent(order.budgetLineId, amount);

  return supplierInvoice;
}

/** Déclenché à l'enregistrement d'un plein de carburant (module Logistique). */
export async function recordFuelExpense(input: {
  organizationId: string;
  projectId: string;
  budgetLineId: string;
  vehiclePlate: string;
  amount: number;
  syncStatus?: SyncStatus;
}) {
  const { organizationId, projectId, budgetLineId, vehiclePlate, amount, syncStatus } = input;
  const line = await prisma.budgetLine.findUniqueOrThrow({ where: { id: budgetLineId } });

  await postJournalEntry({
    organizationId,
    projectId,
    budgetLineId,
    chargeAccountCode: line.code,
    chargeAccountLabel: line.label,
    counterpartAccountCode: "521",
    counterpartAccountLabel: "Banque",
    counterpartClassNumber: 5,
    amount,
    label: `Carburant — ${vehiclePlate}`,
    sourceType: "DEPENSE",
    syncStatus,
  });

  await increaseBudgetLineSpent(budgetLineId, amount);
}

/** Déclenché à l'enregistrement d'une intervention de maintenance (module Logistique). */
export async function recordMaintenanceExpense(input: {
  organizationId: string;
  projectId: string;
  budgetLineId: string;
  vehiclePlate: string;
  amount: number;
  provider?: string;
}) {
  const { organizationId, projectId, budgetLineId, vehiclePlate, amount, provider } = input;
  const line = await prisma.budgetLine.findUniqueOrThrow({ where: { id: budgetLineId } });

  await postJournalEntry({
    organizationId,
    projectId,
    budgetLineId,
    chargeAccountCode: line.code,
    chargeAccountLabel: line.label,
    counterpartAccountCode: "521",
    counterpartAccountLabel: "Banque",
    counterpartClassNumber: 5,
    amount,
    label: `Maintenance — ${vehiclePlate}${provider ? ` (${provider})` : ""}`,
    sourceType: "DEPENSE",
  });

  await increaseBudgetLineSpent(budgetLineId, amount);
}

// ---------------------------------------------------------------------------
// Paiements multicanal (virement, mobile money, espèces, chèque)
// ---------------------------------------------------------------------------

// Le compte de trésorerie SYCEBNL varie selon le canal utilisé : la banque (521)
// pour les virements, un sous-compte dédié par opérateur de mobile money pour
// les autres, ce qui permet le rapprochement propre à chaque canal.
const TREASURY_ACCOUNT_BY_METHOD: Record<PaymentMethod, { code: string; label: string }> = {
  VIREMENT: { code: "521", label: "Banque" },
  ORANGE_MONEY: { code: "5711", label: "Mobile money — Orange Money" },
  MTN_MONEY: { code: "5712", label: "Mobile money — MTN Money" },
  MOOV_MONEY: { code: "5713", label: "Mobile money — Moov Money" },
  WAVE: { code: "5714", label: "Mobile money — Wave" },
  ESPECES: { code: "571", label: "Caisse" },
  CHEQUE: { code: "522", label: "Banque — chèques à encaisser" },
};

/**
 * Paiement sortant vers un fournisseur/prestataire (règlement d'une commande
 * déjà comptabilisée, ou paiement direct d'une prestation). Génère l'écriture
 * de trésorerie correspondant au canal choisi et trace la référence de
 * transaction (n° mobile money, référence de virement...).
 */
export async function recordSupplierPayment(input: {
  organizationId: string;
  projectId?: string;
  budgetLineId?: string;
  supplierId: string;
  amount: number;
  method: PaymentMethod;
  reference?: string;
  purchaseOrderId?: string; // si fourni, clôture le cycle : facture fournisseur -> payée, commande -> comptabilisée
}) {
  const { organizationId, projectId, budgetLineId, supplierId, amount, method, reference, purchaseOrderId } = input;
  const treasury = TREASURY_ACCOUNT_BY_METHOD[method];

  const payment = await prisma.payment.create({
    data: {
      organizationId,
      projectId,
      budgetLineId,
      supplierId,
      direction: "SORTANT",
      method,
      amount,
      reference,
      status: "CONFIRME",
    },
  });

  // Solde le compte fournisseur (401, débité) par la trésorerie (créditée)
  await postJournalEntry({
    organizationId,
    projectId,
    budgetLineId,
    chargeAccountCode: "401",
    chargeAccountLabel: "Fournisseurs",
    counterpartAccountCode: treasury.code,
    counterpartAccountLabel: treasury.label,
    counterpartClassNumber: parseInt(treasury.code[0], 10),
    amount,
    label: `Paiement fournisseur (${method}${reference ? ` — ${reference}` : ""})`,
    sourceType: "DECAISSEMENT",
    sourceId: payment.id,
  });

  if (purchaseOrderId) {
    await prisma.supplierInvoice.updateMany({ where: { purchaseOrderId }, data: { status: "PAYEE" } });
    await prisma.purchaseOrder.update({ where: { id: purchaseOrderId }, data: { status: "COMPTABILISEE" } });
  }

  return payment;
}

/** Encaissement d'une facture émise par l'organisation (produit, classe 7). */
export async function recordInvoicePayment(input: {
  organizationId: string;
  invoiceId: string;
  amount: number;
  method: PaymentMethod;
  reference?: string;
}) {
  const { organizationId, invoiceId, amount, method, reference } = input;
  const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
  const treasury = TREASURY_ACCOUNT_BY_METHOD[method];

  const payment = await prisma.payment.create({
    data: {
      organizationId,
      projectId: invoice.projectId ?? undefined,
      invoiceId,
      direction: "ENTRANT",
      method,
      amount,
      reference,
      status: "CONFIRME",
    },
  });

  // Débit trésorerie / crédit compte de produits (classe 7)
  await postJournalEntry({
    organizationId,
    projectId: invoice.projectId ?? undefined,
    chargeAccountCode: treasury.code,
    chargeAccountLabel: treasury.label,
    counterpartAccountCode: "706",
    counterpartAccountLabel: "Prestations de services facturées",
    counterpartClassNumber: 7,
    amount,
    label: `Encaissement facture ${invoice.number} (${method})`,
    sourceType: "MANUEL",
    sourceId: payment.id,
  });

  await prisma.invoice.update({ where: { id: invoiceId }, data: { status: "PAYEE" } });

  return payment;
}

/**
 * Paiement du salaire net d'un bulletin de paie, quel que soit le canal.
 * Génère l'écriture de charges de personnel imputée à la ligne budgétaire
 * "Personnel" du projet indiqué.
 */
export async function recordPayslipPayment(input: {
  organizationId: string;
  projectId: string;
  budgetLineId: string;
  payslipId: string;
  staffId: string;
  amount: number;
  method: PaymentMethod;
  reference?: string;
}) {
  const { organizationId, projectId, budgetLineId, payslipId, staffId, amount, method, reference } = input;
  const line = await prisma.budgetLine.findUniqueOrThrow({ where: { id: budgetLineId } });
  const treasury = TREASURY_ACCOUNT_BY_METHOD[method];

  const payment = await prisma.payment.create({
    data: {
      organizationId,
      projectId,
      budgetLineId,
      staffId,
      payslipId,
      direction: "SORTANT",
      method,
      amount,
      reference,
      status: "CONFIRME",
    },
  });

  await postJournalEntry({
    organizationId,
    projectId,
    budgetLineId,
    chargeAccountCode: line.code,
    chargeAccountLabel: line.label,
    counterpartAccountCode: treasury.code,
    counterpartAccountLabel: treasury.label,
    counterpartClassNumber: parseInt(treasury.code[0], 10),
    amount,
    label: `Paie (${method}${reference ? ` — ${reference}` : ""})`,
    sourceType: "DECAISSEMENT",
    sourceId: payment.id,
  });

  await increaseBudgetLineSpent(budgetLineId, amount);
  await prisma.payslip.update({ where: { id: payslipId }, data: { status: "PAYE" } });

  return payment;
}

/**
 * Comptabilise une intervention sur un matériel divers (PC, imprimante,
 * groupe électrogène...) — maintenance préventive/curative ou renouvellement
 * d'une licence (ex. antivirus). Même logique que recordMaintenanceExpense
 * pour les véhicules, appliquée au registre générique Asset.
 */
export async function recordAssetMaintenanceExpense(input: {
  organizationId: string;
  projectId?: string;
  budgetLineId?: string;
  assetName: string;
  amount: number;
  description?: string;
}) {
  const { organizationId, projectId, budgetLineId, assetName, amount, description } = input;

  if (!budgetLineId) {
    // Pas de ligne budgétaire associée (ex. matériel non affecté à un projet) :
    // pas d'écriture comptable projet, la dépense reste à la charge du siège.
    return;
  }

  const line = await prisma.budgetLine.findUniqueOrThrow({ where: { id: budgetLineId } });

  await postJournalEntry({
    organizationId,
    projectId,
    budgetLineId,
    chargeAccountCode: line.code,
    chargeAccountLabel: line.label,
    counterpartAccountCode: "521",
    counterpartAccountLabel: "Banque",
    counterpartClassNumber: 5,
    amount,
    label: `Maintenance matériel — ${assetName}${description ? ` (${description})` : ""}`,
    sourceType: "DEPENSE",
  });

  await increaseBudgetLineSpent(budgetLineId, amount);
}

// ---------------------------------------------------------------------------
// Écriture comptable manuelle (saisie libre par le Comptable)
// ---------------------------------------------------------------------------

export interface ManualEntryLine {
  accountCode: string;
  accountLabel: string;
  debit?: number;
  credit?: number;
}

/**
 * Vérifie qu'une écriture manuelle respecte la partie double : au moins deux
 * lignes, chaque ligne mouvementée d'un seul côté (débit OU crédit, jamais
 * les deux), et total débit = total crédit. Fonction pure, testée isolément
 * — c'est la seule garde-fou avant d'écrire quoi que ce soit en base.
 */
export function validateDoubleEntry(lines: ManualEntryLine[]): { valid: boolean; error?: string; totalDebit: number; totalCredit: number } {
  if (lines.length < 2) {
    return { valid: false, error: "Une écriture doit comporter au moins deux lignes", totalDebit: 0, totalCredit: 0 };
  }
  for (const line of lines) {
    const debit = line.debit ?? 0;
    const credit = line.credit ?? 0;
    if (debit > 0 && credit > 0) {
      return { valid: false, error: `La ligne "${line.accountLabel}" ne peut pas être à la fois débitée et créditée`, totalDebit: 0, totalCredit: 0 };
    }
    if (debit === 0 && credit === 0) {
      return { valid: false, error: `La ligne "${line.accountLabel}" doit avoir un montant au débit ou au crédit`, totalDebit: 0, totalCredit: 0 };
    }
  }
  const totalDebit = lines.reduce((s, l) => s + (l.debit ?? 0), 0);
  const totalCredit = lines.reduce((s, l) => s + (l.credit ?? 0), 0);
  if (Math.abs(totalDebit - totalCredit) > 0.01) {
    return { valid: false, error: `Écriture déséquilibrée : débit ${totalDebit} ≠ crédit ${totalCredit}`, totalDebit, totalCredit };
  }
  return { valid: true, totalDebit, totalCredit };
}

/** Poste une écriture manuelle validée (partie double) — réservé au Comptable. */
export async function postManualJournalEntry(input: {
  organizationId: string;
  projectId?: string;
  budgetLineId?: string;
  label: string;
  date?: Date;
  createdById: string;
  lines: ManualEntryLine[];
}) {
  const validation = validateDoubleEntry(input.lines);
  if (!validation.valid) throw new Error(validation.error);

  const entryGroup = crypto.randomUUID();
  const results = [];
  for (const line of input.lines) {
    const account = await prisma.chartOfAccount.upsert({
      where: { organizationId_accountCode: { organizationId: input.organizationId, accountCode: line.accountCode } },
      update: {},
      create: {
        organizationId: input.organizationId,
        accountCode: line.accountCode,
        label: line.accountLabel,
        classNumber: parseInt(line.accountCode[0], 10),
      },
    });
    results.push(
      await prisma.journalEntry.create({
        data: {
          accountId: account.id,
          projectId: input.projectId,
          budgetLineId: input.budgetLineId,
          date: input.date ?? new Date(),
          debit: line.debit ?? 0,
          credit: line.credit ?? 0,
          label: input.label,
          sourceType: "MANUEL",
          entryGroup,
          createdById: input.createdById,
        },
      })
    );
  }
  return results;
}
