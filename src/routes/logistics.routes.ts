import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth, requireRole } from "../middleware/auth";
import { recordPurchaseOrderDelivery, recordSupplierPayment, recordSupplierInvoiceReceived } from "../services/accounting.service";
import { logAudit } from "../services/audit.service";

export const logisticsRouter = Router();
logisticsRouter.use(requireAuth);

// -------- Fournisseurs --------

logisticsRouter.get("/suppliers", async (req, res) => {
  const suppliers = await prisma.supplier.findMany({
    where: { organizationId: req.auth!.organizationId },
    orderBy: { name: "asc" },
  });
  res.json(suppliers);
});

const supplierSchema = z.object({
  name: z.string().min(2),
  contact: z.string().optional(),
});

logisticsRouter.post("/suppliers", requireRole("ADMIN", "LOGISTICIEN"), async (req, res) => {
  const parsed = supplierSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const supplier = await prisma.supplier.create({
    data: { ...parsed.data, organizationId: req.auth!.organizationId },
  });
  res.status(201).json(supplier);
});

// -------- Commandes / Achats --------
//
// Cycle complet : Logistique passe la commande (EN_ATTENTE_VALIDATION) →
// Président valide ou rejette (VALIDEE / REJETEE) → réception physique
// (LIVREE) → Comptable enregistre la facture fournisseur reçue
// (FACTURE_RECUE, comptabilisée) → paiement (COMPTABILISEE).

const orderSchema = z.object({
  projectId: z.string().uuid(),
  budgetLineId: z.string().uuid(),
  supplierId: z.string().uuid(),
  item: z.string().min(2),
  amount: z.number().positive(),
});

logisticsRouter.get("/purchase-orders", async (req, res) => {
  const orders = await prisma.purchaseOrder.findMany({
    where: { project: { organizationId: req.auth!.organizationId } },
    include: { supplier: true, budgetLine: true, validatedBy: { select: { fullName: true } }, supplierInvoice: true },
    orderBy: { createdAt: "desc" },
  });
  res.json(orders);
});

logisticsRouter.post("/purchase-orders", requireRole("ADMIN", "LOGISTICIEN"), async (req, res) => {
  const parsed = orderSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const order = await prisma.purchaseOrder.create({ data: parsed.data });
  res.status(201).json(order);
});

/** Validation de la commande par le Président/Admin — étape obligatoire avant tout envoi au fournisseur. */
logisticsRouter.post("/purchase-orders/:id/validate", requireRole("ADMIN"), async (req, res) => {
  const order = await prisma.purchaseOrder.findFirst({
    where: { id: req.params.id, project: { organizationId: req.auth!.organizationId } },
  });
  if (!order) return res.status(404).json({ error: "Commande introuvable" });
  if (order.status !== "EN_ATTENTE_VALIDATION") return res.status(409).json({ error: "Cette commande n'est pas en attente de validation" });

  const updated = await prisma.purchaseOrder.update({
    where: { id: order.id },
    data: { status: "VALIDEE", validatedById: req.auth!.userId, validatedAt: new Date() },
  });
  await logAudit({ userId: req.auth!.userId, organizationId: req.auth!.organizationId, action: "VALIDATE_ORDER", entity: "PurchaseOrder", entityId: order.id, metadata: { item: order.item, amount: Number(order.amount) } });
  res.json(updated);
});

const rejectSchema = z.object({ reason: z.string().min(3, "Précise le motif du refus") });

/** Rejet de la commande par le Président/Admin, avec motif obligatoire. */
logisticsRouter.post("/purchase-orders/:id/reject", requireRole("ADMIN"), async (req, res) => {
  const parsed = rejectSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const order = await prisma.purchaseOrder.findFirst({
    where: { id: req.params.id, project: { organizationId: req.auth!.organizationId } },
  });
  if (!order) return res.status(404).json({ error: "Commande introuvable" });
  if (order.status !== "EN_ATTENTE_VALIDATION") return res.status(409).json({ error: "Cette commande n'est pas en attente de validation" });

  const updated = await prisma.purchaseOrder.update({
    where: { id: order.id },
    data: { status: "REJETEE", validatedById: req.auth!.userId, validatedAt: new Date(), rejectionReason: parsed.data.reason },
  });
  await logAudit({ userId: req.auth!.userId, organizationId: req.auth!.organizationId, action: "REJECT_ORDER", entity: "PurchaseOrder", entityId: order.id, metadata: { item: order.item, reason: parsed.data.reason } });
  res.json(updated);
});

const deliverSchema = z.object({ deliveryNoteRef: z.string().optional() });

