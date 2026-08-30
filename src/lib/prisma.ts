import { PrismaClient } from "@prisma/client";

// Instance unique du client Prisma, réutilisée dans toute l'application
export const prisma = new PrismaClient();
