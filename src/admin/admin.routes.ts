import type { Request, Response, NextFunction } from "express";
import express from "express";
import multer from "multer";
import crypto from "crypto";
import bcrypt from "bcrypt";
import { prisma } from "../db/prisma.js";
import { parseFenatsExcel } from "./excel.parse.js";
import { Prisma, AdminRole } from "@prisma/client";
import { sendAdminOtpEmail } from "./mailer.js";

import rateLimit from "express-rate-limit";

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // ventana de 15 minutos
  max: 10,                   // máximo 10 intentos por IP
  message: "Demasiados intentos. Espera 15 minutos antes de intentar de nuevo.",
  standardHeaders: true,
  legacyHeaders: false,
});

const EXCEL_MIMES = [
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
  "application/vnd.ms-excel", // .xls
];

const uploadExcel = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (EXCEL_MIMES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Solo se permiten archivos Excel (.xlsx o .xls)."));
    }
  },
});

const uploadImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const IMAGE_MIMES = ["image/jpeg","image/png","image/webp","image/gif","image/svg+xml"];
    if (IMAGE_MIMES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Solo se permiten imágenes (JPG, PNG, WEBP, SVG)."));
    }
  },
});

export const adminRouter = express.Router();

declare module "express-session" {
  interface SessionData {
    user?: {
      id: number;
      username: string;
      role: AdminRole;
    };
    pending2fa?: {
      userId: number;
      username: string;
      createdAt: number;
      lastResendAt?: number;
    };
  }
}

/* =========================================================
   AUTH HELPERS
   ========================================================= */

function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (req.session?.user) return next();
  return res.redirect("/admin/login");
}

function requireRole(roles: AdminRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const u = req.session?.user;
    if (!u) return res.redirect("/admin/login");
    if (!roles.includes(u.role)) return res.status(403).send("No autorizado");
    return next();
  };
}

/* =========================================================
   VALIDACIONES
   ========================================================= */

function validateUsernameRut(username: string): string | null {
  const u = String(username ?? "").trim();
  if (!u) return "Falta usuario.";
  if (!/^\d+$/.test(u)) return "El usuario debe ser SOLO numérico (RUT sin DV).";
  if (u.length > 8) return "El usuario no puede superar 8 dígitos (RUT sin DV).";
  if (u.length < 7) return "El usuario debe tener al menos 7 dígitos (RUT sin DV).";
  return null;
}

function validateStrongPassword(pw: string): string | null {
  const p = String(pw ?? "");
  if (!p) return "Falta contraseña.";
  if (p.length < 8) return "Password débil: mínimo 8 caracteres.";
  if (!/[A-Z]/.test(p)) return "Password débil: debe incluir 1 letra MAYÚSCULA.";
  if (!/[0-9]/.test(p)) return "Password débil: debe incluir 1 número.";
  if (!/[^a-zA-Z0-9]/.test(p)) return "Password débil: debe incluir 1 símbolo (ej: !@#$%).";
  return null;
}

function normalizeEmail(raw: string) {
  return String(raw ?? "").trim().toLowerCase();
}

function isValidEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(email);
}

/* =========================================================
   2FA (OTP por correo)
   ========================================================= */

// ✅ FIX: usar crypto.randomInt en lugar de Math.random()
function generateOtpCode() {
  return crypto.randomInt(100000, 1000000).toString();
}

async function createAndSendOtp(userId: number, email: string) {
  await prisma.adminOtp.deleteMany({ where: { userId } });

  const code = generateOtpCode();
  const codeHash = await bcrypt.hash(code, 10);
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  await prisma.adminOtp.create({
    data: { userId, codeHash, expiresAt },
  });

  await sendAdminOtpEmail(email, code);
}

/* =========================================================
   UTILIDADES
   ========================================================= */

function normalizeRut(raw: string) {
  const s = String(raw ?? "").trim().toUpperCase();
  const compact = s.replace(/[^0-9K]/g, "");
  if (compact.length < 2) return "";
  const dv = compact.slice(-1);
  const num = compact.slice(0, -1).replace(/^0+/, "") || "0";
  return `${num}-${dv}`;
}

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
  return crypto.randomBytes(16).toString("hex");
}

// ✅ FIX: helper para no repetir findMany de adminUser 4 veces
async function fetchAdminUsers() {
  return prisma.adminUser.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      username: true,
      role: true,
      isActive: true,
      phone: true,
      email: true,
      createdAt: true,
      updatedAt: true,
    },
    take: 200,
  });
}

// Helper para cargar fotos + convenios juntos
async function fetchPhotosAndConvenios() {
  return Promise.all([
    prisma.photo.findMany({ orderBy: { createdAt: "desc" } }),
    prisma.convenio.findMany({ orderBy: { createdAt: "desc" } }),
  ]);
}

/* =========================================================
   LOGIN / LOGOUT + 2FA
   ========================================================= */

adminRouter.get("/login", (req, res) => {
  if (req.session?.user) return res.redirect("/admin");
  res.render("admin/login", { error: null });
});

