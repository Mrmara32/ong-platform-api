import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth, requireRole } from "../middleware/auth";
import { recordFuelExpense, recordMaintenanceExpense } from "../services/accounting.service";
import { computeAlerts, reportVehicleBreakdown } from "../services/alerts.service";
import { computeFuelConsumption } from "../services/fuel.service";

export const fleetRouter = Router();

/**
 * Module « Flotte » — véhicules, motos, engins (tracteurs, groupes mobiles...).
 * Réservé au chargé de logistique et à l'Admin/Président de l'organisation :
 * la restriction s'applique à TOUT le routeur, y compris les endpoints de
 * lecture — contrairement au reste du module Logistique (achats, stocks) qui
 * reste consultable par d'autres rôles. C'est la différence structurante
 * demandée : un module complet et cloisonné, pas juste des routes de plus
 * dans le fourre-tout logistique.
 */
fleetRouter.use(requireAuth);
fleetRouter.use(requireRole("ADMIN", "LOGISTICIEN"));

// ---------------------------------------------------------------------------
// Véhicules / motos / engins
// ---------------------------------------------------------------------------

fleetRouter.get("/vehicles", async (req, res) => {
  const { type } = req.query;
  const vehicles = await prisma.vehicle.findMany({
    where: {
      organizationId: req.auth!.organizationId,
      ...(type ? { type: String(type) as any } : {}),
    },
    include: {
      maintenances: { orderBy: { date: "desc" }, take: 1 },
      assignments: { include: { project: { select: { id: true, name: true } } } },
      assignedDriver: { select: { id: true, licenseNumber: true, licenseExpiryDate: true, staff: { select: { fullName: true, phone: true } } } },
      _count: { select: { trips: true, fuelLogs: true, maintenances: true } },
    },
    orderBy: { plateNumber: "asc" },
  });
  res.json(vehicles);
});

const vehicleSchema = z.object({
  type: z.enum(["VOITURE", "MOTO", "ENGIN", "AUTRE"]).default("VOITURE"),
  plateNumber: z.string().min(2),
  brand: z.string().min(1),
  model: z.string().min(1),
  currentMileage: z.number().int().nonnegative().default(0),
  engineHours: z.number().int().nonnegative().optional(),
  acquiredAt: z.string().optional(),
  assignedDriverId: z.string().uuid().optional(), // chauffeur permanent — doit référencer une fiche chauffeur existante (donc un employé)
});

fleetRouter.post("/vehicles", async (req, res) => {
  const parsed = vehicleSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  if (parsed.data.assignedDriverId) {
    const driver = await prisma.driver.findFirst({
      where: { id: parsed.data.assignedDriverId, organizationId: req.auth!.organizationId },
    });
    if (!driver) return res.status(404).json({ error: "Chauffeur introuvable" });
  }

  const { acquiredAt, ...data } = parsed.data;
  const vehicle = await prisma.vehicle.create({
    data: { ...data, acquiredAt: acquiredAt ? new Date(acquiredAt) : undefined, organizationId: req.auth!.organizationId },
  });
  res.status(201).json(vehicle);
});

/**
 * Fiche complète d'un véhicule/moto/engin : identité, statut, ET historique
 * chronologique unifié (déplacements + pleins + interventions) — l'écran de
 * référence du module pour une revue rapide avant une mission ou une
 * décision de réforme.
 */
fleetRouter.get("/vehicles/:id", async (req, res) => {
  const vehicle = await prisma.vehicle.findFirst({
    where: { id: req.params.id, organizationId: req.auth!.organizationId },
    include: {
      trips: { include: { driver: { include: { staff: true } }, project: true }, orderBy: { departureDate: "desc" } },
      fuelLogs: { orderBy: { date: "desc" } },
      maintenances: { orderBy: { date: "desc" } },
      assignments: { include: { project: true } },
      assignedDriver: { include: { staff: true } },
    },
  });
  if (!vehicle) return res.status(404).json({ error: "Véhicule introuvable" });

  const history = [
    ...vehicle.trips.map((t) => ({
      kind: "TRAJET" as const,
      date: t.departureDate,
      label: `${t.purpose} — ${t.driver.staff.fullName}${t.project ? ` (${t.project.name})` : ""}`,
      detail: t.endMileage ? `${t.endMileage - t.startMileage} km parcourus` : "en cours",
    })),
    ...vehicle.fuelLogs.map((f) => ({
      kind: "CARBURANT" as const,
      date: f.date,
      label: `Plein — ${f.liters} L`,
      detail: `${Number(f.cost).toLocaleString("fr-FR")} · ${f.mileage} km`,
    })),
    ...vehicle.maintenances.map((m) => ({
      kind: "MAINTENANCE" as const,
      date: m.date,
      label: `${m.type === "PREVENTIVE" ? "Entretien préventif" : "Réparation"}${m.description ? ` — ${m.description}` : ""}`,
      detail: `${Number(m.cost).toLocaleString("fr-FR")}${m.provider ? ` · ${m.provider}` : ""}`,
    })),
  ].sort((a, b) => b.date.getTime() - a.date.getTime());

  res.json({ vehicle, history });
});

