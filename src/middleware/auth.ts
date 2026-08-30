import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

export interface AuthPayload {
  userId: string;
  organizationId: string; // organisation "active" pour cette session
  role: string;
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthPayload;
    }
  }
}

const JWT_SECRET = process.env.JWT_SECRET || "change-me-in-production";

/**
 * Vérifie le token JWT et attache { userId, organizationId, role } à req.auth.
 * Toute route protégée doit passer par ce middleware avant d'accéder aux données.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Authentification requise" });
  }

  const token = header.slice("Bearer ".length);
  try {
    const payload = jwt.verify(token, JWT_SECRET) as AuthPayload;
    req.auth = payload;
    next();
  } catch {
    return res.status(401).json({ error: "Token invalide ou expiré" });
  }
}

/**
 * Restreint l'accès à certains rôles (ex. requireRole("ADMIN", "COMPTABLE")).
 * L'isolation multi-tenant elle-même est garantie en filtrant systématiquement
 * les requêtes Prisma par req.auth.organizationId dans chaque route — jamais
 * par un identifiant d'organisation fourni par le client.
 */
export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.auth || !roles.includes(req.auth.role)) {
      return res.status(403).json({ error: "Accès non autorisé pour ce rôle" });
    }
    next();
  };
}

export function signToken(payload: AuthPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "12h" });
}