adminRouter.post("/login", loginLimiter, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const username = String(req.body.username ?? "").trim();
    const password = String(req.body.password ?? "");

    if (!username || !password) {
      return res.status(400).render("admin/login", { error: "Falta usuario o contraseña." });
    }

    const user = await prisma.adminUser.findUnique({ where: { username } });

    if (!user || !user.isActive) {
      return res.status(401).render("admin/login", { error: "Credenciales inválidas." });
    }

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      return res.status(401).render("admin/login", { error: "Credenciales inválidas." });
    }

    if (!user.email) {
      return res.status(400).render("admin/login", {
        error: "Tu usuario no tiene correo configurado. Contacta al SUPERADMIN.",
      });
    }

    req.session.user = undefined;
    req.session.pending2fa = {
      userId: user.id,
      username: user.username,
      createdAt: Date.now(),
      lastResendAt: Date.now(),
    };

    // ✅ En desarrollo, completar login directamente sin OTP
    if (process.env.NODE_ENV !== "production") {
      req.session.user = {
        id: user.id,
        username: user.username,
        role: user.role,
      };
      req.session.pending2fa = undefined;
      return res.redirect("/admin");
    }

    await createAndSendOtp(user.id, user.email);
    return res.redirect("/admin/otp");
  } catch (e: any) {
    return res.status(500).render("admin/login", {
      error: `Error interno al iniciar sesión: ${String(e?.message ?? e)}`,
    });
  }
});

adminRouter.get("/otp", (req, res) => {
  if (req.session?.user) return res.redirect("/admin");
  if (!req.session?.pending2fa) return res.redirect("/admin/login");
  res.render("admin/otp", { error: null, message: null });
});

adminRouter.post("/otp", loginLimiter, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const pending = req.session.pending2fa;
    if (!pending) return res.redirect("/admin/login");

    // ✅ FIX: validar que pending2fa no haya expirado (15 min)
    if (Date.now() - pending.createdAt > 15 * 60 * 1000) {
      req.session.pending2fa = undefined;
      return res.redirect("/admin/login");
    }

    const code = String(req.body.code ?? "").trim();
    if (!/^\d{6}$/.test(code)) {
      return res.status(400).render("admin/otp", {
        error: "Código inválido. Debe ser de 6 dígitos.",
        message: null,
      });
    }

    const otp = await prisma.adminOtp.findFirst({
      where: { userId: pending.userId },
      orderBy: { createdAt: "desc" },
    });

    if (!otp) {
      return res.status(400).render("admin/otp", {
        error: "No hay un código activo. Reintenta el login.",
        message: null,
      });
    }

    if (otp.expiresAt.getTime() < Date.now()) {
      return res.status(400).render("admin/otp", {
        error: "Código expirado. Reintenta el login.",
        message: null,
      });
    }

    const attempts = Number(otp.attempts ?? 0);
    if (attempts >= 5) {
      return res.status(429).render("admin/otp", {
        error: "Demasiados intentos. Reintenta el login.",
        message: null,
      });
    }

    const ok = await bcrypt.compare(code, otp.codeHash);

    await prisma.adminOtp.update({
      where: { id: otp.id },
      data: { attempts: { increment: 1 } },
    });

    if (!ok) {
      return res.status(400).render("admin/otp", { error: "Código incorrecto.", message: null });
    }

    const user = await prisma.adminUser.findUnique({ where: { id: pending.userId } });
    if (!user || !user.isActive) return res.redirect("/admin/login");

    req.session.user = { id: user.id, username: user.username, role: user.role };
    req.session.pending2fa = undefined;

    await prisma.adminOtp.deleteMany({ where: { userId: user.id } });
    return res.redirect("/admin");
  } catch (e: any) {
    return res.status(500).render("admin/otp", {
      error: `Error verificando código: ${String(e?.message ?? e)}`,
      message: null,
    });
  }
});

adminRouter.post("/otp/resend", express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const pending = req.session.pending2fa;
    if (!pending) return res.redirect("/admin/login");

    const now = Date.now();
    const last = pending.lastResendAt ?? 0;
    if (now - last < 45_000) {
      return res.status(429).render("admin/otp", {
        error: "Espera unos segundos antes de reenviar el código.",
        message: null,
      });
    }

    const user = await prisma.adminUser.findUnique({ where: { id: pending.userId } });
    if (!user?.email) return res.redirect("/admin/login");

    pending.lastResendAt = now;
    await createAndSendOtp(user.id, user.email);

    return res.render("admin/otp", { error: null, message: "Código reenviado al correo ✅" });
  } catch (e: any) {
    return res.status(500).render("admin/otp", {
      error: `No se pudo reenviar: ${String(e?.message ?? e)}`,
      message: null,
    });
  }
});

// ✅ FIX: session.destroy() en lugar de borrar campos manualmente
adminRouter.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/admin/login"));
});

/* =========================================================
   DASHBOARD
   ========================================================= */

