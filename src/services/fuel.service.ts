import { prisma } from "../lib/prisma";

/**
 * Seuil de détection d'anomalie : un plein dont la consommation dépasse de
 * 30 % la moyenne des pleins précédents du même véhicule est signalé comme
 * suspect (fuite, détournement, panne mécanique...). Nécessite au moins 2
 * pleins précédents pour établir une moyenne fiable.
 */
const ANOMALY_THRESHOLD = 1.3;
const MIN_HISTORY_FOR_ANOMALY = 2;

export interface ConsumptionPoint {
  fuelLogId: string;
  date: Date;
  litersPer100Km: number | null;
  isAnomaly: boolean;
}

/**
 * Calcule la consommation (L/100km) de chaque plein d'un véhicule, à partir
 * de la distance parcourue depuis le plein précédent, et marque comme
 * anomalie tout plein dont la consommation dépasse le seuil par rapport à
 * la moyenne des pleins antérieurs.
 */
export async function computeFuelConsumption(vehicleId: string): Promise<ConsumptionPoint[]> {
  const logs = await prisma.fuelLog.findMany({
    where: { vehicleId },
    orderBy: { mileage: "asc" },
  });

  const points: ConsumptionPoint[] = [];
  const history: number[] = [];

  for (let i = 0; i < logs.length; i++) {
    const current = logs[i];
    const previous = logs[i - 1];
    const distance = previous ? current.mileage - previous.mileage : 0;
    const litersPer100Km = distance > 0 ? (Number(current.liters) / distance) * 100 : null;

    let isAnomaly = false;
    if (litersPer100Km !== null && history.length >= MIN_HISTORY_FOR_ANOMALY) {
      const average = history.reduce((s, v) => s + v, 0) / history.length;
      isAnomaly = litersPer100Km > average * ANOMALY_THRESHOLD;
    }

    points.push({ fuelLogId: current.id, date: current.date, litersPer100Km, isAnomaly });
    if (litersPer100Km !== null) history.push(litersPer100Km);
  }

  return points.reverse();
}
