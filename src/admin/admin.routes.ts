import type { Request, Response, NextFunction } from "express";
import express from "express";
import multer from "multer";
import crypto from "crypto";
import bcrypt from "bcrypt";
import { prisma } from "../db/prisma.js";
import { parseFenatsExcel } from "./excel.parse.js";
import { Prisma, AdminRole } from "@prisma/client";

const upload = multer({ storage: multer.memoryStorage() });
export const adminRouter = express.Router();

/**
 * TIPADO de session para evitar "as any"
 * (Solo funciona si ya tienes express-session configurado en server.ts)
 */
declare module "express-session" {
  interface SessionData {
    user?: {
      id: number;
      username: string;
      role: AdminRole;
    };
  }
}

/* =========================================================
   AUTH HELPERS (sesión + roles)
   ========================================================= */

/** Requiere sesión iniciada (cualquier rol) */
function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (req.session?.user) return next();
  return res.redirect("/admin/login");
}

/**
 * Requiere uno de estos roles.
 * Ej: requireRole([AdminRole.ADMIN, AdminRole.SUPERADMIN])
 */
function requireRole(roles: AdminRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const u = req.session?.user;
    if (!u) return res.redirect("/admin/login");
    if (!roles.includes(u.role)) return res.status(403).send("No autorizado");
    return next();
  };
}

/* =========================================================
   UTILIDADES (RUT / gender / token)
   ========================================================= */

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

/** Formatea un RUT normalizado (9313137-1) a 9.313.137-1 */
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

/* =========================================================
   LOGIN / LOGOUT (DB + bcrypt)
   ========================================================= */

/**
 * GET /admin/login
 * Muestra login. Si ya hay sesión, manda al panel.
 */
adminRouter.get("/login", (req, res) => {
  if (req.session?.user) return res.redirect("/admin");
  res.render("admin/login", { error: null });
});

/**
 * POST /admin/login
 * Valida contra AdminUser (DB) usando bcrypt.compare().
 */
adminRouter.post("/login", express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const username = String(req.body.username ?? "").trim();
    const password = String(req.body.password ?? "");

    if (!username || !password) {
      return res.status(400).render("admin/login", { error: "Falta usuario o contraseña." });
    }

    const user = await prisma.adminUser.findUnique({ where: { username } });

    // Mensaje genérico por seguridad
    if (!user || !user.isActive) {
      return res.status(401).render("admin/login", { error: "Credenciales inválidas." });
    }

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      return res.status(401).render("admin/login", { error: "Credenciales inválidas." });
    }

    // Guardamos lo mínimo en sesión
    req.session.user = { id: user.id, username: user.username, role: user.role };

    return res.redirect("/admin");
  } catch (e: any) {
    return res.status(500).render("admin/login", {
      error: `Error interno al iniciar sesión: ${String(e?.message ?? e)}`,
    });
  }
});

/**
 * GET /admin/logout
 * Cierra sesión.
 */
adminRouter.get("/logout", (req, res) => {
  if (req.session) req.session.user = undefined;
  res.redirect("/admin/login");
});

/* =========================================================
   PANEL / DASHBOARD
   ========================================================= */

/**
 * GET /admin
 * Dashboard: lo ve cualquier logeado (VIEWER/ADMIN/SUPERADMIN)
 */
adminRouter.get("/", requireAuth, async (_req, res) => {
  const total = await prisma.member.count();
  const active = await prisma.member.count({ where: { status: "ACTIVE" } });
  const inactive = await prisma.member.count({ where: { status: "INACTIVE" } });

  res.render("admin/dashboard", { total, active, inactive });
});

/* =========================================================
   USUARIOS ADMIN (solo SUPERADMIN)
   - Sin registro público: solo SUPERADMIN crea usuarios
   ========================================================= */

/**
 * GET /admin/users
 * Lista usuarios (solo SUPERADMIN)
 * Puedes renderizar: views/admin/users.ejs (si ya lo tienes)
 */
adminRouter.get("/users", requireRole([AdminRole.SUPERADMIN]), async (_req, res) => {
  const users = await prisma.adminUser.findMany({
    orderBy: { createdAt: "desc" },
    select: { id: true, username: true, role: true, isActive: true, createdAt: true, updatedAt: true },
    take: 200,
  });

  res.render("admin/users", { users, error: null, message: null });
});

/**
 * GET /admin/users/new
 * Renderiza el formulario para crear usuario (tu new-user.ejs)
 */
adminRouter.get("/users/new", requireRole([AdminRole.SUPERADMIN]), (_req, res) => {
  res.render("admin/new-user", { error: null, message: null, values: null });
});

/**
 * POST /admin/users/new
 * Crea un usuario nuevo desde el formulario new-user.ejs
 * Body: username, password, password2, role
 */