adminRouter.get("/", requireAuth, async (req, res) => {
  try {
    const total    = await prisma.member.count();
    const active   = await prisma.member.count({ where: { status: "ACTIVE" } });
    const inactive = await prisma.member.count({ where: { status: "INACTIVE" } });
    const posts    = await prisma.post.count({ where: { published: true } });
    const photos   = await prisma.photo.count();

    res.render("admin/dashboard", {
      total, active, inactive, posts, photos,
      role: req.session.user?.role ?? "VIEWER",
    });
  } catch (e: any) {
    res.status(500).send(`Error cargando dashboard: ${String(e?.message ?? e)}`);
  }
});

/* =========================================================
   USUARIOS ADMIN (solo SUPERADMIN)
   ========================================================= */

adminRouter.get("/users", requireRole([AdminRole.SUPERADMIN]), async (req, res) => {
  try {
    const users = await fetchAdminUsers();
    res.render("admin/users", {
      users,
      error: null,
      message: null,
      role: req.session.user?.role ?? "VIEWER",
    });
  } catch (e: any) {
    res.status(500).send(`Error cargando usuarios: ${String(e?.message ?? e)}`);
  }
});

adminRouter.get("/users/new", requireRole([AdminRole.SUPERADMIN]), (_req, res) => {
  res.render("admin/new-user", { error: null, message: null, values: null });
});

adminRouter.post(
  "/users/new",
  requireRole([AdminRole.SUPERADMIN]),
  express.urlencoded({ extended: true }),
  async (req, res) => {
    try {
      const username  = String(req.body.username ?? "").trim();
      const password  = String(req.body.password ?? "");
      const password2 = String(req.body.password2 ?? "");
      const roleRaw   = String(req.body.role ?? "VIEWER").trim().toUpperCase();
      const email     = normalizeEmail(req.body.email ?? "");

      const role: AdminRole =
        roleRaw === "SUPERADMIN"
          ? AdminRole.SUPERADMIN
          : roleRaw === "ADMIN"
          ? AdminRole.ADMIN
          : AdminRole.VIEWER;

      if (!email) {
        return res.status(400).render("admin/new-user", { error: "Falta el correo.", message: null, values: req.body });
      }
      if (!isValidEmail(email)) {
        return res.status(400).render("admin/new-user", { error: "Correo inválido.", message: null, values: req.body });
      }

      const userErr = validateUsernameRut(username);
      if (userErr) {
        return res.status(400).render("admin/new-user", { error: userErr, message: null, values: req.body });
      }

      const passErr = validateStrongPassword(password);
      if (passErr) {
        return res.status(400).render("admin/new-user", { error: passErr, message: null, values: req.body });
      }

      if (password !== password2) {
        return res.status(400).render("admin/new-user", {
          error: "Las contraseñas no coinciden.",
          message: null,
          values: req.body,
        });
      }

      const passwordHash = await bcrypt.hash(password, 12);

      await prisma.adminUser.create({
        data: { username, email, passwordHash, role, isActive: true },
      });

      return res.render("admin/new-user", {
        error: null,
        message: `Usuario creado: ${username} (${role})`,
        values: null,
      });
    } catch (e: any) {
      const msg   = String(e?.message ?? e);
      const lower = msg.toLowerCase();
      let friendly = msg;
      if (lower.includes("unique") && lower.includes("username")) friendly = "Ese usuario ya existe.";
      if (lower.includes("unique") && lower.includes("email"))    friendly = "Ese correo ya existe.";
      return res.status(400).render("admin/new-user", {
        error: `No se pudo crear: ${friendly}`,
        message: null,
        values: req.body,
      });
    }
  }
);

adminRouter.post("/users/:id/toggle", requireRole([AdminRole.SUPERADMIN]), async (req, res) => {
  try {
    const id   = Number(req.params.id);
    const user = await prisma.adminUser.findUnique({ where: { id } });
    if (!user) return res.status(404).send("No encontrado");

    if (req.session.user?.id === id) {
      const users = await fetchAdminUsers();
      return res.status(400).render("admin/users", {
        users,
        error: "No puedes desactivarte a ti mismo.",
        message: null,
        role: req.session.user?.role ?? "VIEWER",
      });
    }

    await prisma.adminUser.update({ where: { id }, data: { isActive: !user.isActive } });
    return res.redirect("/admin/users");
  } catch (e: any) {
    res.status(500).send(`Error actualizando usuario: ${String(e?.message ?? e)}`);
  }
});

adminRouter.post(
  "/users/:id/reset-password",
  requireRole([AdminRole.SUPERADMIN]),
  express.urlencoded({ extended: true }),
  async (req, res) => {
    try {
      const id       = Number(req.params.id);
      const password = String(req.body.password ?? "");

      const passErr = validateStrongPassword(password);
      if (passErr) {
        const users = await fetchAdminUsers();
        return res.status(400).render("admin/users", {
          users,
          error: passErr,
          message: null,
          role: req.session.user?.role ?? "VIEWER",
        });
      }

      const passwordHash = await bcrypt.hash(password, 12);
      await prisma.adminUser.update({ where: { id }, data: { passwordHash } });

      const users = await fetchAdminUsers();
      return res.render("admin/users", {
        users,
        error: null,
        message: "Contraseña reseteada correctamente ✅",
        role: req.session.user?.role ?? "VIEWER",
      });
    } catch (e: any) {
      res.status(500).send(`Error reseteando contraseña: ${String(e?.message ?? e)}`);
    }
  }
);

