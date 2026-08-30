import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth, requireRole } from "../middleware/auth";
import { recordPurchaseOrderDelivery, recordSupplierPayment } from "../services/accounting.service";

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
    include: { supplier: true, budgetLine: true },
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

/**
 * Confirme la livraison d'une commande. C'est ce point d'API, et lui seul,
 * qui déclenche la comptabilisation automatique (cf. cahier des charges §2.5.1) :
 * écriture au plan comptable + mise à jour du disponible de la ligne budgétaire.
 */
logisticsRouter.post("/purchase-orders/:id/deliver", requireRole("ADMIN", "LOGISTICIEN"), async (req, res) => {
  const order = await prisma.purchaseOrder.findFirst({
    where: { id: req.params.id, project: { organizationId: req.auth!.organizationId } },
  });
  if (!order) return res.status(404).json({ error: "Commande introuvable" });
  if (order.status !== "COMMANDE") return res.status(409).json({ error: "Commande déjà traitée" });

  const updated = await recordPurchaseOrderDelivery(order.id, req.auth!.organizationId);
  res.json(updated);
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
