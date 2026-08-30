import { prisma } from "../lib/prisma";
import { sendMail } from "../lib/mailer";

/**
 * Calcule les alertes de maintenance/renouvellement pour une organisation :
 * - véhicules/motos dont la prochaine échéance (km ou date) est atteinte ou approche
 * - matériel divers (PC, imprimantes...) dont l'entretien ou le renouvellement
 *   de licence (ex. antivirus) approche ou est dépassé
 *
 * Les seuils "à venir" / "imminente" reprennent ceux du cahier des charges
 * (§2.5.7ter) : 15 jours ou 1000 km avant l'échéance.
 */

const DAYS_IMMINENT = 15;
const KM_IMMINENT = 1000;

interface ComputedAlert {
  type: "MAINTENANCE_VEHICULE" | "MAINTENANCE_MATERIEL" | "RENOUVELLEMENT_LICENCE";
  message: string;
  dueAt: Date;
  urgency: "A_VENIR" | "IMMINENTE" | "DEPASSEE";
  resourceType: "Vehicle" | "Asset" | "Driver";
  resourceId: string;
}

export function urgencyFromDate(dueAt: Date, now: Date): ComputedAlert["urgency"] {
  const daysLeft = (dueAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
  if (daysLeft < 0) return "DEPASSEE";
  if (daysLeft <= DAYS_IMMINENT) return "IMMINENTE";
  return "A_VENIR";
}

export function urgencyFromKm(kmLeft: number): ComputedAlert["urgency"] {
  if (kmLeft < 0) return "DEPASSEE";
  if (kmLeft <= KM_IMMINENT) return "IMMINENTE";
  return "A_VENIR";
}

export async function computeAlerts(organizationId: string, now = new Date()): Promise<ComputedAlert[]> {
  const alerts: ComputedAlert[] = [];

  // --- Véhicules / motos : dernière maintenance de chaque véhicule avec une échéance définie ---
  const vehicles = await prisma.vehicle.findMany({
    where: { organizationId },
    include: { maintenances: { orderBy: { date: "desc" }, take: 1 } },
  });

  for (const vehicle of vehicles) {
    const lastMaintenance = vehicle.maintenances[0];
    if (!lastMaintenance) continue;

    if (lastMaintenance.nextDueKm != null) {
      // Pour un ENGIN suivi en heures moteur plutôt qu'en kilomètres, on compare
      // à engineHours ; sinon (voiture, moto) on compare au kilométrage classique.
      const usesEngineHours = vehicle.type === "ENGIN" && vehicle.engineHours != null;
      const currentReading = usesEngineHours ? vehicle.engineHours! : vehicle.currentMileage;
      const unit = usesEngineHours ? "h" : "km";
      const kmLeft = lastMaintenance.nextDueKm - currentReading;
      const urgency = urgencyFromKm(kmLeft);
      if (urgency !== "A_VENIR" || kmLeft <= KM_IMMINENT * 3) {
        alerts.push({
          type: "MAINTENANCE_VEHICULE",
          message: `${vehicle.brand} ${vehicle.model} (${vehicle.plateNumber}) — entretien prévu à ${lastMaintenance.nextDueKm} ${unit}, actuellement à ${currentReading} ${unit}`,
          dueAt: now, // échéance kilométrique/horaire, pas de date calendaire précise
          urgency,
          resourceType: "Vehicle",
          resourceId: vehicle.id,
        });
      }
    }

    if (lastMaintenance.nextDueDate) {
      const urgency = urgencyFromDate(lastMaintenance.nextDueDate, now);
      alerts.push({
        type: "MAINTENANCE_VEHICULE",
        message: `${vehicle.brand} ${vehicle.model} (${vehicle.plateNumber}) — entretien prévu le ${lastMaintenance.nextDueDate.toLocaleDateString("fr-FR")}`,
        dueAt: lastMaintenance.nextDueDate,
        urgency,
        resourceType: "Vehicle",
        resourceId: vehicle.id,
      });
    }
  }

  // --- Matériel divers : dernière intervention/renouvellement de chaque actif ---
  const assets = await prisma.asset.findMany({
    where: { organizationId },
    include: { maintenances: { orderBy: { date: "desc" }, take: 1 } },
  });

  for (const asset of assets) {
    const last = asset.maintenances[0];
    if (!last?.nextDueDate) continue;

    const urgency = urgencyFromDate(last.nextDueDate, now);
    const isLicense = last.type === "RENOUVELLEMENT_LICENCE";
    alerts.push({
      type: isLicense ? "RENOUVELLEMENT_LICENCE" : "MAINTENANCE_MATERIEL",
      message: isLicense
        ? `${asset.name} — renouvellement de licence (${last.description ?? "abonnement"}) prévu le ${last.nextDueDate.toLocaleDateString("fr-FR")}`
        : `${asset.name} — entretien prévu le ${last.nextDueDate.toLocaleDateString("fr-FR")}`,
      dueAt: last.nextDueDate,
      urgency,
      resourceType: "Asset",
      resourceId: asset.id,
    });
  }

  // --- Chauffeurs : échéance du permis de conduire ---
  const drivers = await prisma.driver.findMany({
    where: { organizationId },
    include: { staff: { select: { fullName: true } } },
  });

  for (const driver of drivers) {
    const urgency = urgencyFromDate(driver.licenseExpiryDate, now);
    if (urgency === "A_VENIR") continue; // pas d'alerte tant que l'échéance est lointaine
    alerts.push({
      type: "RENOUVELLEMENT_LICENCE",
      message: `${driver.staff.fullName} — permis de conduire ${urgency === "DEPASSEE" ? "expiré" : "arrivant à expiration"} le ${driver.licenseExpiryDate.toLocaleDateString("fr-FR")}`,
      dueAt: driver.licenseExpiryDate,
      urgency,
      resourceType: "Driver",
      resourceId: driver.id,
    });
  }

  return alerts;
}

/** Calcule les alertes et les persiste (upsert) comme Notification, pour historique et accusé de réception. */
export async function refreshNotifications(organizationId: string) {
  const alerts = await computeAlerts(organizationId);

  const notifications = await Promise.all(
    alerts.map((a) =>
      prisma.notification.upsert({
        where: {
          resourceType_resourceId_type_dueAt: {
            resourceType: a.resourceType,
            resourceId: a.resourceId,
            type: a.type,
            dueAt: a.dueAt,
          },
        },
        update: { urgency: a.urgency, message: a.message },
        create: {
          organizationId,
          type: a.type,
          message: a.message,
          dueAt: a.dueAt,
          urgency: a.urgency,
          resourceType: a.resourceType,
          resourceId: a.resourceId,
        },
      })
    )
  );

  return notifications;
}

/**
 * Envoie un récapitulatif des alertes en attente au(x) Logisticien(s) de
 * l'organisation (et à l'Admin/Président, en copie de sécurité). En
 * production, cette fonction serait appelée par une tâche planifiée (cron
 * quotidien) plutôt que déclenchée manuellement — voir le routeur pour
 * l'endpoint qui permet de la déclencher à la demande en attendant.
 */
export async function notifyLogisticsOfficers(organizationId: string) {
  const notifications = await prisma.notification.findMany({
    where: { organizationId, status: "EN_ATTENTE" },
    orderBy: { urgency: "asc" },
  });
  if (notifications.length === 0) return { sent: false, reason: "Aucune alerte en attente" };

  const recipients = await prisma.membership.findMany({
    where: { organizationId, role: { in: ["LOGISTICIEN", "ADMIN"] } },
    include: { user: true },
  });
  const emails = recipients.map((m) => m.user.email).filter(Boolean);
  if (emails.length === 0) return { sent: false, reason: "Aucun destinataire (Logisticien/Admin) trouvé" };

  const lines = notifications.map((n) => `- [${n.urgency}] ${n.message}`).join("\n");

  const results = await Promise.all(
    emails.map((to) =>
      sendMail({
        to,
        subject: `Alertes maintenance & renouvellements (${notifications.length})`,
        text: `Voici les échéances de maintenance et de renouvellement en attente :\n\n${lines}`,
      })
    )
  );

  return { sent: true, recipients: emails, count: notifications.length, simulated: results.some((r) => r.simulated) };
}

// ---------------------------------------------------------------------------
// Signalement de panne — notification immédiate des responsables de projet
// ---------------------------------------------------------------------------

/**
 * Signale la panne d'un véhicule/moto/engin. Contrairement aux alertes de
 * maintenance planifiée (calculées et notifiées en différé), une panne est
 * un événement immédiat : le véhicule passe HORS_SERVICE tout de suite, et
 * les responsables de CHAQUE PROJET auquel il est affecté/loué (via
 * VehicleProjectAssignment) sont notifiés sur-le-champ — pas seulement le
 * chargé de logistique, qui peut ne pas être sur le terrain concerné.
 *
 * "Responsable de projet" = utilisateur avec ProjectMembership.role
 * RESPONSABLE sur CE projet précis (cf. §2.1.1 sur la portée d'accès).
 */
export async function reportVehicleBreakdown(input: {
  organizationId: string;
  vehicleId: string;
  description: string;
}) {
  const { organizationId, vehicleId, description } = input;

  const vehicle = await prisma.vehicle.findFirstOrThrow({
    where: { id: vehicleId, organizationId },
    include: { assignments: { include: { project: true } } },
  });

  await prisma.vehicle.update({ where: { id: vehicle.id }, data: { status: "HORS_SERVICE" } });

  const affectedProjects = vehicle.assignments.map((a) => a.project);

  // Une notification par projet impacté, pour que chacun ne voie que ce qui le concerne
  const notifications = await Promise.all(
    affectedProjects.map((project) =>
      prisma.notification.create({
        data: {
          organizationId,
          projectId: project.id,
          type: "PANNE_VEHICULE",
          message: `${vehicle.brand} ${vehicle.model} (${vehicle.plateNumber}) est hors service — ${description}`,
          dueAt: new Date(),
          urgency: "DEPASSEE",
          resourceType: "Vehicle",
          resourceId: vehicle.id,
        },
      })
    )
  );

  // Si le véhicule n'est affecté à aucun projet, on notifie quand même
  // l'organisation (notification sans projectId), pour ne jamais perdre l'info.
  if (affectedProjects.length === 0) {
    notifications.push(
      await prisma.notification.create({
        data: {
          organizationId,
          type: "PANNE_VEHICULE",
          message: `${vehicle.brand} ${vehicle.model} (${vehicle.plateNumber}) est hors service — ${description}`,
          dueAt: new Date(),
          urgency: "DEPASSEE",
          resourceType: "Vehicle",
          resourceId: vehicle.id,
        },
      })
    );
  }

  // Destinataires email : responsables de chaque projet impacté + Logisticien/Admin de l'organisation
  const projectResponsibleEmails = affectedProjects.length
    ? (
        await prisma.projectMembership.findMany({
          where: { projectId: { in: affectedProjects.map((p) => p.id) }, role: "RESPONSABLE" },
          include: { user: true },
        })
      ).map((m) => m.user.email)
    : [];

  const logisticsEmails = (
    await prisma.membership.findMany({
      where: { organizationId, role: { in: ["LOGISTICIEN", "ADMIN"] } },
      include: { user: true },
    })
  ).map((m) => m.user.email);

  const recipients = Array.from(new Set([...projectResponsibleEmails, ...logisticsEmails].filter(Boolean)));

  const projectNames = affectedProjects.map((p) => p.name).join(", ") || "aucun projet affecté";
  const results = await Promise.all(
    recipients.map((to) =>
      sendMail({
        to,
        subject: `Panne signalée — ${vehicle.brand} ${vehicle.model} (${vehicle.plateNumber})`,
        text: `Le véhicule ${vehicle.brand} ${vehicle.model} (${vehicle.plateNumber}), affecté à : ${projectNames}, vient d'être signalé en panne.\n\nMotif : ${description}\n\nLe véhicule est désormais marqué "Hors service" dans la plateforme.`,
      })
    )
  );

  return {
    vehicle: { ...vehicle, status: "HORS_SERVICE" },
    affectedProjects: affectedProjects.map((p) => ({ id: p.id, name: p.name })),
    notifications,
    recipients,
    simulated: results.some((r) => r.simulated),
  };
}
