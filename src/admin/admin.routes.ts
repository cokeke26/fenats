import type { Request, Response, NextFunction } from "express";
import express from "express";
import multer from "multer";
import crypto from "crypto";
import { prisma } from "../db/prisma.js";
import { parseFenatsExcel } from "./excel.parse.js";
import { Prisma } from "@prisma/client";

const upload = multer({ storage: multer.memoryStorage() });
export const adminRouter = express.Router();

function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if ((req as any).session?.admin === true) return next();
  return res.redirect("/admin/login");
}

/**
 * Limpia y normaliza un RUT al formato: 9313137-1
 * - Acepta con puntos, sin puntos, con/sin guion, con espacios.
 * - DV siempre en mayúscula.
 */
function normalizeRut(raw: string) {
  const s = String(raw ?? "").trim().toUpperCase();
  const compact = s.replace(/[^0-9K]/g, "");
  if (compact.length < 2) return "";

  const dv = compact.slice(-1);
  const num = compact.slice(0, -1).replace(/^0+/, "") || "0";
  return `${num}-${dv}`;
}

/**
 * Formatea un RUT normalizado (9313137-1) a 9.313.137-1
 */
function formatRut(rutNormalized: string) {
  const clean = normalizeRut(rutNormalized);
  const [num, dv] = clean.split("-");
  if (!num || !dv) return rutNormalized;

  const withDots = num.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${withDots}-${dv}`;
}

function genderMap(g: string | null) {
  const x = (g ?? "").toUpperCase();
  if (x.includes("FEM")) return "FEMALE";
  if (x.includes("MAS")) return "MALE";
  return null;
}

function newToken() {
  return crypto.randomBytes(16).toString("hex"); // 32 chars
}

/**
 * GET /admin/login
 */
adminRouter.get("/login", (_req, res) => {
  res.render("admin/login", { error: null });
});

/**
 * POST /admin/login
 */
adminRouter.post("/login", express.urlencoded({ extended: true }), (req, res) => {
  const pass = String(req.body.password ?? "");
  if (!process.env.ADMIN_PASSWORD) return res.status(500).send("Falta ADMIN_PASSWORD en .env");

  if (pass !== process.env.ADMIN_PASSWORD) {
    return res.status(401).render("admin/login", { error: "Clave incorrecta" });
  }

  (req as any).session.admin = true;
  res.redirect("/admin");
});

/**
 * GET /admin/logout
 */
adminRouter.get("/logout", (req, res) => {
  if ((req as any).session) (req as any).session.admin = false;
  res.redirect("/admin/login");
});

/**
 * GET /admin
 */
adminRouter.get("/", requireAdmin, async (_req, res) => {
  const total = await prisma.member.count();
  const active = await prisma.member.count({ where: { status: "ACTIVE" } });
  const inactive = await prisma.member.count({ where: { status: "INACTIVE" } });

  res.render("admin/dashboard", { total, active, inactive });
});

/**
 * GET /admin/upload
 */
adminRouter.get("/upload", requireAdmin, (_req, res) => {
  res.render("admin/upload", { message: null, stats: null });
});

/**
 * POST /admin/upload
 */
adminRouter.post(
  "/upload",
  requireAdmin,
  upload.single("file"),
  async (req: Request, res: Response) => {
    if (!req.file) {
      return res.render("admin/upload", { message: "No se subió archivo.", stats: null });
    }

    const affiliate = String(req.body.affiliate ?? "FENATS OCTAVA").trim();
    const importSource = String(req.body.importSource ?? "Arauco 12/2025").trim();

    const parsed = parseFenatsExcel(req.file.buffer);

    console.log("Filas parseadas:", parsed.length, parsed[0]);

    let created = 0;
    let updated = 0;
    let skipped = 0;

    for (const row of parsed) {
      const rut = normalizeRut(row.rutRaw);
      if (!rut) {
        skipped++;
        continue;
      }

      // rutMasked = RUT visible formateado (con puntos)
      const rutMasked = formatRut(rut);
      const gender = genderMap(row.genderText);

      const exists = await prisma.member.findUnique({ where: { rut } });

      if (!exists) {
        await prisma.member.create({
          data: {
            rut,
            rutMasked,
            fullName: row.fullName,
            affiliate,
            gender: (gender as any) ?? null,
            status: "ACTIVE",
            token: newToken(),
            lastImportAt: new Date(),
            importSource: `${affiliate} · ${importSource}`,
          },
        });
        created++;
      } else {
        await prisma.member.update({
          where: { rut },
          data: {
            fullName: row.fullName,
            rutMasked,
            affiliate,
            gender: (gender as any) ?? null,
            lastImportAt: new Date(),
            importSource: `${affiliate} · ${importSource}`,
          },
        });
        updated++;
      }
    }

    res.render("admin/upload", {
      message:
        skipped > 0
          ? `Importación completada (se omitieron ${skipped} filas sin RUT válido).`
          : "Importación completada.",
      stats: { totalRows: parsed.length, created, updated, skipped },
    });
  }
);

/**
 * GET /admin/new
 * Formulario para crear/actualizar 1 socio manualmente
 */
adminRouter.get("/new", requireAdmin, (_req, res) => {
  res.render("admin/new", { message: null, error: null, values: null });
});

/**
 * POST /admin/new
 * Crea o actualiza un socio por RUT (upsert manual)
 */
adminRouter.post("/new", requireAdmin, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const fullName = String(req.body.fullName ?? "").trim();
    const rutInput = String(req.body.rut ?? "").trim();
    const affiliate = String(req.body.affiliate ?? "").trim() || null;

    const genderRaw = String(req.body.gender ?? "").trim();
    const statusRaw = String(req.body.status ?? "ACTIVE").trim();

    if (!fullName) {
      return res.render("admin/new", { error: "Falta el nombre completo.", message: null, values: req.body });
    }

    const rut = normalizeRut(rutInput);
    if (!rut) {
      return res.render("admin/new", { error: "RUT inválido. Ej: 9.313.137-1", message: null, values: req.body });
    }

    const rutMasked = formatRut(rut);

    // gender opcional
    const gender =
      genderRaw === "MALE" || genderRaw === "FEMALE" || genderRaw === "OTHER" ? genderRaw : null;

    // status seguro
    const status = statusRaw === "INACTIVE" ? "INACTIVE" : "ACTIVE";

    const now = new Date();
    const importSource = "Manual (Admin)";

    const saved = await prisma.member.upsert({
      where: { rut },
      create: {
        fullName,
        rut,
        rutMasked,
        affiliate,
        gender: (gender as any) ?? null,
        status: status as any,
        token: newToken(),
        lastImportAt: now,
        importSource,
      },
      update: {
        fullName,
        rutMasked,
        affiliate,
        gender: (gender as any) ?? null,
        status: status as any,
        lastImportAt: now,
        importSource,
      },
    });

    return res.render("admin/new", {
      error: null,
      message: `Guardado OK: ${saved.fullName} (${saved.rutMasked}).`,
      values: null,
    });
  } catch (e: any) {
    return res.render("admin/new", {
      error: `Error al guardar: ${String(e?.message ?? e)}`,
      message: null,
      values: req.body,
    });
  }
});

/**
 * GET /admin/members?q=
 */
adminRouter.get("/members", requireAdmin, async (req, res) => {
  const q = String(req.query.q ?? "").trim();
  const qRut = q ? normalizeRut(q) : "";

  const where: Prisma.MemberWhereInput = q
    ? {
        OR: [
          ...(qRut ? [{ rut: { contains: qRut } }] : []),
          { rutMasked: { contains: q } },
          { fullName: { contains: q, mode: Prisma.QueryMode.insensitive } },
          { token: { contains: q } },
        ],
      }
    : {};

  const members = await prisma.member.findMany({
    where,
    orderBy: { updatedAt: "desc" },
    take: 200,
  });

  res.render("admin/members", { q, members });
});

/**
 * POST /admin/members/:id/toggle
 */
adminRouter.post("/members/:id/toggle", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const member = await prisma.member.findUnique({ where: { id } });
  if (!member) return res.status(404).send("No encontrado");

  const newStatus = member.status === "ACTIVE" ? "INACTIVE" : "ACTIVE";

  await prisma.member.update({
    where: { id },
    data: { status: newStatus },
  });

  res.redirect("/admin/members");
});

/**
 * POST /admin/members/:id/regen-token
 */
adminRouter.post("/members/:id/regen-token", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);

  await prisma.member.update({
    where: { id },
    data: { token: newToken() },
  });

  res.redirect("/admin/members");
});