/** Confirme la réception physique (bon de livraison + marchandise) d'une commande validée. */
logisticsRouter.post("/purchase-orders/:id/deliver", requireRole("ADMIN", "LOGISTICIEN"), async (req, res) => {
  const parsed = deliverSchema.safeParse(req.body ?? {});
  const order = await prisma.purchaseOrder.findFirst({
    where: { id: req.params.id, project: { organizationId: req.auth!.organizationId } },
  });
  if (!order) return res.status(404).json({ error: "Commande introuvable" });
  if (order.status !== "VALIDEE") return res.status(409).json({ error: "La commande doit être validée par le Président avant réception" });

  const updated = await recordPurchaseOrderDelivery(order.id, parsed.success ? parsed.data.deliveryNoteRef : undefined);
  res.json(updated);
});

const supplierInvoiceSchema = z.object({
  invoiceNumber: z.string().min(1),
  amount: z.number().positive(),
});

/**
 * Enregistrement de la facture fournisseur reçue — réservé au Comptable
 * (et à l'Admin). C'est cet acte qui déclenche la comptabilisation de la
 * dette envers le fournisseur (débit charge / crédit compte 401).
 */
logisticsRouter.post("/purchase-orders/:id/supplier-invoice", requireRole("ADMIN", "COMPTABLE"), async (req, res) => {
  const parsed = supplierInvoiceSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const order = await prisma.purchaseOrder.findFirst({
    where: { id: req.params.id, project: { organizationId: req.auth!.organizationId } },
  });
  if (!order) return res.status(404).json({ error: "Commande introuvable" });
  if (order.status !== "LIVREE") return res.status(409).json({ error: "La commande doit être réceptionnée (bon de livraison) avant d'enregistrer la facture" });

  const supplierInvoice = await recordSupplierInvoiceReceived({
    organizationId: req.auth!.organizationId,
    purchaseOrderId: order.id,
    invoiceNumber: parsed.data.invoiceNumber,
    amount: parsed.data.amount,
    registeredById: req.auth!.userId,
  });
  res.status(201).json(supplierInvoice);
});

// -------- Stocks --------

logisticsRouter.get("/warehouses", async (req, res) => {
  const warehouses = await prisma.warehouse.findMany({ where: { organizationId: req.auth!.organizationId } });
  res.json(warehouses);
});

const warehouseSchema = z.object({ name: z.string().min(2), location: z.string().optional() });
logisticsRouter.post("/warehouses", requireRole("ADMIN", "LOGISTICIEN"), async (req, res) => {
  const parsed = warehouseSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const warehouse = await prisma.warehouse.create({
    data: { ...parsed.data, organizationId: req.auth!.organizationId },
  });
  res.status(201).json(warehouse);
});

logisticsRouter.get("/stock-items", async (req, res) => {
  const items = await prisma.stockItem.findMany({
    where: { warehouse: { organizationId: req.auth!.organizationId } },
  });
  res.json(items.map((i) => ({ ...i, belowThreshold: Number(i.quantity) < Number(i.minQuantity) })));
});

const stockItemSchema = z.object({
  warehouseId: z.string().uuid(),
  projectId: z.string().uuid().optional(),
  name: z.string().min(2),
  unit: z.string().min(1),
  quantity: z.number().nonnegative().default(0),
  minQuantity: z.number().nonnegative().default(0),
  unitCost: z.number().nonnegative().default(0),
});

logisticsRouter.post("/stock-items", requireRole("ADMIN", "LOGISTICIEN"), async (req, res) => {
  const parsed = stockItemSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const item = await prisma.stockItem.create({ data: parsed.data });
  res.status(201).json(item);
});

const stockMovementSchema = z.object({
  stockItemId: z.string().uuid(),
  type: z.enum(["ENTREE", "SORTIE", "TRANSFERT"]),
  quantity: z.number().positive(),
  reason: z.string().optional(),
});

logisticsRouter.post("/stock-movements", requireRole("ADMIN", "LOGISTICIEN"), async (req, res) => {
  const parsed = stockMovementSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { stockItemId, type, quantity, reason } = parsed.data;

  const delta = type === "SORTIE" ? -quantity : quantity;
  const [movement] = await prisma.$transaction([
    prisma.stockMovement.create({ data: { stockItemId, type, quantity, reason } }),
    prisma.stockItem.update({ where: { id: stockItemId }, data: { quantity: { increment: delta } } }),
  ]);
  res.status(201).json(movement);
});

// -------- Paiement fournisseur (multicanal) --------

const supplierPaymentSchema = z.object({
  supplierId: z.string().uuid(),
  projectId: z.string().uuid().optional(),
  budgetLineId: z.string().uuid().optional(),
  amount: z.number().positive(),
  method: z.enum(["VIREMENT", "ORANGE_MONEY", "MTN_MONEY", "MOOV_MONEY", "WAVE", "ESPECES", "CHEQUE"]),
  reference: z.string().optional(),
  purchaseOrderId: z.string().uuid().optional(), // clôture le cycle commande si le paiement correspond à une facture fournisseur enregistrée
});

