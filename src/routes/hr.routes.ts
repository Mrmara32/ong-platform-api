import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth, requireRole } from "../middleware/auth";

export const hrRouter = Router();
hrRouter.use(requireAuth);

hrRouter.get("/staff", async (req, res) => {
  const staff = await prisma.staff.findMany({
    where: { organizationId: req.auth!.organizationId },
    include: { assignments: true },
  });
  res.json(staff);
});

const staffSchema = z.object({
  fullName: z.string().min(2),
  jobTitle: z.string().min(2),
  monthlyCost: z.number().nonnegative(),
  email: z.string().email().optional(),
  phone: z.string().min(6).optional(),
});

hrRouter.post("/staff", requireRole("ADMIN", "RH"), async (req, res) => {
  const parsed = staffSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const staff = await prisma.staff.create({
    data: { ...parsed.data, organizationId: req.auth!.organizationId },
  });
  res.status(201).json(staff);
});

const assignmentSchema = z.object({
  staffId: z.string().uuid(),
  projectId: z.string().uuid(),
  allocPct: z.number().int().min(1).max(100),
  startDate: z.string(),
  endDate: z.string().optional(),
});

hrRouter.post("/assignments", requireRole("ADMIN", "RH"), async (req, res) => {
  const parsed = assignmentSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const data = parsed.data;

  const assignment = await prisma.assignment.create({
    data: {
      staffId: data.staffId,
      projectId: data.projectId,
      allocPct: data.allocPct,
      startDate: new Date(data.startDate),
      endDate: data.endDate ? new Date(data.endDate) : undefined,
    },
  });
  res.status(201).json(assignment);
});

// Coût mensuel de personnel imputé à un projet — utile pour le tableau de bord RH
hrRouter.get("/projects/:projectId/staffing-cost", async (req, res) => {
  const assignments = await prisma.assignment.findMany({
    where: { projectId: req.params.projectId },
    include: { staff: true },
  });
  const totalMonthlyCost = assignments.reduce(
    (sum, a) => sum + (Number(a.staff.monthlyCost) * a.allocPct) / 100,
    0
  );
  res.json({ assignments, totalMonthlyCost });
});
