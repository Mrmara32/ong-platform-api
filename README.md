# ONG Platform API

Backend Express + TypeScript + Prisma pour la plateforme multi-tenant de gestion
de projets ONG. Implémente les modules Projets, Finances/Comptabilité (SYCEBNL),
Logistique (achats, stocks, véhicules, carburant, maintenance), RH et
Documents/Partage inter-ONG décrits dans le cahier des charges.

## Installation

```bash
npm install
cp .env.example .env   # renseigner DATABASE_URL (PostgreSQL) et JWT_SECRET
npx prisma generate
npx prisma migrate dev --name init
npm run seed            # crée une organisation, un utilisateur admin et un projet de test
npm run dev              # démarre l'API sur http://localhost:4000
```

Identifiants créés par le seed : `admin@sahelops.org` / `motdepasse123`

## Architecture

```
src/
  lib/prisma.ts              client Prisma partagé
  middleware/auth.ts          JWT + contexte multi-tenant (requireAuth, requireRole)
  services/accounting.service.ts   TOUTE écriture comptable et mise à jour
                               des lignes budgétaires passe par ce service —
                               c'est le point d'automatisation central du
                               cahier des charges (§2.4, §2.5.1, §2.5.6, §2.5.7)
  routes/
    auth.routes.ts             connexion, inscription, invitations (consultation + acceptation publiques), sélection d'organisation
    members.routes.ts          liste des membres, envoi/révocation d'invitations, changement de rôle — réservé à l'Admin
    projects.routes.ts         projets, cadre logique, partenaires
    finance.routes.ts          lignes budgétaires, dépenses, décaissements, journal
    logistics.routes.ts        commandes, stocks, véhicules, trajets, carburant, maintenance, paiement fournisseur
    invoices.routes.ts         facturation des prestations de service, encaissement multicanal
    payroll.routes.ts          bulletins de paie, paiement multicanal, partage email/WhatsApp
    export.routes.ts           export PDF / Word (.docx) / Excel (.xlsx) de tous les contenus
    fleet.routes.ts            module Flotte (véhicules, motos, engins) — RÉSERVÉ à ADMIN/LOGISTICIEN, y compris en lecture
    equipment.routes.ts        matériel divers (PC, licences antivirus...) et alertes de maintenance
    hr.routes.ts                personnel, affectations, coût imputé
    documents.routes.ts        TDR/rapports, partage inter-ONG
  middleware/
    auth.ts                     JWT + contexte multi-tenant
    access.ts                   résolution de la portée d'accès par projet (espace personnel vs vue complète)
```

## Principes clés implémentés

- **Isolation multi-tenant** : chaque route filtre par `organizationId` extrait
  du token JWT — jamais par une valeur envoyée par le client.
- **Comptabilisation automatique** : `accounting.service.ts` centralise la
  création des écritures (`JournalEntry`) et la mise à jour du disponible
  (`BudgetLine.spent`) pour les dépenses, décaissements, livraisons de
  commandes, pleins de carburant et interventions de maintenance.
- **Décaissements liés au budget** : impossible d'enregistrer une dépense ou
  un décaissement sans `budgetLineId` ; le disponible est recalculé et
  renvoyé (`exceeds: true` si dépassement) pour piloter l'alerte côté client.
- **Mode hors-ligne (PWA)** : `Expense`, `Disbursement`, `FuelLog` et
  `JournalEntry` portent un champ `syncStatus` (`SYNCED` / `PENDING_SYNC` /
  `CONFLICT`) pour que le client puisse poster des écritures créées hors-ligne
  et les faire résoudre à la synchronisation.
- **Partage inter-ONG** : `POST /documents/:id/share` est le seul moyen de
  rendre un document visible par une organisation partenaire — jamais par défaut.
- **Facturation** : `POST /invoices` émet une facture numérotée séquentiellement
  par organisation (`FAC-2026-0001`...) ; `POST /invoices/:id/payments` enregistre
  l'encaissement (tous canaux) et bascule automatiquement la facture en `PAYEE`.
- **Paiements multicanal** : un même modèle `Payment` couvre les paiements
  fournisseurs (`POST /logistics/supplier-payments`), les encaissements de
  facture et la paie — chacun avec `method` (`VIREMENT`, `ORANGE_MONEY`,
  `MTN_MONEY`, `MOOV_MONEY`, `WAVE`, `ESPECES`, `CHEQUE`) et une `reference`
  de transaction pour le rapprochement. Chaque canal est comptabilisé sur son
  propre sous-compte de trésorerie SYCEBNL (banque vs. mobile money par opérateur).