adminRouter.post(
  "/users/:id/update",
  requireRole([AdminRole.SUPERADMIN]),
  express.urlencoded({ extended: true }),
  async (req, res) => {
    const me = req.session.user;

    async function renderUsers(error: string | null, message: string | null = null) {
      const users = await fetchAdminUsers();
      return res.status(error ? 400 : 200).render("admin/users", {
        users,
        error,
        message,
        role: me?.role ?? "VIEWER",
      });
    }

    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return renderUsers("ID inválido.");

      const roleRaw = String(req.body.role ?? "VIEWER").trim().toUpperCase();
      const role: AdminRole =
        roleRaw === "SUPERADMIN"
          ? AdminRole.SUPERADMIN
          : roleRaw === "ADMIN"
          ? AdminRole.ADMIN
          : AdminRole.VIEWER;

      const phoneRaw = String(req.body.phone ?? "").trim();
      const emailRaw = String(req.body.email ?? "").trim();

      const data: Prisma.AdminUserUpdateInput = { role };

      if (phoneRaw.length) data.phone = phoneRaw;
      if (emailRaw.length) {
        const email = emailRaw.toLowerCase();
        if (!isValidEmail(email)) return renderUsers("Correo inválido. Ej: usuario@dominio.cl");
        data.email = email;
      }

      if (me?.id === id && me.role === AdminRole.SUPERADMIN && role !== AdminRole.SUPERADMIN) {
        return renderUsers("No puedes cambiar tu propio rol de SUPERADMIN.");
      }

      await prisma.adminUser.update({ where: { id }, data });
      return res.redirect("/admin/users");
    } catch (e: any) {
      const msg = String(e?.message ?? e).toLowerCase();
      if (msg.includes("unique") && msg.includes("email")) return renderUsers("Ese correo ya está en uso.");
      if (msg.includes("unique") && msg.includes("phone")) return renderUsers("Ese teléfono ya está en uso.");
      return renderUsers(`No se pudo actualizar: ${String(e?.message ?? e)}`);
    }
  }
);

/* =========================================================
   IMPORTACIÓN EXCEL
   ========================================================= */

adminRouter.get("/upload", requireRole([AdminRole.ADMIN, AdminRole.SUPERADMIN]), (_req, res) => {
  res.render("admin/upload", { message: null, stats: null, importErrors: null });
});

adminRouter.post(
  "/upload",
  requireRole([AdminRole.ADMIN, AdminRole.SUPERADMIN]),
  uploadExcel.single("file"),
  async (req: Request, res: Response) => {
    try {
      if (!req.file) {
        return res.render("admin/upload", {
          message: "No se subió archivo.",
          stats: null,
          importErrors: null,
        });
      }

      const importSource = String(req.body.importSource ?? "").trim();

      // ✅ FIX: parseFenatsExcel ahora retorna { rows, errors }
      const { rows: parsed, errors: parseErrors } = await parseFenatsExcel(req.file.buffer);

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
        const gender    = genderMap(row.genderText);

        // ✅ FIX: affiliate viene del Excel (columna BASE), no del formulario
        const affiliate = row.affiliate;

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
              importSource: importSource ? `${affiliate} · ${importSource}` : affiliate,
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
              importSource: importSource ? `${affiliate} · ${importSource}` : affiliate,
            },
          });
          updated++;
        }
      }

      const totalErrors = parseErrors.length + skipped;
      const message =
        totalErrors > 0
          ? `Importación completada con ${totalErrors} fila(s) omitidas.`
          : "Importación completada sin errores.";

      return res.render("admin/upload", {
        message,
        stats: { totalRows: parsed.length + parseErrors.length, created, updated, skipped },
        importErrors: parseErrors.length > 0 ? parseErrors : null,
      });
    } catch (e: any) {
      return res.render("admin/upload", {
        message: `Error en la importación: ${String(e?.message ?? e)}`,
        stats: null,
        importErrors: null,
      });
    }
  }
);

