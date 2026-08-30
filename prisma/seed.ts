import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  const org = await prisma.organization.create({
    data: { name: "ONG Sahel Ops", type: "ONG", country: "Niger" },
  });

  const passwordHash = await bcrypt.hash("motdepasse123", 10);
  const user = await prisma.user.create({
    data: { email: "admin@sahelops.org", fullName: "Aïcha Ndiaye", passwordHash },
  });

  await prisma.membership.create({
    data: { userId: user.id, organizationId: org.id, role: "ADMIN" },
  });

  const project = await prisma.project.create({
    data: {
      organizationId: org.id,
      name: "Appui à la résilience communautaire — Région du Sahel",
      code: "PRJ-2026-014",
      donor: "Union Européenne",
      currency: "XOF",
      totalBudget: 80000000,
      startDate: new Date("2026-01-01"),
      endDate: new Date("2027-06-30"),
      budgetLines: {
        create: [
          { code: "61", label: "Personnel de terrain", allocated: 42000000 },
          { code: "62", label: "Logistique & transport", allocated: 18000000 },
          { code: "63", label: "Formation & ateliers", allocated: 9000000 },
          { code: "64", label: "Fonctionnement bureau", allocated: 6000000 },
          { code: "65", label: "Suivi-évaluation", allocated: 5000000 },
        ],
      },
    },
  });

  const supplier = await prisma.supplier.create({
    data: { organizationId: org.id, name: "Sahel Équipements SARL" },
  });

  const vehicle = await prisma.vehicle.create({
    data: { organizationId: org.id, type: "VOITURE", plateNumber: "NG-2201-A", brand: "Toyota", model: "Hilux", currentMileage: 48200 },
  });

  const moto = await prisma.vehicle.create({
    data: { organizationId: org.id, type: "MOTO", plateNumber: "NG-0654-C", brand: "Yamaha", model: "AG100", currentMileage: 22800 },
  });

  const logisticienUser = await prisma.user.create({
    data: { email: "logistique@sahelops.org", fullName: "Ibrahim Souley", passwordHash },
  });
  await prisma.membership.create({
    data: { userId: logisticienUser.id, organizationId: org.id, role: "LOGISTICIEN" },
  });

  const staff = await prisma.staff.create({
    data: {
      organizationId: org.id,
      fullName: "Moussa Traoré",
      jobTitle: "Superviseur terrain",
      monthlyCost: 550000,
      email: "moussa.traore@sahelops.org",
      phone: "+22790000000",
    },
  });

  await prisma.assignment.create({
    data: { staffId: staff.id, projectId: project.id, allocPct: 80, startDate: new Date("2026-01-01") },
  });

  // Moussa Traoré est aussi chauffeur (un chauffeur EST un employé) — attitré au pick-up,
  // lui-même affecté au projet de démonstration.
  const driver = await prisma.driver.create({
    data: {
      organizationId: org.id,
      staffId: staff.id,
      licenseNumber: "NER-PC-2024-0456",
      licenseExpiryDate: new Date("2028-03-15"),
    },
  });
  await prisma.vehicle.update({ where: { id: vehicle.id }, data: { assignedDriverId: driver.id } });
  await prisma.vehicleProjectAssignment.create({
    data: { vehicleId: vehicle.id, projectId: project.id, sharePct: 100 },
  });

  console.log("Seed terminé :");
  console.log({ organizationId: org.id, projectId: project.id, supplierId: supplier.id, vehicleId: vehicle.id, motoId: moto.id, staffId: staff.id, driverId: driver.id });
  console.log("Connexion Admin : admin@sahelops.org / motdepasse123");
  console.log("Connexion Logisticien (accès au module Flotte) : logistique@sahelops.org / motdepasse123");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
