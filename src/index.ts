import "dotenv/config";
import express from "express";
import cors from "cors";
import { authRouter } from "./routes/auth.routes";
import { projectsRouter } from "./routes/projects.routes";
import { financeRouter } from "./routes/finance.routes";
import { logisticsRouter } from "./routes/logistics.routes";
import { hrRouter } from "./routes/hr.routes";
import { documentsRouter } from "./routes/documents.routes";
import { invoicesRouter } from "./routes/invoices.routes";
import { payrollRouter } from "./routes/payroll.routes";
import { exportRouter } from "./routes/export.routes";
import { equipmentRouter } from "./routes/equipment.routes";
import { fleetRouter } from "./routes/fleet.routes";
import { membersRouter } from "./routes/members.routes";
import { organizationsRouter } from "./routes/organizations.routes";
import { financialStatementsRouter } from "./routes/financial-statements.routes";
import { paymentRequestsRouter, lettersRouter } from "./routes/payment-requests.routes";

const app = express();
app.use(cors());
// Limite relevée à 2 Mo pour permettre l'envoi du logo de l'organisation en
// base64 (encodage base64 gonfle la taille réelle d'environ 33%) — le
// défaut d'Express (100 Ko) était bien trop restrictif et provoquait une
// erreur 413 sur tout logo, même compressé.
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req, res) => res.json({ status: "ok" }));

// Seule /api/auth est publique — toutes les autres routes exigent un token
// (requireAuth est appliqué à l'intérieur de chaque routeur) et filtrent
// systématiquement par l'organisation active du token, jamais par un
// paramètre fourni par le client.
app.use("/api/auth", authRouter);
app.use("/api/projects", projectsRouter);
app.use("/api/finance", financeRouter);
app.use("/api/logistics", logisticsRouter);
app.use("/api/hr", hrRouter);
app.use("/api/documents", documentsRouter);
app.use("/api/invoices", invoicesRouter);
app.use("/api/payroll", payrollRouter);
app.use("/api/export", exportRouter);
app.use("/api/logistics", equipmentRouter);
app.use("/api/fleet", fleetRouter);
app.use("/api/members", membersRouter);
app.use("/api/organizations", organizationsRouter);
app.use("/api/financial-statements", financialStatementsRouter);
app.use("/api/payment-requests", paymentRequestsRouter);
app.use("/api/letters", lettersRouter);

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`API en écoute sur http://localhost:${PORT}`);
});