/* =========================================================
   CRUD SOCIOS
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
      const fullName  = String(req.body.fullName ?? "").trim();
      const rutInput  = String(req.body.rut ?? "").trim();
      // ✅ FIX: filial obligatoria en creación manual
      const affiliate = String(req.body.affiliate ?? "").trim();
      const genderRaw = String(req.body.gender ?? "").trim();
      const statusRaw = String(req.body.status ?? "ACTIVE").trim();

      if (!fullName) {
        return res.render("admin/new", { error: "Falta el nombre completo.", message: null, values: req.body });
      }

      const rut = normalizeRut(rutInput);
      if (!rut) {
        return res.render("admin/new", { error: "RUT inválido. Ej: 9.313.137-1", message: null, values: req.body });
      }

      // ✅ FIX: validar filial obligatoria
      if (!affiliate) {
        return res.render("admin/new", { error: "La filial (Base) es obligatoria.", message: null, values: req.body });
      }

      const rutMasked = formatRut(rut);
      const gender    = genderRaw === "MALE" || genderRaw === "FEMALE" || genderRaw === "OTHER" ? genderRaw : null;
      const status    = statusRaw === "INACTIVE" ? "INACTIVE" : "ACTIVE";
      const now       = new Date();
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

adminRouter.get(
  "/members",
  requireRole([AdminRole.VIEWER, AdminRole.ADMIN, AdminRole.SUPERADMIN]),
  async (req, res) => {
    try {
      const q    = String(req.query.q ?? "").trim();
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

      res.render("admin/members", { q, members, role: req.session.user?.role ?? "VIEWER" });
    } catch (e: any) {
      res.status(500).send(`Error cargando socios: ${String(e?.message ?? e)}`);
    }
  }
);

adminRouter.post(
  "/members/:id/toggle",
  requireRole([AdminRole.ADMIN, AdminRole.SUPERADMIN]),
  async (req, res) => {
    try {
      const id     = Number(req.params.id);
      const member = await prisma.member.findUnique({ where: { id } });
      if (!member) return res.status(404).send("No encontrado");

      const newStatus = member.status === "ACTIVE" ? "INACTIVE" : "ACTIVE";
      await prisma.member.update({ where: { id }, data: { status: newStatus } });
      res.redirect("/admin/members");
    } catch (e: any) {
      res.status(500).send(`Error actualizando socio: ${String(e?.message ?? e)}`);
    }
  }
);

adminRouter.post(
  "/members/:id/regen-token",
  requireRole([AdminRole.ADMIN, AdminRole.SUPERADMIN]),
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      await prisma.member.update({ where: { id }, data: { token: newToken() } });
      res.redirect("/admin/members");
    } catch (e: any) {
      res.status(500).send(`Error regenerando token: ${String(e?.message ?? e)}`);
    }
  }
);

/* =========================================================
   POSTS / NOTICIAS (ADMIN y SUPERADMIN)
   ========================================================= */

adminRouter.get("/posts", requireRole([AdminRole.ADMIN, AdminRole.SUPERADMIN]), async (req, res) => {
  try {
    const posts = await prisma.post.findMany({ orderBy: { createdAt: "desc" } });
    res.render("admin/posts", { posts, error: null, message: null, role: req.session.user?.role });
  } catch (e: any) {
    res.status(500).send(`Error cargando noticias: ${String(e?.message ?? e)}`);
  }
});

adminRouter.get("/posts/new", requireRole([AdminRole.ADMIN, AdminRole.SUPERADMIN]), (_req, res) => {
  res.render("admin/new-post", { error: null, message: null, values: null });
});

adminRouter.post(
  "/posts/new",
  requireRole([AdminRole.ADMIN, AdminRole.SUPERADMIN]),
  uploadImage.single("image"),
  async (req, res) => {
    try {
      const title    = String(req.body.title    ?? "").trim();
      const content  = String(req.body.content  ?? "").trim();
      const category = String(req.body.category ?? "General").trim();
      const published = req.body.published === "on";

      if (!title)   return res.render("admin/new-post", { error: "Falta el título.", message: null, values: req.body });
      if (!content) return res.render("admin/new-post", { error: "Falta el contenido.", message: null, values: req.body });

      let imageUrl: string | null = null;
      if (req.file) {
        const ext      = req.file.originalname.split(".").pop() ?? "jpg";
        const filename = `post-${Date.now()}.${ext}`;
        const fs       = await import("node:fs/promises");
        const destPath = `assets/uploads/${filename}`;
        await fs.writeFile(destPath, req.file.buffer);
        imageUrl = `/assets/uploads/${filename}`;
      }

      await prisma.post.create({ data: { title, content, category, published, imageUrl } });

      res.render("admin/new-post", { error: null, message: "Noticia creada correctamente.", values: null });
    } catch (e: any) {
      res.render("admin/new-post", { error: `Error: ${String(e?.message ?? e)}`, message: null, values: req.body });
    }
  }
);

adminRouter.post(
  "/posts/:id/toggle",
  requireRole([AdminRole.ADMIN, AdminRole.SUPERADMIN]),
  async (req, res) => {
    try {
      const id   = Number(req.params.id);
      const post = await prisma.post.findUnique({ where: { id } });
      if (!post) return res.status(404).send("No encontrado");
      await prisma.post.update({ where: { id }, data: { published: !post.published } });
      res.redirect("/admin/posts");
    } catch (e: any) {
      res.status(500).send(`Error: ${String(e?.message ?? e)}`);
    }
  }
);