/**
 * Règle un fournisseur/prestataire, quel que soit le canal (virement, Orange
 * Money, MTN Money, espèces...). Utilisé notamment après confirmation de
 * livraison pour solder le compte fournisseur ouvert par la comptabilisation
 * automatique de la commande.
 */
logisticsRouter.post("/supplier-payments", requireRole("ADMIN", "COMPTABLE", "LOGISTICIEN"), async (req, res) => {
  const parsed = supplierPaymentSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const payment = await recordSupplierPayment({
    organizationId: req.auth!.organizationId,
    ...parsed.data,
  });
  res.status(201).json(payment);
});

// -------- Demandes de consommables --------

logisticsRouter.get("/consumable-requests", async (req, res) => {
  const requests = await prisma.consumableRequest.findMany({
    where: { organizationId: req.auth!.organizationId },
    include: { requestedBy: { select: { fullName: true, jobTitle: true } } },
    orderBy: { createdAt: "desc" },
  });
  res.json(requests);
});

const consumableRequestSchema = z.object({
  staffId: z.string().uuid(),
  projectId: z.string().uuid().optional(),
  itemName: z.string().min(1),
  quantity: z.number().positive(),
  unit: z.string().min(1),
  justification: z.string().optional(),
});

/** Tout employé peut soumettre une demande de consommables — pas de restriction de rôle. */
logisticsRouter.post("/consumable-requests", async (req, res) => {
  const parsed = consumableRequestSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const request = await prisma.consumableRequest.create({
    data: { ...parsed.data, organizationId: req.auth!.organizationId },
  });
  res.status(201).json(request);
});

const decideConsumableSchema = z.object({
  status: z.enum(["APPROUVEE", "REFUSEE"]),
  fulfilledFromStockItemId: z.string().uuid().optional(),
});

/**
 * Décision sur une demande de consommables — réservée à la Logistique/Admin.
 * Si servie depuis le stock, une sortie de stock est immédiatement générée ;
 * sinon la demande reste tracée comme nécessitant une commande fournisseur.
 */
logisticsRouter.patch("/consumable-requests/:id", requireRole("ADMIN", "LOGISTICIEN"), async (req, res) => {
  const parsed = decideConsumableSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const request = await prisma.consumableRequest.findFirst({
    where: { id: req.params.id, organizationId: req.auth!.organizationId },
  });
  if (!request) return res.status(404).json({ error: "Demande introuvable" });

  let finalStatus: string = parsed.data.status;

  if (parsed.data.status === "APPROUVEE" && parsed.data.fulfilledFromStockItemId) {
    await prisma.$transaction([
      prisma.stockMovement.create({
        data: {
          stockItemId: parsed.data.fulfilledFromStockItemId,
          type: "SORTIE",
          quantity: request.quantity,
          reason: `Demande de consommables — ${request.itemName}`,
        },
      }),
      prisma.stockItem.update({
        where: { id: parsed.data.fulfilledFromStockItemId },
        data: { quantity: { decrement: request.quantity } },
      }),
    ]);
    finalStatus = "SERVIE_STOCK";
  } else if (parsed.data.status === "APPROUVEE") {
    finalStatus = "COMMANDE_REQUISE";
  }

  const updated = await prisma.consumableRequest.update({
    where: { id: request.id },
    data: {
      status: finalStatus as any,
      approvedById: req.auth!.userId,
      approvedAt: new Date(),
      fulfilledFromStockItemId: parsed.data.fulfilledFromStockItemId,
    },
  });
  res.json(updated);
});

// -------- Rapport de stock : situation et mouvements --------

/** Situation actuelle du stock + historique complet des mouvements, pour un article ou pour tout l'inventaire. */
logisticsRouter.get("/stock-report", async (req, res) => {
  const { stockItemId } = req.query;
  const items = await prisma.stockItem.findMany({
    where: {
      warehouse: { organizationId: req.auth!.organizationId },
      ...(stockItemId ? { id: String(stockItemId) } : {}),
    },
    include: {
      warehouse: { select: { name: true } },
      movements: { orderBy: { date: "desc" } },
    },
  });

  const report = items.map((item) => {
    const entrees = item.movements.filter((m) => m.type === "ENTREE").reduce((s, m) => s + Number(m.quantity), 0);
    const sorties = item.movements.filter((m) => m.type === "SORTIE").reduce((s, m) => s + Number(m.quantity), 0);
    return {
      id: item.id,
      name: item.name,
      unit: item.unit,
      warehouse: item.warehouse.name,
      currentQuantity: Number(item.quantity),
      minQuantity: Number(item.minQuantity),
      belowThreshold: Number(item.quantity) < Number(item.minQuantity),
      totalEntrees: entrees,
      totalSorties: sorties,
      movements: item.movements,
    };
  });

  res.json(report);
});
