import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

/**
 * Prisma n'accepte QUE les commentaires ligne (`//`) — jamais les
 * commentaires bloc (`/** ... *​/`). Ce bug est déjà revenu deux fois dans
 * ce projet (une fois lors du premier déploiement, une fois en ajoutant les
 * modèles PaymentRequest/LetterTemplate/Letter). Ce test échoue
 * immédiatement si un commentaire bloc est réintroduit, avant même de
 * tenter un déploiement.
 */
describe("schema.prisma — syntaxe des commentaires", () => {
  it("ne contient aucun commentaire bloc /* ... */ (invalide en Prisma, // uniquement)", () => {
    const schemaPath = path.join(__dirname, "..", "prisma", "schema.prisma");
    const content = fs.readFileSync(schemaPath, "utf-8");
    const hasBlockComment = /\/\*/.test(content);
    expect(hasBlockComment).toBe(false);
  });
});