adminRouter.post(
  "/posts/:id/delete",
  requireRole([AdminRole.ADMIN, AdminRole.SUPERADMIN]),
  async (req, res) => {
    try {
      const id   = Number(req.params.id);
      const post = await prisma.post.findUnique({ where: { id } });
      if (!post) return res.status(404).send("No encontrado");

      // Eliminar imagen del disco si existe
      if (post.imageUrl) {
        const fs       = await import("node:fs/promises");
        const filePath = post.imageUrl.replace("/assets/", "assets/");
        await fs.unlink(filePath).catch(() => {});
      }

      await prisma.post.delete({ where: { id } });
      res.redirect("/admin/posts");
    } catch (e: any) {
      res.status(500).send(`Error: ${String(e?.message ?? e)}`);
    }
  }
);

adminRouter.get(
  "/posts/:id/edit",
  requireRole([AdminRole.ADMIN, AdminRole.SUPERADMIN]),
  async (req, res) => {
    try {
      const id   = Number(req.params.id);
      const post = await prisma.post.findUnique({ where: { id } });
      if (!post) return res.status(404).send("Noticia no encontrada");

      res.render("admin/edit-post", { post, error: null, message: null });
    } catch (e: any) {
      res.status(500).send(`Error: ${String(e?.message ?? e)}`);
    }
  }
);

adminRouter.post(
  "/posts/:id/edit",
  requireRole([AdminRole.ADMIN, AdminRole.SUPERADMIN]),
  uploadImage.single("image"),
  async (req, res) => {
    try {
      const id       = Number(req.params.id);
      const title    = String(req.body.title    ?? "").trim();
      const content  = String(req.body.content  ?? "").trim();
      const category = String(req.body.category ?? "General").trim();
      const published = req.body.published === "on";

      if (!title)   return res.render("admin/edit-post", { post: req.body, error: "Falta el título.", message: null });
      if (!content) return res.render("admin/edit-post", { post: req.body, error: "Falta el contenido.", message: null, values: req.body });

      const existingPost = await prisma.post.findUnique({ where: { id } });
      if (!existingPost) return res.status(404).send("Noticia no encontrada");

      let imageUrl = existingPost.imageUrl;
      if (req.file) {
        // Eliminar imagen anterior si existe
        if (existingPost.imageUrl) {
          const fs       = await import("node:fs/promises");
          const oldPath  = existingPost.imageUrl.replace("/assets/", "assets/");
          await fs.unlink(oldPath).catch(() => {});
        }

        // Guardar nueva imagen
        const ext      = req.file.originalname.split(".").pop() ?? "jpg";
        const filename = `post-${Date.now()}.${ext}`;
        const fs       = await import("node:fs/promises");
        const destPath = `assets/uploads/${filename}`;
        await fs.writeFile(destPath, req.file.buffer);
        imageUrl = `/assets/uploads/${filename}`;
      }

      await prisma.post.update({
        where: { id },
        data: { title, content, category, published, imageUrl }
      });

      const updatedPost = await prisma.post.findUnique({ where: { id } });
      res.render("admin/edit-post", { post: updatedPost, error: null, message: "Noticia actualizada correctamente." });
    } catch (e: any) {
      res.render("admin/edit-post", { post: req.body, error: `Error: ${String(e?.message ?? e)}`, message: null });
    }
  }
);

/* =========================================================
   FOTOS / GALERÍA (ADMIN y SUPERADMIN)
   ========================================================= */

// ✅ Reemplaza el GET /photos existente
adminRouter.get("/photos", requireRole([AdminRole.ADMIN, AdminRole.SUPERADMIN]), async (req, res) => {
  try {
    const [photos, convenios] = await Promise.all([
      prisma.photo.findMany({ orderBy: { createdAt: "desc" } }),
      prisma.convenio.findMany({ orderBy: { createdAt: "desc" } }),
    ]);
    res.render("admin/photos", { photos, convenios, error: null, message: null, role: req.session.user?.role });
  } catch (e: any) {
    res.status(500).send(`Error: ${String(e?.message ?? e)}`);
  }
});

adminRouter.post(
  "/photos/new",
  requireRole([AdminRole.ADMIN, AdminRole.SUPERADMIN]),
  uploadImage.single("image"),
  async (req, res) => {
    try {
      const caption = String(req.body.caption ?? "").trim() || null;
      const [photos, convenios] = await fetchPhotosAndConvenios();

      if (!req.file) {
        return res.render("admin/photos", {
          photos, convenios,
          error: "Debes seleccionar una imagen.", message: null,
          role: req.session.user?.role,
        });
      }

      const ext      = req.file.originalname.split(".").pop() ?? "jpg";
      const filename = `photo-${Date.now()}.${ext}`;
      const fs       = await import("node:fs/promises");
      await fs.writeFile(`assets/uploads/${filename}`, req.file.buffer);
      await prisma.photo.create({ data: { imageUrl: `/assets/uploads/${filename}`, caption } });

      const [photosNew, conveniosNew] = await fetchPhotosAndConvenios();
      res.render("admin/photos", {
        photos: photosNew, convenios: conveniosNew,
        error: null, message: "Foto agregada correctamente.",
        role: req.session.user?.role,
      });
    } catch (e: any) {
      const [photos, convenios] = await fetchPhotosAndConvenios();
      res.render("admin/photos", {
        photos, convenios,
        error: `Error: ${String(e?.message ?? e)}`, message: null,
        role: req.session.user?.role,
      });
    }
  }
);