- **Bulletins de paie** : `POST /payroll/payslips` génère le bulletin (net =
  base + primes - retenues), `POST /payroll/payslips/:id/pay` déclenche le
  paiement (et l'écriture comptable) sur le canal choisi, et
  `POST /payroll/payslips/:id/share` envoie réellement le PDF par email via
  SMTP (`lib/mailer.ts`, configurable par variables d'environnement — voir
  `.env.example`) ou renvoie un lien `wa.me` pré-rempli pour WhatsApp. Le PDF
  est généré à la volée par `services/pdf.service.ts`, réutilisé aussi par
  l'export téléchargeable pour éviter toute duplication du template. Sans
  configuration SMTP, l'envoi est simulé et tracé en log (pratique en dev).
- **Export multi-format** : `export.routes.ts` génère à la volée des PDF
  (pdfkit — documents, factures, bulletins de paie), des Word .docx (docx —
  documents éditables) et des Excel .xlsx (exceljs — budget, journal
  comptable, parc véhicules), directement depuis les données de la base,
  sans étape de conversion intermédiaire.
- **Hiérarchie d'accès / espace personnel** : `middleware/access.ts` calcule
  la portée d'un utilisateur sur un projet (`COMPLET` ou `PERSONNEL`) via le
  modèle `ProjectMembership`. L'Admin/Président de l'organisation a toujours
  un accès `COMPLET`, sans configuration supplémentaire. `GET /projects/:id/activities`
  illustre le filtrage : en portée `PERSONNEL`, seules les activités dont
  l'utilisateur est `owner` sont renvoyées.
- **Module Flotte cloisonné** : `fleet.routes.ts` applique
  `router.use(requireRole("ADMIN", "LOGISTICIEN"))` sur l'ensemble du routeur
  — contrairement au reste de la Logistique, même les endpoints de lecture
  (`GET /fleet/vehicles`, `/trips`, `/fuel-logs`, `/maintenances`, `/alerts`,
  `/dashboard`) sont inaccessibles à tout autre rôle. Chaque véhicule a un
  `type` (`VOITURE`, `MOTO`, `ENGIN`, `AUTRE`) ; `GET /fleet/vehicles/:id`
  renvoie un historique chronologique unifié (déplacements + carburant +
  maintenance) en un seul appel. Les alertes de maintenance (`alerts.service.ts`,
  partagé avec le module Équipements) couvrent aussi bien le kilométrage que
  les échéances calendaires — utile pour un engin peu utilisé mais suivi en
  heures moteur ou en dates fixes plutôt qu'en kilomètres.
- **Invitation de collaborateurs** : seul l'Admin/Président peut inviter
  (`POST /members/invite`) ; l'email envoyé (réel ou simulé selon SMTP)
  contient un lien avec un token à usage unique, valable 7 jours.
  `GET /auth/invitations/:token` (public) permet à l'écran d'acceptation
  d'afficher l'organisation et le rôle avant engagement ;
  `POST /auth/invitations/:token/accept` crée le compte si nécessaire (ou
  vérifie le mot de passe d'un compte existant) puis rattache directement le
  `Membership`. Un garde-fou empêche de retirer ou rétrograder le dernier
  Admin d'une organisation.

- **Chauffeur = employé, toujours** : `Driver.staffId` référence obligatoirement
  un `Staff` existant (un employé ne peut avoir qu'une seule fiche chauffeur).
  `Vehicle.assignedDriverId` porte l'affectation permanente chauffeur↔véhicule ;
  `Trip.driverId` reste ponctuel et peut exceptionnellement différer.
- **Affectation/location à un projet** : `VehicleProjectAssignment` (avec
  `sharePct` pour un usage partagé) détermine qui est prévenu en cas de panne.
- **Consommation carburant** : `services/fuel.service.ts` calcule le L/100km
  de chaque plein et signale une anomalie au-delà de 130% de la moyenne
  historique du véhicule — retourné immédiatement dans la réponse de
  `POST /fleet/fuel-logs`, et consultable via
  `GET /fleet/vehicles/:id/fuel-consumption`.
- **Signalement de panne** : `POST /fleet/vehicles/:id/report-breakdown`
  bascule le véhicule en `HORS_SERVICE` et notifie IMMÉDIATEMENT (email +
  `Notification` type `PANNE_VEHICULE`) les responsables de CHAQUE projet
  auquel il est affecté (`ProjectMembership.role = RESPONSABLE`), en plus du
  Logisticien/Admin — c'est le mécanisme demandé pour que les responsables
  de projet sachent qu'un engin qu'ils utilisent est indisponible, sans
  attendre le calcul différé des alertes de maintenance planifiée.

- **Gestion complète des chauffeurs** : `GET/PATCH/DELETE /fleet/drivers/:id`
  complètent la liste et la création déjà en place — fiche détail (véhicules
  attitrés + historique de trajets), modification du permis, retrait du
  statut chauffeur (bloqué si un véhicule lui est encore attitré). L'échéance
  du permis alimente désormais aussi `computeAlerts` (même seuil de 15 jours
  que le reste de la flotte), remontée dans `GET /fleet/alerts`.

## Trous comblés lors d'une revue de complétude

Une passe de vérification a révélé plusieurs endpoints/écrans manquants,
malgré un modèle de données déjà prêt à les recevoir :

- **Fournisseurs** : `GET/POST /logistics/suppliers` n'existaient pas du tout —
  impossible jusqu'ici de créer une commande sans passer directement par la
  base de données. Ajoutés.
- **Création d'employé côté frontend** : la route `POST /hr/staff` existait
  déjà côté API mais n'était appelée nulle part côté client, et n'acceptait
  pas `email`/`phone` — pourtant nécessaires pour déclarer un chauffeur et
  partager les bulletins de paie. Le schéma de validation les accepte
  désormais.
- **Équipe par projet** : `GET/DELETE /projects/:id/members` complètent le
  `POST` déjà en place — un Responsable de projet peut désormais consulter
  et retirer les membres explicitement rattachés à son projet (distinct de
  l'équipe organisationnelle gérée par `members.routes.ts`).

## Tests

Le dossier `tests/` contient des tests unitaires (Vitest) sur la logique
métier pure — numérotation des factures, disponibilité budgétaire, filtrage
par portée d'accès — qui tournent sans base de données. Voir `tests/README.md`
pour le détail et pour la marche à suivre concernant les tests d'intégration
bout-en-bout (qui nécessitent une vraie base PostgreSQL).

```bash
npm run test
```

## Prochaines étapes suggérées

- Ajouter les tests d'intégration (Vitest/Supertest) sur les endpoints financiers
- Générer les états financiers SYCEBNL (bilan, compte de résultat) à partir de `JournalEntry`
- Implémenter le moteur de synchronisation offline côté client (voir prototype React)
- Ajouter la pagination sur `/finance/journal` et `/logistics/purchase-orders`