const vehicleUpdateSchema = z.object({
  status: z.enum(["DISPONIBLE", "EN_MISSION", "EN_MAINTENANCE", "HORS_SERVICE"]).optional(),
  currentMileage: z.number().int().nonnegative().optional(),
  engineHours: z.number().int().nonnegative().optional(),
  assignedDriverId: z.string().uuid().nullable().optional(), // null pour retirer le chauffeur permanent
});

fleetRouter.patch("/vehicles/:id", async (req, res) => {
  const parsed = vehicleUpdateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const vehicle = await prisma.vehicle.findFirst({
    where: { id: req.params.id, organizationId: req.auth!.organizationId },
  });
  if (!vehicle) return res.status(404).json({ error: "Véhicule introuvable" });

  if (parsed.data.assignedDriverId) {
    const driver = await prisma.driver.findFirst({
      where: { id: parsed.data.assignedDriverId, organizationId: req.auth!.organizationId },
    });
    if (!driver) return res.status(404).json({ error: "Chauffeur introuvable" });
  }

  const updated = await prisma.vehicle.update({ where: { id: vehicle.id }, data: parsed.data });
  res.json(updated);
});

/**
 * Affecte (ou loue) un véhicule/moto/engin à un projet. Un même véhicule
 * peut être affecté à plusieurs projets à la fois (usage partagé, avec
 * répartition du coût via sharePct) — c'est cette affectation qui détermine
 * qui est notifié en cas de panne (cf. POST /vehicles/:id/report-breakdown).
 */
const assignmentSchema = z.object({
  projectId: z.string().uuid(),
  sharePct: z.number().int().min(1).max(100).default(100),
});

fleetRouter.post("/vehicles/:id/assignments", async (req, res) => {
  const parsed = assignmentSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const vehicle = await prisma.vehicle.findFirst({
    where: { id: req.params.id, organizationId: req.auth!.organizationId },
  });
  if (!vehicle) return res.status(404).json({ error: "Véhicule introuvable" });

  const assignment = await prisma.vehicleProjectAssignment.create({
    data: { vehicleId: vehicle.id, projectId: parsed.data.projectId, sharePct: parsed.data.sharePct },
  });
  res.status(201).json(assignment);
});

fleetRouter.delete("/vehicles/:id/assignments/:projectId", async (req, res) => {
  const vehicle = await prisma.vehicle.findFirst({
    where: { id: req.params.id, organizationId: req.auth!.organizationId },
  });
  if (!vehicle) return res.status(404).json({ error: "Véhicule introuvable" });

  await prisma.vehicleProjectAssignment.deleteMany({
    where: { vehicleId: vehicle.id, projectId: req.params.projectId },
  });
  res.status(204).send();
});

/**
 * Signale une panne : bascule le véhicule en "Hors service" et notifie
 * IMMÉDIATEMENT (email + Notification en base) les responsables de chaque
 * projet auquel il est affecté, ainsi que le(s) Logisticien(s)/Admin — c'est
 * le mécanisme demandé pour que les responsables de projet sachent qu'un
 * engin qu'ils utilisent est indisponible, sans attendre le calcul différé
 * des alertes de maintenance planifiée.
 */
const breakdownSchema = z.object({
  description: z.string().min(3, "Décris brièvement la panne (ex. : moteur ne démarre plus)"),
});

fleetRouter.post("/vehicles/:id/report-breakdown", async (req, res) => {
  const parsed = breakdownSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const vehicle = await prisma.vehicle.findFirst({
    where: { id: req.params.id, organizationId: req.auth!.organizationId },
  });
  if (!vehicle) return res.status(404).json({ error: "Véhicule introuvable" });

  const result = await reportVehicleBreakdown({
    organizationId: req.auth!.organizationId,
    vehicleId: vehicle.id,
    description: parsed.data.description,
  });
  res.status(201).json(result);
});