adminRouter.post(
  "/photos/:id/delete",
  requireRole([AdminRole.ADMIN, AdminRole.SUPERADMIN]),
  async (req, res) => {
    try {
      const id    = Number(req.params.id);
      const photo = await prisma.photo.findUnique({ where: { id } });
      if (!photo) return res.status(404).send("No encontrado");

      const fs = await import("node:fs/promises");
      await fs.unlink(photo.imageUrl.replace("/assets/", "assets/")).catch(() => {});
      await prisma.photo.delete({ where: { id } });

      res.redirect("/admin/photos");
    } catch (e: any) {
      res.status(500).send(`Error: ${String(e?.message ?? e)}`);
    }
  }
);

adminRouter.get(
  "/photos/:id/edit",
  requireRole([AdminRole.ADMIN, AdminRole.SUPERADMIN]),
  async (req, res) => {
    try {
      const id    = Number(req.params.id);
      const photo = await prisma.photo.findUnique({ where: { id } });
      if (!photo) return res.status(404).send("Foto no encontrada");

      res.render("admin/edit-photo", { photo, error: null, message: null });
    } catch (e: any) {
      res.status(500).send(`Error: ${String(e?.message ?? e)}`);
    }
  }
);

adminRouter.post(
  "/photos/:id/edit",
  requireRole([AdminRole.ADMIN, AdminRole.SUPERADMIN]),
  uploadImage.single("image"),
  async (req, res) => {
    try {
      const id      = Number(req.params.id);
      const title   = String(req.body.title ?? "").trim();

      if (!title) return res.render("admin/edit-photo", { photo: req.body, error: "Falta el título.", message: null });

      const existingPhoto = await prisma.photo.findUnique({ where: { id } });
      if (!existingPhoto) return res.status(404).send("Foto no encontrada");

      let imageUrl = existingPhoto.imageUrl;
      if (req.file) {
        // Eliminar imagen anterior
        const fs = await import("node:fs/promises");
        await fs.unlink(existingPhoto.imageUrl.replace("/assets/", "assets/")).catch(() => {});

        // Guardar nueva imagen
        const ext      = req.file.originalname.split(".").pop() ?? "jpg";
        const filename = `photo-${Date.now()}.${ext}`;
        const destPath = `assets/uploads/${filename}`;
        await fs.writeFile(destPath, req.file.buffer);
        imageUrl = `/assets/uploads/${filename}`;
      }

      await prisma.photo.update({
        where: { id },
        data: { caption: title, imageUrl }
      });

      const updatedPhoto = await prisma.photo.findUnique({ where: { id } });
      res.render("admin/edit-photo", { photo: updatedPhoto, error: null, message: "Foto actualizada correctamente." });
    } catch (e: any) {
      res.render("admin/edit-photo", { photo: req.body, error: `Error: ${String(e?.message ?? e)}`, message: null });
    }
  }
);

/* =========================================================
   CONVENIOS
   ========================================================= */

adminRouter.get("/convenios", requireRole([AdminRole.ADMIN, AdminRole.SUPERADMIN]), async (req, res) => {
  try {
    const convenios = await prisma.convenio.findMany({ orderBy: { createdAt: "desc" } });
    res.render("admin/photos", {
      photos: await prisma.photo.findMany({ orderBy: { createdAt: "desc" } }),
      convenios,
      error: null, message: null,
      role: req.session.user?.role,
    });
  } catch (e: any) {
    res.status(500).send(`Error: ${String(e?.message ?? e)}`);
  }
});

adminRouter.post(
  "/convenios/new",
  requireRole([AdminRole.ADMIN, AdminRole.SUPERADMIN]),
  uploadImage.single("logo"),
  async (req, res) => {
    try {
      const name = String(req.body.name ?? "").trim();
      const address = String(req.body.address ?? "").trim();
      const phone = String(req.body.phone ?? "").trim();

      if (!name || !address || !phone) {
        const [photos, convenios] = await Promise.all([
          prisma.photo.findMany({ orderBy: { createdAt: "desc" } }),
          prisma.convenio.findMany({ orderBy: { createdAt: "desc" } }),
        ]);
        let missingFields = [];
        if (!name) missingFields.push("nombre");
        if (!address) missingFields.push("dirección");
        if (!phone) missingFields.push("teléfono");
        return res.render("admin/photos", {
          photos,
          convenios,
          error: `Faltan campos obligatorios: ${missingFields.join(", ")}.`,
          message: null,
          role: req.session.user?.role,
        });
      }

      let logoUrl: string | null = null;
      if (req.file) {
        const ext      = req.file.originalname.split(".").pop() ?? "png";
        const filename = `convenio-${Date.now()}.${ext}`;
        const fs       = await import("node:fs/promises");
        await fs.writeFile(`assets/uploads/${filename}`, req.file.buffer);
        logoUrl = `/assets/uploads/${filename}`;
      }

      await prisma.convenio.create({ data: { name, address, phone, logoUrl } });

      const [photos, convenios] = await Promise.all([
        prisma.photo.findMany({ orderBy: { createdAt: "desc" } }),
        prisma.convenio.findMany({ orderBy: { createdAt: "desc" } }),
      ]);
      res.set("X-Tab", "convenios");
      res.render("admin/photos", { photos, convenios, error: null, message: `Convenio "${name}" agregado.`, role: req.session.user?.role, activeTab: "convenios", });
    } catch (e: any) {
      const [photos, convenios] = await Promise.all([
        prisma.photo.findMany({ orderBy: { createdAt: "desc" } }),
        prisma.convenio.findMany({ orderBy: { createdAt: "desc" } }),
      ]);
      res.render("admin/photos", { photos, convenios, error: `Error: ${String(e?.message ?? e)}`, message: null, role: req.session.user?.role });
    }
  }
);

