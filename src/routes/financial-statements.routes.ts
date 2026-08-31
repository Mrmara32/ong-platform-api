import { Router } from "express";
import { prisma } from "../lib/prisma";
import { requireAuth, requireRole } from "../middleware/auth";

export const financialStatementsRouter = Router();
financialStatementsRouter.use(requireAuth);
financialStatementsRouter.use(requireRole("ADMIN", "COMPTABLE"));

/**
 * États financiers calculés à partir du grand livre (JournalEntry), selon
 * la structure par classes SYCEBNL/SYSCOHADA (1 à 8) déjà en place dans le
 * plan comptable :
 *   1 = Ressources durables   5 = Trésorerie
 *   2 = Immobilisations       6 = Charges
 *   3 = Stocks                7 = Produits
 *   4 = Tiers                 8 = Autres charges/produits (non lucratif)
 *
 * Le Bilan (classes 1-5) et le Compte de résultat (classes 6-7-8) sont
 * dérivés directement de la Balance — pas de double saisie, une seule
 * source de vérité : les écritures du journal.
 */

async function computeBalance(organizationId: string, asOfDate?: Date) {
  const entries = await prisma.journalEntry.findMany({
    where: {
      account: { organizationId },
      ...(asOfDate ? { date: { lte: asOfDate } } : {}),
    },
    include: { account: true },
  });

  const byAccount = new Map<string, { code: string; label: string; classNumber: number; debit: number; credit: number }>();
  for (const e of entries) {
    const key = e.account.accountCode;
    const acc = byAccount.get(key) ?? { code: e.account.accountCode, label: e.account.label, classNumber: e.account.classNumber, debit: 0, credit: 0 };
    acc.debit += Number(e.debit);
    acc.credit += Number(e.credit);
    byAccount.set(key, acc);
  }

  return Array.from(byAccount.values())
    .map((a) => ({ ...a, balance: a.debit - a.credit }))
    .sort((a, b) => a.code.localeCompare(b.code));
}

/** Balance générale : tous les comptes mouvementés, avec leur solde. */
financialStatementsRouter.get("/balance", async (req, res) => {
  const asOfDate = req.query.asOfDate ? new Date(String(req.query.asOfDate)) : undefined;
  const balance = await computeBalance(req.auth!.organizationId, asOfDate);
  const totalDebit = balance.reduce((s, a) => s + a.debit, 0);
  const totalCredit = balance.reduce((s, a) => s + a.credit, 0);
  res.json({ accounts: balance, totalDebit, totalCredit, balanced: Math.abs(totalDebit - totalCredit) < 1 });
});

/**
 * Bilan (classes 1 à 5) : ce que l'organisation possède (actif : classes 2,
 * 3, 5 à solde débiteur ; classe 4 tiers débiteurs) et ce qu'elle doit
 * (passif : classe 1 ressources durables ; classe 4 tiers créditeurs).
 */
financialStatementsRouter.get("/bilan", async (req, res) => {
  const asOfDate = req.query.asOfDate ? new Date(String(req.query.asOfDate)) : undefined;
  const balance = await computeBalance(req.auth!.organizationId, asOfDate);

  const actif = balance.filter((a) => [2, 3, 5].includes(a.classNumber) || (a.classNumber === 4 && a.balance > 0));
  const passif = balance.filter((a) => a.classNumber === 1 || (a.classNumber === 4 && a.balance < 0));

  const totalActif = actif.reduce((s, a) => s + Math.abs(a.balance), 0);
  const totalPassif = passif.reduce((s, a) => s + Math.abs(a.balance), 0);

  res.json({ actif, passif, totalActif, totalPassif, equilibre: Math.abs(totalActif - totalPassif) < 1 });
});

/** Compte de résultat (classes 6, 7, 8) : charges, produits, résultat net de la période. */
financialStatementsRouter.get("/compte-resultat", async (req, res) => {
  const startDate = req.query.startDate ? new Date(String(req.query.startDate)) : undefined;
  const endDate = req.query.endDate ? new Date(String(req.query.endDate)) : undefined;

  const entries = await prisma.journalEntry.findMany({
    where: {
      account: { organizationId: req.auth!.organizationId, classNumber: { in: [6, 7, 8] } },
      ...(startDate || endDate ? { date: { gte: startDate, lte: endDate } } : {}),
    },
    include: { account: true },
  });

  const byAccount = new Map<string, { code: string; label: string; classNumber: number; amount: number }>();
  for (const e of entries) {
    const acc = byAccount.get(e.account.accountCode) ?? { code: e.account.accountCode, label: e.account.label, classNumber: e.account.classNumber, amount: 0 };
    // Charges (classe 6/8) : mouvement net au débit. Produits (classe 7) : mouvement net au crédit.
    acc.amount += e.account.classNumber === 7 ? Number(e.credit) - Number(e.debit) : Number(e.debit) - Number(e.credit);
    byAccount.set(e.account.accountCode, acc);
  }

  const charges = Array.from(byAccount.values()).filter((a) => a.classNumber === 6 || a.classNumber === 8);
  const produits = Array.from(byAccount.values()).filter((a) => a.classNumber === 7);
  const totalCharges = charges.reduce((s, a) => s + a.amount, 0);
  const totalProduits = produits.reduce((s, a) => s + a.amount, 0);

  res.json({ charges, produits, totalCharges, totalProduits, resultatNet: totalProduits - totalCharges });
});

/**
 * Flux de trésorerie — méthode directe simplifiée : variation nette des
 * comptes de trésorerie (classe 5) sur la période, détaillée par sous-compte
 * (banque, chaque canal de mobile money, caisse).
 */
financialStatementsRouter.get("/flux-tresorerie", async (req, res) => {
  const startDate = req.query.startDate ? new Date(String(req.query.startDate)) : undefined;
  const endDate = req.query.endDate ? new Date(String(req.query.endDate)) : undefined;

  const entries = await prisma.journalEntry.findMany({
    where: {
      account: { organizationId: req.auth!.organizationId, classNumber: 5 },
      ...(startDate || endDate ? { date: { gte: startDate, lte: endDate } } : {}),
    },
    include: { account: true },
    orderBy: { date: "asc" },
  });

  const byAccount = new Map<string, { code: string; label: string; entrees: number; sorties: number }>();
  for (const e of entries) {
    const acc = byAccount.get(e.account.accountCode) ?? { code: e.account.accountCode, label: e.account.label, entrees: 0, sorties: 0 };
    acc.entrees += Number(e.debit);
    acc.sorties += Number(e.credit);
    byAccount.set(e.account.accountCode, acc);
  }

  const comptes = Array.from(byAccount.values()).map((a) => ({ ...a, variation: a.entrees - a.sorties }));
  const totalEntrees = comptes.reduce((s, a) => s + a.entrees, 0);
  const totalSorties = comptes.reduce((s, a) => s + a.sorties, 0);

  res.json({ comptes, totalEntrees, totalSorties, variationNette: totalEntrees - totalSorties });
});