// ---------------------------------------------------------------------------
// Chauffeurs
// ---------------------------------------------------------------------------

fleetRouter.get("/drivers", async (req, res) => {
  const drivers = await prisma.driver.findMany({
    where: { organizationId: req.auth!.organizationId },
    include: { staff: { select: { fullName: true, jobTitle: true, phone: true, email: true } } },
  });
  res.json(drivers);
});

/**
 * Un chauffeur EST un employé de l'organisation (cf. schéma) : on ne crée
 * jamais de fiche chauffeur "hors RH". `staffId` doit référencer un membre
 * du personnel déjà enregistré (module RH) ; son nom et ses coordonnées ne
 * sont jamais dupliqués ici, uniquement lus via la relation.
 */
const driverSchema = z.object({
  staffId: z.string().uuid(),
  licenseNumber: z.string().min(2),
  licenseExpiryDate: z.string(),
});

fleetRouter.post("/drivers", async (req, res) => {
  const parsed = driverSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const staff = await prisma.staff.findFirst({
    where: { id: parsed.data.staffId, organizationId: req.auth!.organizationId },
  });
  if (!staff) return res.status(404).json({ error: "Employé introuvable — créez-le d'abord dans le module RH" });

  const existing = await prisma.driver.findUnique({ where: { staffId: staff.id } });
  if (existing) return res.status(409).json({ error: "Cet employé a déjà une fiche chauffeur" });

  const driver = await prisma.driver.create({
    data: {
      staffId: staff.id,
      licenseNumber: parsed.data.licenseNumber,
      licenseExpiryDate: new Date(parsed.data.licenseExpiryDate),
      organizationId: req.auth!.organizationId,
    },
    include: { staff: { select: { fullName: true, jobTitle: true, phone: true, email: true } } },
  });
  res.status(201).json(driver);
});

/**
 * Fiche complète d'un chauffeur : identité (via l'employé lié), permis, et
 * activité — véhicules qui lui sont attitrés en permanence, et historique
 * de ses trajets (les plus récents d'abord).
 */
fleetRouter.get("/drivers/:id", async (req, res) => {
  const driver = await prisma.driver.findFirst({
    where: { id: req.params.id, organizationId: req.auth!.organizationId },
    include: {
      staff: true,
      assignedVehicles: true,
      trips: { include: { vehicle: true, project: true }, orderBy: { departureDate: "desc" }, take: 20 },
    },
  });
  if (!driver) return res.status(404).json({ error: "Chauffeur introuvable" });
  res.json(driver);
});

const driverUpdateSchema = z.object({
  licenseNumber: z.string().min(2).optional(),
  licenseExpiryDate: z.string().optional(),
});

fleetRouter.patch("/drivers/:id", async (req, res) => {
  const parsed = driverUpdateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  if (Object.keys(parsed.data).length === 0) return res.status(400).json({ error: "Aucun champ à mettre à jour" });

  const driver = await prisma.driver.findFirst({
    where: { id: req.params.id, organizationId: req.auth!.organizationId },
  });
  if (!driver) return res.status(404).json({ error: "Chauffeur introuvable" });

  const updated = await prisma.driver.update({
    where: { id: driver.id },
    data: {
      ...(parsed.data.licenseNumber ? { licenseNumber: parsed.data.licenseNumber } : {}),
      ...(parsed.data.licenseExpiryDate ? { licenseExpiryDate: new Date(parsed.data.licenseExpiryDate) } : {}),
    },
    include: { staff: { select: { fullName: true, jobTitle: true, phone: true, email: true } } },
  });
  res.json(updated);
});

/**
 * Retire la fiche chauffeur d'un employé (il reste employé, il n'est
 * simplement plus déclaré comme chauffeur). Bloqué si un véhicule lui est
 * encore attitré en permanence — il faut d'abord le retirer de ce véhicule
 * (ou le remplacer par un autre chauffeur) pour éviter un véhicule "orphelin"
 * silencieusement mal référencé.
 */
fleetRouter.delete("/drivers/:id", async (req, res) => {
  const driver = await prisma.driver.findFirst({
    where: { id: req.params.id, organizationId: req.auth!.organizationId },
    include: { assignedVehicles: true },
  });
  if (!driver) return res.status(404).json({ error: "Chauffeur introuvable" });

  if (driver.assignedVehicles.length > 0) {
    return res.status(409).json({
      error: `Impossible : ce chauffeur est encore attitré à ${driver.assignedVehicles.length} véhicule(s). Retire d'abord ces affectations.`,
      vehicles: driver.assignedVehicles.map((v) => ({ id: v.id, plateNumber: v.plateNumber })),
    });
  }

  await prisma.driver.delete({ where: { id: driver.id } });
  res.status(204).send();
});

