import type { Request, Response, NextFunction } from "express";
import express from "express";
import multer from "multer";
import crypto from "crypto";
import bcrypt from "bcrypt";
import { prisma } from "../db/prisma.js";
import { parseFenatsExcel } from "./excel.parse.js";
import { Prisma, AdminRole } from "@prisma/client";

// ✅ 2FA mailer
import { sendAdminOtpEmail } from "./mailer.js";

const upload = multer({ storage: multer.memoryStorage() });
export const adminRouter = express.Router();

/**
 * TIPADO de session para evitar "as any"
 */
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
   AUTH HELPERS (sesión + roles)
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
   VALIDACIONES (username rut / password fuerte / email)
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

function generateOtpCode() {
  return String(Math.floor(100000 + Math.random() * 900000)); // 6 dígitos
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
   UTILIDADES (RUT / gender / token)
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

/* =========================================================
   LOGIN / LOGOUT (DB + bcrypt) + 2FA por correo
   ========================================================= */

adminRouter.get("/login", (req, res) => {
  if (req.session?.user) return res.redirect("/admin");
  res.render("admin/login", { error: null });
});

adminRouter.post("/login", express.urlencoded({ extended: true }), async (req, res) => {
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

    // ✅ 2FA: requiere email
    if (!user.email) {
      return res
        .status(400)
        .render("admin/login", { error: "Tu usuario no tiene correo configurado. Contacta al SUPERADMIN." });
    }

    req.session.user = undefined;
    req.session.pending2fa = {
      userId: user.id,
      username: user.username,
      createdAt: Date.now(),
      lastResendAt: Date.now(),
    };

    await createAndSendOtp(user.id, user.email);

    return res.redirect("/admin/otp");
  } catch (e: any) {
    return res.status(500).render("admin/login", {
      error: `Error interno al iniciar sesión: ${String(e?.message ?? e)}`,
    });
  }
});

// ✅ Vista OTP
adminRouter.get("/otp", (req, res) => {
  if (req.session?.user) return res.redirect("/admin");
  if (!req.session?.pending2fa) return res.redirect("/admin/login");
  res.render("admin/otp", { error: null, message: null });
});

// ✅ Verificar OTP
adminRouter.post("/otp", express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const pending = req.session.pending2fa;
    if (!pending) return res.redirect("/admin/login");

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

    // ✅ OTP correcto: crear sesión final
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

// ✅ Reenviar OTP
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

adminRouter.get("/logout", (req, res) => {
  if (req.session) {
    req.session.user = undefined;
    req.session.pending2fa = undefined;
  }
  res.redirect("/admin/login");
});

/* =========================================================
   PANEL / DASHBOARD
   ========================================================= */

adminRouter.get("/", requireAuth, async (req, res) => {
  const total = await prisma.member.count();
  const active = await prisma.member.count({ where: { status: "ACTIVE" } });
  const inactive = await prisma.member.count({ where: { status: "INACTIVE" } });

  res.render("admin/dashboard", {
    total,
    active,
    inactive,
    role: req.session.user?.role ?? "VIEWER",
  });
});

/* =========================================================
   USUARIOS ADMIN (solo SUPERADMIN)
   ========================================================= */

adminRouter.get("/users", requireRole([AdminRole.SUPERADMIN]), async (req, res) => {
  const users = await prisma.adminUser.findMany({
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

  res.render("admin/users", {
    users,
    error: null,
    message: null,
    role: req.session.user?.role ?? "VIEWER",
  });
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
      const username = String(req.body.username ?? "").trim();
      const password = String(req.body.password ?? "");
      const password2 = String(req.body.password2 ?? "");
      const roleRaw = String(req.body.role ?? "VIEWER").trim().toUpperCase();
      const email = normalizeEmail(req.body.email ?? "");

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

      return res.render("admin/new-user", { error: null, message: `Usuario creado: ${username} (${role})`, values: null });
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      const lower = msg.toLowerCase();

      let friendly = msg;
      if (lower.includes("unique") && lower.includes("username")) friendly = "Ese usuario ya existe.";
      if (lower.includes("unique") && lower.includes("email")) friendly = "Ese correo ya existe.";

      return res.status(400).render("admin/new-user", {
        error: `No se pudo crear: ${friendly}`,
        message: null,
        values: req.body,
      });
    }
  }
);

adminRouter.post("/users/:id/toggle", requireRole([AdminRole.SUPERADMIN]), async (req, res) => {
  const id = Number(req.params.id);
  const user = await prisma.adminUser.findUnique({ where: { id } });
  if (!user) return res.status(404).send("No encontrado");

  if (req.session.user?.id === id) {
    const users = await prisma.adminUser.findMany({
      orderBy: { createdAt: "desc" },
      select: { id: true, username: true, role: true, isActive: true, phone: true, email: true, createdAt: true, updatedAt: true },
      take: 200,
    });

    return res.status(400).render("admin/users", {
      users,
      error: "No puedes desactivarte a ti mismo.",
      message: null,
      role: req.session.user?.role ?? "VIEWER",
    });
  }

  await prisma.adminUser.update({
    where: { id },
    data: { isActive: !user.isActive },
  });

  return res.redirect("/admin/users");
});

adminRouter.post(
  "/users/:id/reset-password",
  requireRole([AdminRole.SUPERADMIN]),
  express.urlencoded({ extended: true }),
  async (req, res) => {
    const id = Number(req.params.id);
    const password = String(req.body.password ?? "");

    const passErr = validateStrongPassword(password);
    if (passErr) {
      const users = await prisma.adminUser.findMany({
        orderBy: { createdAt: "desc" },
        select: { id: true, username: true, role: true, isActive: true, phone: true, email: true, createdAt: true, updatedAt: true },
        take: 200,
      });

      return res.status(400).render("admin/users", {
        users,
        error: passErr,
        message: null,
        role: req.session.user?.role ?? "VIEWER",
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    await prisma.adminUser.update({ where: { id }, data: { passwordHash } });

    const users = await prisma.adminUser.findMany({
      orderBy: { createdAt: "desc" },
      select: { id: true, username: true, role: true, isActive: true, phone: true, email: true, createdAt: true, updatedAt: true },
      take: 200,
    });

    return res.render("admin/users", {
      users,
      error: null,
      message: "Contraseña reseteada correctamente ✅",
      role: req.session.user?.role ?? "VIEWER",
    });
  }
);

adminRouter.post(
  "/users/:id/update",
  requireRole([AdminRole.SUPERADMIN]),
  express.urlencoded({ extended: true }),
  async (req, res) => {
    const me = req.session.user;

    async function renderUsers(error: string | null, message: string | null = null) {
      const users = await prisma.adminUser.findMany({
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

adminRouter.get(
  "/members",
  requireRole([AdminRole.VIEWER, AdminRole.ADMIN, AdminRole.SUPERADMIN]),
  async (req, res) => {
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

    res.render("admin/members", { q, members, role: req.session.user?.role ?? "VIEWER" });
  }
);

adminRouter.post(
  "/members/:id/toggle",
  requireRole([AdminRole.ADMIN, AdminRole.SUPERADMIN]),
  async (req, res) => {
    const id = Number(req.params.id);
    const member = await prisma.member.findUnique({ where: { id } });
    if (!member) return res.status(404).send("No encontrado");

    const newStatus = member.status === "ACTIVE" ? "INACTIVE" : "ACTIVE";

    await prisma.member.update({
      where: { id },
      data: { status: newStatus },
    });

    res.redirect("/admin/members");
  }
);

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











