# Tests

## Ce qui tourne ici (sandbox sans réseau, sans base de données)

```bash
npm run test
```

15 tests unitaires (Vitest), tous passants, sur la logique métier pure :

- `invoice-numbering.test.ts` — numérotation séquentielle des factures
  (`FAC-2026-0001`...), isolation par organisation, remise à zéro par année
- `accounting.test.ts` — calcul du disponible budgétaire et détection de
  dépassement (`checkBudgetLineAvailability`)
- `access.test.ts` — hiérarchie d'accès : l'Admin/Président a toujours un
  accès `COMPLET` sans requête supplémentaire, un `RESPONSABLE` de projet a
  un accès complet même si sa portée enregistrée dit `PERSONNEL`, un simple
  `MEMBRE` est bien restreint à son propre périmètre

Ces tests mockent entièrement `lib/prisma` (via `vi.mock` + `vi.hoisted`)
pour ne jamais charger le vrai `PrismaClient`, qui exige `prisma generate` —
c'est ce qui permet de les exécuter sans base de données ni accès réseau.

## Ce qui nécessite ton environnement (réseau + PostgreSQL)

Le sandbox utilisé pour développer cette API a un accès réseau restreint qui
bloque `binaries.prisma.sh` (téléchargement du moteur Prisma) — impossible
d'y exécuter `prisma generate`, `prisma migrate`, ni de lancer le serveur
pour un vrai test de bout en bout. Chez toi (ou en CI avec accès réseau
complet), la marche à suivre est :

```bash
npm install
npx prisma generate
npx prisma migrate dev --name init
npm run seed
npm run dev          # démarre l'API sur http://localhost:4000
```

Puis, pour un test de bout en bout manuel minimal :

1. `POST /api/auth/login` avec `admin@sahelops.org` / `motdepasse123` → récupérer le token
2. `GET /api/projects` → noter l'id du projet créé par le seed
3. `GET /api/finance/projects/:id/budget-lines` → noter l'id d'une ligne
4. `POST /api/finance/expenses` avec cette ligne → vérifier que `spent` augmente et qu'une écriture apparaît dans `GET /api/finance/journal`
5. `POST /api/logistics/purchase-orders` puis `POST /api/logistics/purchase-orders/:id/deliver` → même vérification
6. `POST /api/payroll/payslips` puis `POST /api/payroll/payslips/:id/share` avec `{"channel":"email"}` → sans SMTP configuré, la réponse doit indiquer `simulated: true` et un log apparaît côté serveur ; avec SMTP configuré (voir `.env.example`), un vrai email doit arriver avec le PDF en pièce jointe

## Prochaine étape naturelle

Ajouter des tests d'intégration (Supertest) qui montent l'app Express avec
une vraie base PostgreSQL de test (ex. via `testcontainers` ou une base
dédiée en CI) pour couvrir les routes elles-mêmes, pas seulement les
fonctions de service. Le mocking utilisé ici est volontairement limité à la
logique pure — il ne remplace pas un test de bout en bout contre une vraie
base.