// ---------------------------------------------------------------------------
// Déplacements (carnet de bord)
// ---------------------------------------------------------------------------

fleetRouter.get("/trips", async (req, res) => {
  const { vehicleId } = req.query;
  const trips = await prisma.trip.findMany({
    where: {
      vehicle: { organizationId: req.auth!.organizationId },
      ...(vehicleId ? { vehicleId: String(vehicleId) } : {}),
    },
    include: { vehicle: true, driver: { include: { staff: true } }, project: true },
    orderBy: { departureDate: "desc" },
  });
  res.json(trips);
});

const tripSchema = z.object({
  vehicleId: z.string().uuid(),
  driverId: z.string().uuid(),
  projectId: z.string().uuid().optional(),
  purpose: z.string().min(2),
  route: z.string().optional(),
  startMileage: z.number().int().nonnegative(),
  departureDate: z.string(),
});

fleetRouter.post("/trips", async (req, res) => {
  const parsed = tripSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const trip = await prisma.trip.create({
    data: { ...parsed.data, departureDate: new Date(parsed.data.departureDate) },
  });
  await prisma.vehicle.update({ where: { id: parsed.data.vehicleId }, data: { status: "EN_MISSION" } });
  res.status(201).json(trip);
});

fleetRouter.patch("/trips/:id/close", async (req, res) => {
  const { endMileage } = req.body as { endMileage: number };
  const trip = await prisma.trip.update({
    where: { id: req.params.id },
    data: { endMileage, returnDate: new Date() },
  });
  await prisma.vehicle.update({ where: { id: trip.vehicleId }, data: { currentMileage: endMileage, status: "DISPONIBLE" } });
  res.json(trip);
});

// ---------------------------------------------------------------------------
// Carburant
// ---------------------------------------------------------------------------

fleetRouter.get("/fuel-logs", async (req, res) => {
  const { vehicleId } = req.query;
  const logs = await prisma.fuelLog.findMany({
    where: {
      vehicle: { organizationId: req.auth!.organizationId },
      ...(vehicleId ? { vehicleId: String(vehicleId) } : {}),
    },
    include: { vehicle: true },
    orderBy: { date: "desc" },
  });
  res.json(logs);
});

const fuelSchema = z.object({
  vehicleId: z.string().uuid(),
  projectId: z.string().uuid(),
  budgetLineId: z.string().uuid(),
  liters: z.number().positive(),
  cost: z.number().positive(),
  mileage: z.number().int().nonnegative(),
});

/**
 * Enregistre un plein et déclenche automatiquement l'écriture comptable
 * correspondante. Calcule aussi immédiatement la consommation de ce plein
 * et signale une éventuelle anomalie (surconsommation suspecte par rapport
 * à l'historique du véhicule) directement dans la réponse — le chargé de
 * logistique n'a pas besoin d'aller chercher ailleurs.
 */
fleetRouter.post("/fuel-logs", async (req, res) => {
  const parsed = fuelSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { vehicleId, projectId, budgetLineId, liters, cost, mileage } = parsed.data;

  const vehicle = await prisma.vehicle.findFirst({
    where: { id: vehicleId, organizationId: req.auth!.organizationId },
  });
  if (!vehicle) return res.status(404).json({ error: "Véhicule introuvable" });

  const fuelLog = await prisma.fuelLog.create({ data: { vehicleId, budgetLineId, liters, cost, mileage } });

  await recordFuelExpense({
    organizationId: req.auth!.organizationId,
    projectId,
    budgetLineId,
    vehiclePlate: vehicle.plateNumber,
    amount: cost,
  });

  await prisma.vehicle.update({ where: { id: vehicleId }, data: { currentMileage: mileage } });

  const consumption = await computeFuelConsumption(vehicleId);
  const thisPoint = consumption.find((c) => c.fuelLogId === fuelLog.id);

  res.status(201).json({ fuelLog, consumption: thisPoint ?? null });
});

/** Historique complet de consommation (L/100km) d'un véhicule, avec anomalies signalées. */
fleetRouter.get("/vehicles/:id/fuel-consumption", async (req, res) => {
  const vehicle = await prisma.vehicle.findFirst({
    where: { id: req.params.id, organizationId: req.auth!.organizationId },
  });
  if (!vehicle) return res.status(404).json({ error: "Véhicule introuvable" });

  const consumption = await computeFuelConsumption(vehicle.id);
  res.json(consumption);
});

