import nodemailer from "nodemailer";

/**
 * Transport SMTP configuré via variables d'environnement. Fonctionne avec
 * n'importe quel fournisseur SMTP standard (Gmail/Google Workspace, Sendgrid,
 * Mailgun, Office 365, un serveur SMTP interne...). En l'absence de
 * configuration (ex. environnement de développement sans SMTP), l'envoi est
 * simulé et loggé en console plutôt que de faire échouer la requête —
 * pratique pour tester le flux sans dépendance externe.
 */
const isConfigured = Boolean(process.env.SMTP_HOST);

const transporter = isConfigured
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT ?? 587),
      secure: process.env.SMTP_SECURE === "true",
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
    })
  : null;

export interface SendMailInput {
  to: string;
  subject: string;
  text: string;
  attachments?: { filename: string; content: Buffer; contentType?: string }[];
}

export async function sendMail(input: SendMailInput): Promise<{ simulated: boolean; messageId?: string }> {
  if (!transporter) {
    // Pas de SMTP configuré : on trace l'intention d'envoi sans bloquer le flux.
    console.log(`[mailer] SMTP non configuré — email simulé vers ${input.to} : "${input.subject}"`);
    return { simulated: true };
  }

  const result = await transporter.sendMail({
    from: process.env.SMTP_FROM ?? "no-reply@plateforme-ong.org",
    to: input.to,
    subject: input.subject,
    text: input.text,
    attachments: input.attachments,
  });

  return { simulated: false, messageId: result.messageId };
}