adminRouter.post(
  "/convenios/:id/toggle",
  requireRole([AdminRole.ADMIN, AdminRole.SUPERADMIN]),
  async (req, res) => {
    try {
      const id  = Number(req.params.id);
      const conv = await prisma.convenio.findUnique({ where: { id } });
      if (!conv) return res.status(404).send("No encontrado");
      await prisma.convenio.update({ where: { id }, data: { active: !conv.active } });
      res.redirect("/admin/photos#convenios");
    } catch (e: any) {
      res.status(500).send(`Error: ${String(e?.message ?? e)}`);
    }
  }
);

adminRouter.post(
  "/convenios/:id/delete",
  requireRole([AdminRole.ADMIN, AdminRole.SUPERADMIN]),
  async (req, res) => {
    try {
      const id  = Number(req.params.id);
      const conv = await prisma.convenio.findUnique({ where: { id } });
      if (!conv) return res.status(404).send("No encontrado");
      if (conv.logoUrl) {
        const fs = await import("node:fs/promises");
        await fs.unlink(conv.logoUrl.replace("/assets/", "assets/")).catch(() => {});
      }
      await prisma.convenio.delete({ where: { id } });
      res.redirect("/admin/photos#convenios");
    } catch (e: any) {
      res.status(500).send(`Error: ${String(e?.message ?? e)}`);
    }
  }
);

adminRouter.get(
  "/convenios/:id/edit",
  requireRole([AdminRole.ADMIN, AdminRole.SUPERADMIN]),
  async (req, res) => {
    try {
      const id      = Number(req.params.id);
      const convenio = await prisma.convenio.findUnique({ where: { id } });
      if (!convenio) return res.status(404).send("Convenio no encontrado");

      res.render("admin/edit-convenio", { convenio, error: null, message: null });
    } catch (e: any) {
      res.status(500).send(`Error: ${String(e?.message ?? e)}`);
    }
  }
);

adminRouter.post(
  "/convenios/:id/edit",
  requireRole([AdminRole.ADMIN, AdminRole.SUPERADMIN]),
  uploadImage.single("logo"),
  async (req, res) => {
    try {
      const id      = Number(req.params.id);
      const name    = String(req.body.name    ?? "").trim();
      const address = String(req.body.address ?? "").trim();
      const phone   = String(req.body.phone   ?? "").trim();

      if (!name)    return res.render("admin/edit-convenio", { convenio: req.body, error: "Falta el nombre.", message: null });
      if (!address) return res.render("admin/edit-convenio", { convenio: req.body, error: "Falta la dirección.", message: null });
      if (!phone)   return res.render("admin/edit-convenio", { convenio: req.body, error: "Falta el teléfono.", message: null });

      const existingConvenio = await prisma.convenio.findUnique({ where: { id } });
      if (!existingConvenio) return res.status(404).send("Convenio no encontrado");

      let logoUrl = existingConvenio.logoUrl;
      if (req.file) {
        // Eliminar logo anterior si existe
        if (existingConvenio.logoUrl) {
          const fs = await import("node:fs/promises");
          await fs.unlink(existingConvenio.logoUrl.replace("/assets/", "assets/")).catch(() => {});
        }

        // Guardar nuevo logo
        const ext      = req.file.originalname.split(".").pop() ?? "jpg";
        const filename = `convenio-${Date.now()}.${ext}`;
        const destPath = `assets/uploads/${filename}`;
        const fs       = await import("node:fs/promises");
        await fs.writeFile(destPath, req.file.buffer);
        logoUrl = `/assets/uploads/${filename}`;
      }

      await prisma.convenio.update({
        where: { id },
        data: { name, address, phone, logoUrl }
      });

      const updatedConvenio = await prisma.convenio.findUnique({ where: { id } });
      res.render("admin/edit-convenio", { convenio: updatedConvenio, error: null, message: "Convenio actualizado correctamente." });
    } catch (e: any) {
      res.render("admin/edit-convenio", { convenio: req.body, error: `Error: ${String(e?.message ?? e)}`, message: null });
    }
  }
);