// ---------------------------------------------------------------------------
// Historique d'entretien (maintenance)
// ---------------------------------------------------------------------------

fleetRouter.get("/maintenances", async (req, res) => {
  const { vehicleId } = req.query;
  const maintenances = await prisma.maintenance.findMany({
    where: {
      vehicle: { organizationId: req.auth!.organizationId },
      ...(vehicleId ? { vehicleId: String(vehicleId) } : {}),
    },
    include: { vehicle: true },
    orderBy: { date: "desc" },
  });
  res.json(maintenances);
});

const maintenanceSchema = z.object({
  vehicleId: z.string().uuid(),
  projectId: z.string().uuid(),
  budgetLineId: z.string().uuid(),
  type: z.enum(["PREVENTIVE", "CURATIVE"]),
  mileage: z.number().int().nonnegative(),
  provider: z.string().optional(),
  description: z.string().optional(),
  cost: z.number().positive(),
  nextDueDate: z.string().optional(), // échéance calendaire (utile pour un ENGIN peu utilisé)
  nextDueKm: z.number().int().optional(),
});

/**
 * Enregistre une intervention de maintenance — cœur de l'historique
 * d'entretien de la flotte. Déclenche l'écriture comptable automatique et,
 * en curative, bascule le véhicule en statut "En maintenance". La prochaine
 * échéance (km et/ou date) alimente directement le calcul des alertes
 * (services/alerts.service.ts).
 */
fleetRouter.post("/maintenances", async (req, res) => {
  const parsed = maintenanceSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { vehicleId, projectId, budgetLineId, type, mileage, provider, description, cost, nextDueDate, nextDueKm } = parsed.data;

  const vehicle = await prisma.vehicle.findFirst({
    where: { id: vehicleId, organizationId: req.auth!.organizationId },
  });
  if (!vehicle) return res.status(404).json({ error: "Véhicule introuvable" });

  const maintenance = await prisma.maintenance.create({
    data: {
      vehicleId, budgetLineId, type, mileage, provider, description, cost, nextDueKm,
      nextDueDate: nextDueDate ? new Date(nextDueDate) : undefined,
    },
  });

  await recordMaintenanceExpense({
    organizationId: req.auth!.organizationId,
    projectId,
    budgetLineId,
    vehiclePlate: vehicle.plateNumber,
    amount: cost,
    provider,
  });

  if (type === "CURATIVE") {
    await prisma.vehicle.update({ where: { id: vehicleId }, data: { status: "EN_MAINTENANCE" } });
  }

  res.status(201).json(maintenance);
});

// ---------------------------------------------------------------------------
// Alertes spécifiques à la flotte (sous-ensemble de computeAlerts)
// ---------------------------------------------------------------------------

fleetRouter.get("/alerts", async (req, res) => {
  const alerts = await computeAlerts(req.auth!.organizationId);
  const fleetAlerts = alerts.filter((a) => a.resourceType === "Vehicle" || a.resourceType === "Driver");
  res.json(fleetAlerts.sort((a, b) => (a.urgency === b.urgency ? 0 : a.urgency === "DEPASSEE" ? -1 : 1)));
});

// ---------------------------------------------------------------------------
// Tableau de bord flotte (KPIs de synthèse)
// ---------------------------------------------------------------------------

fleetRouter.get("/dashboard", async (req, res) => {
  const vehicles = await prisma.vehicle.findMany({
    where: { organizationId: req.auth!.organizationId },
    include: { fuelLogs: true, maintenances: true, trips: true },
  });

  const byType = vehicles.reduce((acc: Record<string, number>, v) => {
    acc[v.type] = (acc[v.type] ?? 0) + 1;
    return acc;
  }, {});
  const byStatus = vehicles.reduce((acc: Record<string, number>, v) => {
    acc[v.status] = (acc[v.status] ?? 0) + 1;
    return acc;
  }, {});
  const totalFuelCost = vehicles.reduce((s, v) => s + v.fuelLogs.reduce((s2, f) => s2 + Number(f.cost), 0), 0);
  const totalMaintenanceCost = vehicles.reduce((s, v) => s + v.maintenances.reduce((s2, m) => s2 + Number(m.cost), 0), 0);

  res.json({
    totalVehicles: vehicles.length,
    byType,
    byStatus,
    totalFuelCost,
    totalMaintenanceCost,
    totalLogisticsCost: totalFuelCost + totalMaintenanceCost,
  });
});
