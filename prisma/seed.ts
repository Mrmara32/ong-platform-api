import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

/**
 * Données de démonstration construites à partir des rapports d'activités
 * réels du CAM (2ème et 3ème repères, avril-mai 2017) sur le projet de lutte
 * contre le paludisme financé par USAID-Guinée via RTI International.
 *
 * Les INDICATEURS D'ACTIVITÉ (VAD, causeries, supervisions, réunions,
 * sensibilisations) sont les VRAIS chiffres extraits des rapports.
 * Les MONTANTS BUDGÉTAIRES sont des ESTIMATIONS pour la démonstration —
 * les rapports fournis ne contiennent aucune donnée financière ; à ajuster
 * avec les vrais montants du contrat CAM-RTI International si disponibles.
 */
async function main() {
  const org = await prisma.organization.create({
    data: {
      name: "ONG Club des Amis du Monde (CAM)",
      type: "ONG",
      country: "République de Guinée",
      address: "Antenne régionale de Boké — BP 92, Quartier Kougnéwadé II, Commune urbaine de Boké",
      phone: "+224 666 964 592",
      email: "clubamisdumonde@gmail.com",
      website: "www.camguinee.org",
      bankName: "BICIGUI",
      bankAddress: "Agence de la République — Conakry",
      bankAccountNumber: "002 842 0103 6080 0186",
    },
  });

  const passwordHash = await bcrypt.hash("motdepasse123", 10);

  // --- Équipe dirigeante du CAM ---

  const president = await prisma.user.create({
    data: { email: "president@amisdumonde-cam.org", fullName: "Boubacar Sylla", passwordHash },
  });
  await prisma.membership.create({
    data: { userId: president.id, organizationId: org.id, role: "ADMIN" },
  });

  const coordinateur = await prisma.user.create({
    data: { email: "coordination@amisdumonde-cam.org", fullName: "Cheick Amadou Sylla", passwordHash },
  });
  await prisma.membership.create({
    data: { userId: coordinateur.id, organizationId: org.id, role: "CHEF_PROJET" },
  });

  const daf = await prisma.user.create({
    data: { email: "daf@amisdumonde-cam.org", fullName: "Moricany Sylla", passwordHash },
  });
  await prisma.membership.create({
    data: { userId: daf.id, organizationId: org.id, role: "COMPTABLE" },
  });

  const logisticien = await prisma.user.create({
    data: { email: "logistique@amisdumonde-cam.org", fullName: "Facinet Barry", passwordHash },
  });
  await prisma.membership.create({
    data: { userId: logisticien.id, organizationId: org.id, role: "LOGISTICIEN" },
  });

  // --- Fiches employés (module RH) correspondant à chacun ---

  const staffPresident = await prisma.staff.create({
    data: { organizationId: org.id, fullName: "Boubacar Sylla", jobTitle: "Président", monthlyCost: 0, email: "president@amisdumonde-cam.org" },
  });
  const staffCoordinateur = await prisma.staff.create({
    data: { organizationId: org.id, fullName: "Cheick Amadou Sylla", jobTitle: "Coordinateur de projet", monthlyCost: 3500000, email: "coordination@amisdumonde-cam.org", phone: "+224620000001" },
  });
  const staffDaf = await prisma.staff.create({
    data: { organizationId: org.id, fullName: "Moricany Sylla", jobTitle: "Directeur Administratif et Financier", monthlyCost: 3000000, email: "daf@amisdumonde-cam.org", phone: "+224620000002" },
  });
  const staffLogistique = await prisma.staff.create({
    data: { organizationId: org.id, fullName: "Facinet Barry", jobTitle: "Chargé de logistique", monthlyCost: 2000000, email: "logistique@amisdumonde-cam.org", phone: "+224620000003" },
  });
  const staffChauffeur = await prisma.staff.create({
    data: { organizationId: org.id, fullName: "Alhouseine Maiga", jobTitle: "Chauffeur", monthlyCost: 1200000, phone: "+224620000004" },
  });

  // --- Projet réel : lutte contre le paludisme (Boffa, Gaoual, Koundara) ---

  const project = await prisma.project.create({
    data: {
      organizationId: org.id,
      name: "Prévention et prise en charge du paludisme dans les communautés de Boffa, Gaoual et Koundara",
      code: "STOPALU-BGK-2017",
      donor: "USAID-Guinée (partenariat CAM – RTI International)",
      grantNumber: "0213947-G-2017-002-00",
      currency: "GNF",
      totalBudget: 450000000, // estimation pour la démo — à remplacer par le montant contractuel réel
      startDate: new Date("2017-01-01"),
      endDate: new Date("2018-12-31"),
      budgetLines: {
        create: [
          { code: "61", label: "Personnel de terrain (AC, Animateurs-Superviseurs)", allocated: 220000000 },
          { code: "62", label: "Logistique & transport (VAD, tournées sono-mobile)", allocated: 95000000 },
          { code: "63", label: "Sensibilisation & causeries éducatives", allocated: 65000000 },
          { code: "64", label: "Fonctionnement bureau (Boké, Boffa, Gaoual, Koundara)", allocated: 40000000 },
          { code: "65", label: "Suivi-évaluation (réunions mensuelles, supervision)", allocated: 30000000 },
        ],
      },
    },
  });

  // Cadre logique — indicateurs RÉELS issus du rapport du 2ème repère (avril 2017)
  await prisma.logframeResult.createMany({
    data: [
      {
        projectId: project.id,
        objective: "Réduire l'incidence du paludisme dans les communautés de Boffa, Gaoual et Koundara",
        result: "R1 — Visites à Domicile (VAD) réalisées par les Agents Communautaires",
        indicator: "Nombre de VAD réalisées",
        target: 22080,
        achieved: 5394,
      },
      {
        projectId: project.id,
        objective: "Réduire l'incidence du paludisme dans les communautés de Boffa, Gaoual et Koundara",
        result: "R2 — Causeries éducatives animées par les Animateurs-Superviseurs",
        indicator: "Nombre de causeries éducatives réalisées",
        target: 384,
        achieved: 107,
      },
      {
        projectId: project.id,
        objective: "Réduire l'incidence du paludisme dans les communautés de Boffa, Gaoual et Koundara",
        result: "R3 — Supervision des Agents Communautaires",
        indicator: "Nombre de supervisions réalisées",
        target: 384,
        achieved: 118,
      },
      {
        projectId: project.id,
        objective: "Réduire l'incidence du paludisme dans les communautés de Boffa, Gaoual et Koundara",
        result: "R4 — Réunions mensuelles dans les centres de santé",
        indicator: "Nombre de réunions mensuelles tenues",
        target: 92,
        achieved: 23,
      },
      {
        projectId: project.id,
        objective: "Réduire l'incidence du paludisme dans les communautés de Boffa, Gaoual et Koundara",
        result: "R5 — Sensibilisation de masse (jours de marché)",
        indicator: "Nombre de sensibilisations de masse organisées",
        target: 9,
        achieved: 6,
      },
    ],
  });

  // --- Affectations au projet ---
  await prisma.assignment.create({
    data: { staffId: staffCoordinateur.id, projectId: project.id, allocPct: 100, startDate: new Date("2017-01-01") },
  });
  await prisma.assignment.create({
    data: { staffId: staffLogistique.id, projectId: project.id, allocPct: 100, startDate: new Date("2017-01-01") },
  });
  await prisma.assignment.create({
    data: { staffId: staffDaf.id, projectId: project.id, allocPct: 50, startDate: new Date("2017-01-01") },
  });
  await prisma.assignment.create({
    data: { staffId: staffChauffeur.id, projectId: project.id, allocPct: 100, startDate: new Date("2017-01-01") },
  });

  // --- Fournisseur type ---
  const supplier = await prisma.supplier.create({
    data: { organizationId: org.id, name: "Boké Équipements & Fournitures" },
  });

  // --- Flotte : véhicule terrain + moto, chauffeur attitré ---
  const vehicle = await prisma.vehicle.create({
    data: { organizationId: org.id, type: "VOITURE", plateNumber: "RG-2201-A", brand: "Toyota", model: "Hilux", currentMileage: 48200 },
  });
  const moto = await prisma.vehicle.create({
    data: { organizationId: org.id, type: "MOTO", plateNumber: "RG-0654-C", brand: "Yamaha", model: "AG100", currentMileage: 22800 },
  });

  const driver = await prisma.driver.create({
    data: {
      organizationId: org.id,
      staffId: staffChauffeur.id,
      licenseNumber: "GN-PC-2017-0123",
      licenseExpiryDate: new Date("2028-03-15"),
    },
  });
  await prisma.vehicle.update({ where: { id: vehicle.id }, data: { assignedDriverId: driver.id } });
  await prisma.vehicleProjectAssignment.create({
    data: { vehicleId: vehicle.id, projectId: project.id, sharePct: 100 },
  });

  // --- Bibliothèque initiale de modèles de lettres ---
  // Jeu de départ réellement rédigé plutôt qu'un grand nombre de modèles
  // génériques : l'organisation enrichit ensuite cette bibliothèque avec ses
  // propres modèles au fil de l'usage (voir module Lettres de transmission).
  await prisma.letterTemplate.createMany({
    data: [
      {
        organizationId: org.id,
        category: "Bailleur",
        title: "Transmission de rapport d'activités",
        isSystem: true,
        bodySample:
          "Dans le cadre de la mise en œuvre du projet « {{nom_projet}} », je viens par la présente vous transmettre {{objet_rapport}}, de l'ONG Club Des Amis Du Monde (CAM).\n\nTout en vous souhaitant bonne réception, je vous prie de croire à notre sincère partenariat.\n\nSincères salutations.",
      },
      {
        organizationId: org.id,
        category: "Bailleur",
        title: "Lettre d'accompagnement d'une demande de paiement",
        isSystem: true,
        bodySample:
          "Dans le cadre du projet « {{nom_projet}} » (N° de subvention {{numero_subvention}}), veuillez trouver ci-joint notre demande de paiement pour le repère n° {{numero_repere}}.\n\nCette demande est accompagnée des justificatifs d'activités correspondants. Nous restons à votre disposition pour tout complément d'information.\n\nVeuillez agréer, Monsieur/Madame, l'expression de notre considération distinguée.",
      },
      {
        organizationId: org.id,
        category: "Bailleur",
        title: "Demande de prorogation de délai",
        isSystem: true,
        bodySample:
          "Nous sollicitons par la présente une prorogation de délai de {{duree_demandee}} pour la mise en œuvre des activités du projet « {{nom_projet}} », initialement prévues pour s'achever le {{date_initiale}}.\n\nCette demande se justifie par {{motif}}. Un plan d'action actualisé est joint à la présente.\n\nNous vous remercions de la compréhension que vous voudrez bien accorder à cette requête.",
      },
      {
        organizationId: org.id,
        category: "Fournisseur",
        title: "Notification de retard de livraison",
        isSystem: true,
        bodySample:
          "Nous constatons que la commande n° {{numero_commande}} concernant {{objet_commande}}, dont la livraison était prévue le {{date_prevue}}, n'a pas encore été honorée à ce jour.\n\nNous vous prions de bien vouloir nous communiquer sous quinzaine un nouveau délai ferme de livraison, faute de quoi nous nous réservons le droit de reconsidérer notre engagement.\n\nDans l'attente de votre retour rapide.",
      },
      {
        organizationId: org.id,
        category: "Fournisseur",
        title: "Mise en demeure",
        isSystem: true,
        bodySample:
          "Par la présente, nous vous mettons en demeure d'exécuter vos obligations relatives à {{objet_obligation}}, conformément aux termes de {{reference_contrat}}, et ce dans un délai de {{delai}} à compter de la réception de ce courrier.\n\nÀ défaut, nous nous verrons contraints d'engager les mesures que la situation impose, sans préjudice de tout recours ultérieur.",
      },
      {
        organizationId: org.id,
        category: "Partenaire",
        title: "Lettre de remerciement",
        isSystem: true,
        bodySample:
          "Au nom de l'ONG Club Des Amis Du Monde (CAM) et des communautés bénéficiaires, nous tenons à vous exprimer notre profonde gratitude pour {{motif_remerciement}}.\n\nVotre appui a été déterminant dans {{impact_realise}}. Nous espérons pouvoir compter sur la poursuite de cette collaboration fructueuse.\n\nAvec nos sincères remerciements.",
      },
      {
        organizationId: org.id,
        category: "Partenaire",
        title: "Demande d'audience",
        isSystem: true,
        bodySample:
          "Nous sollicitons une audience auprès de {{destinataire}} afin d'échanger sur {{objet_audience}}.\n\nNous restons disponibles à la date et l'heure qui vous conviendront, et vous remercions par avance de l'attention que vous voudrez bien porter à notre requête.",
      },
      {
        organizationId: org.id,
        category: "Partenaire",
        title: "Invitation à un atelier / une formation",
        isSystem: true,
        bodySample:
          "Nous avons l'honneur de vous inviter à prendre part à {{nom_evenement}}, qui se tiendra le {{date_evenement}} à {{lieu_evenement}}.\n\nCette rencontre portera sur {{theme}}. Votre participation, forte de votre expertise, constituerait un apport précieux aux échanges.\n\nNous espérons vivement compter sur votre présence.",
      },
      {
        organizationId: org.id,
        category: "RH",
        title: "Convocation à un entretien",
        isSystem: true,
        bodySample:
          "Nous vous prions de bien vouloir vous présenter le {{date_entretien}} à {{heure_entretien}} dans nos bureaux, pour un entretien relatif à {{objet_entretien}}.\n\nMerci de confirmer votre disponibilité par retour de courrier.",
      },
      {
        organizationId: org.id,
        category: "RH",
        title: "Avertissement disciplinaire",
        isSystem: true,
        bodySample:
          "Nous avons constaté les faits suivants : {{description_faits}}, survenus le {{date_faits}}, qui constituent un manquement à {{regle_enfreinte}}.\n\nCes faits nous conduisent à vous notifier un avertissement. Nous vous invitons à veiller au strict respect des règles applicables au sein de l'organisation à l'avenir.",
      },
      {
        organizationId: org.id,
        category: "RH",
        title: "Attestation de travail",
        isSystem: true,
        bodySample:
          "Nous soussignés, ONG Club Des Amis Du Monde (CAM), attestons que {{nom_employe}} a été employé(e) au sein de notre organisation en qualité de {{fonction}}, du {{date_debut}} au {{date_fin_ou_a_ce_jour}}.\n\nCette attestation est délivrée à l'intéressé(e) pour servir et valoir ce que de droit.",
      },
      {
        organizationId: org.id,
        category: "RH",
        title: "Lettre de recommandation",
        isSystem: true,
        bodySample:
          "C'est avec plaisir que je recommande {{nom_employe}}, qui a exercé les fonctions de {{fonction}} au sein de notre organisation du {{date_debut}} au {{date_fin}}.\n\nDurant cette période, {{nom_employe}} a fait preuve de {{qualites}}. Je suis convaincu(e) qu'il/elle saura apporter une contribution précieuse à toute organisation qui l'accueillera.\n\nJe reste à disposition pour tout renseignement complémentaire.",
      },
      {
        organizationId: org.id,
        category: "RH",
        title: "Notification de fin de contrat",
        isSystem: true,
        bodySample:
          "Nous vous informons par la présente que votre contrat de travail, arrivant à échéance le {{date_fin_contrat}}, ne sera pas renouvelé / prendra fin conformément aux termes convenus.\n\nVous voudrez bien vous rapprocher du service administratif pour le règlement des formalités de départ.\n\nNous vous remercions pour votre engagement au sein de notre organisation.",
      },
      {
        organizationId: org.id,
        category: "Administration",
        title: "Demande d'autorisation d'activité terrain",
        isSystem: true,
        bodySample:
          "Dans le cadre du projet « {{nom_projet}} », nous sollicitons votre autorisation pour la conduite de {{nature_activite}} dans {{localite}}, prévue le {{date_activite}}.\n\nCette activité vise {{objectif_activite}} et sera conduite par notre équipe en coordination avec les autorités locales.\n\nNous vous remercions de votre collaboration habituelle.",
      },
    ],
  });

  console.log("Seed terminé :");
  console.log({
    organizationId: org.id,
    projectId: project.id,
    supplierId: supplier.id,
    vehicleId: vehicle.id,
    motoId: moto.id,
    driverId: driver.id,
  });
  console.log("");
  console.log("Comptes de connexion (mot de passe pour tous : motdepasse123) :");
  console.log("  Président (Admin)      : president@amisdumonde-cam.org");
  console.log("  Coordinateur           : coordination@amisdumonde-cam.org");
  console.log("  DAF (Comptable)        : daf@amisdumonde-cam.org");
  console.log("  Logistique             : logistique@amisdumonde-cam.org");
  console.log("");
  console.log("Alhouseine Maiga (Chauffeur) a une fiche employé + chauffeur, sans compte de connexion.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