adminRouter.post(
  "/users/new",
  requireRole([AdminRole.SUPERADMIN]),
  express.urlencoded({ extended: true }),
  async (req, res) => {
    try {
      const username = String(req.body.username ?? "").trim();
      const password = String(req.body.password ?? "");
      const password2 = String(req.body.password2 ?? "");
      const roleRaw = String(req.body.role ?? "VIEWER").trim().toUpperCase();

      const role: AdminRole =
        roleRaw === "SUPERADMIN"
          ? AdminRole.SUPERADMIN
          : roleRaw === "ADMIN"
            ? AdminRole.ADMIN
            : AdminRole.VIEWER;

      // Validaciones
      if (!username || !password) {
        return res.status(400).render("admin/new-user", {
          error: "Falta usuario o contraseña.",
          message: null,
          values: req.body,
        });
      }

      if (password.length < 6) {
        return res.status(400).render("admin/new-user", {
          error: "La contraseña debe tener al menos 6 caracteres.",
          message: null,
          values: req.body,
        });
      }

      if (password !== password2) {
        return res.status(400).render("admin/new-user", {
          error: "Las contraseñas no coinciden.",
          message: null,
          values: req.body,
        });
      }

      // (Opcional) evita usernames raros
      if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) {
        return res.status(400).render("admin/new-user", {
          error: "Username inválido. Usa letras/números y . _ - (3 a 32).",
          message: null,
          values: req.body,
        });
      }

      // Hash bcrypt
      const passwordHash = await bcrypt.hash(password, 12);

      // Crear usuario (si el username ya existe, Prisma lanzará error)
      await prisma.adminUser.create({
        data: { username, passwordHash, role, isActive: true },
      });

      return res.render("admin/new-user", {
        error: null,
        message: `Usuario creado: ${username} (${role})`,
        values: null,
      });
    } catch (e: any) {
      // Mensaje amigable si es unique constraint
      const msg = String(e?.message ?? e);
      const friendly =
        msg.includes("Unique constraint") || msg.includes("unique") ? "Ese username ya existe." : msg;

      return res.status(400).render("admin/new-user", {
        error: `No se pudo crear: ${friendly}`,
        message: null,
        values: req.body,
      });
    }
  }
);

/**
 * POST /admin/users/:id/toggle
 * Activa/Inactiva un usuario admin (solo SUPERADMIN)
 */
adminRouter.post("/users/:id/toggle", requireRole([AdminRole.SUPERADMIN]), async (req, res) => {
  const id = Number(req.params.id);
  const user = await prisma.adminUser.findUnique({ where: { id } });
  if (!user) return res.status(404).send("No encontrado");

  // (Opcional) evita que te desactives a ti mismo
  if (req.session.user?.id === id) return res.status(400).send("No puedes desactivarte a ti mismo.");

  await prisma.adminUser.update({
    where: { id },
    data: { isActive: !user.isActive },
  });

  return res.redirect("/admin/users");
});

/**
 * POST /admin/users/:id/reset-password
 * Cambia password (solo SUPERADMIN)
 * Body: password
 */
adminRouter.post(
  "/users/:id/reset-password",
  requireRole([AdminRole.SUPERADMIN]),
  express.urlencoded({ extended: true }),
  async (req, res) => {
    const id = Number(req.params.id);
    const password = String(req.body.password ?? "");

    if (!password || password.length < 6) return res.status(400).send("Password inválida (min 6).");

    const passwordHash = await bcrypt.hash(password, 12);
    await prisma.adminUser.update({ where: { id }, data: { passwordHash } });

    return res.redirect("/admin/users");
  }
);

/* =========================================================
   IMPORTACIÓN EXCEL (solo ADMIN/SUPERADMIN)
   ========================================================= */

adminRouter.get("/upload", requireRole([AdminRole.ADMIN, AdminRole.SUPERADMIN]), (_req, res) => {
  res.render("admin/upload", { message: null, stats: null });
});

adminRouter.post(
  "/upload",
  requireRole([AdminRole.ADMIN, AdminRole.SUPERADMIN]),
  upload.single("file"),
  async (req: Request, res: Response) => {
    if (!req.file) {
      return res.render("admin/upload", { message: "No se subió archivo.", stats: null });
    }

    const affiliate = String(req.body.affiliate ?? "FENATS OCTAVA").trim();
    const importSource = String(req.body.importSource ?? "Arauco 12/2025").trim();

    const parsed = parseFenatsExcel(req.file.buffer);

    let created = 0;
    let updated = 0;
    let skipped = 0;

    for (const row of parsed) {
      const rut = normalizeRut(row.rutRaw);
      if (!rut) {
        skipped++;
        continue;
      }

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

/* =========================================================
   CRUD SOCIOS (solo ADMIN/SUPERADMIN)
   ========================================================= */

adminRouter.get("/new", requireRole([AdminRole.ADMIN, AdminRole.SUPERADMIN]), (_req, res) => {
  res.render("admin/new", { message: null, error: null, values: null });
});

adminRouter.post(
  "/new",
  requireRole([AdminRole.ADMIN, AdminRole.SUPERADMIN]),
  express.urlencoded({ extended: true }),
  async (req, res) => {
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

      const gender =
        genderRaw === "MALE" || genderRaw === "FEMALE" || genderRaw === "OTHER" ? genderRaw : null;

      const status = statusRaw === "INACTIVE" ? "INACTIVE" : "ACTIVE";

      const now = new Date();
      const importSource = `Manual (${req.session.user?.username ?? "Admin"})`;

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
  }
);

adminRouter.get("/members", requireRole([AdminRole.ADMIN, AdminRole.SUPERADMIN]), async (req, res) => {
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

adminRouter.post("/members/:id/toggle", requireRole([AdminRole.ADMIN, AdminRole.SUPERADMIN]), async (req, res) => {
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

adminRouter.post(
  "/members/:id/regen-token",
  requireRole([AdminRole.ADMIN, AdminRole.SUPERADMIN]),
  async (req, res) => {
    const id = Number(req.params.id);

    await prisma.member.update({
      where: { id },
      data: { token: newToken() },
    });

    res.redirect("/admin/members");
  }
);




