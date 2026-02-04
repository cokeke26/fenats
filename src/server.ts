import "dotenv/config";
import path from "node:path";
import express from "express";
import type { Request, Response } from "express";
import QRCode from "qrcode";
import session from "express-session";

import { prisma } from "./db/prisma.js";
import { adminRouter } from "./admin/admin.routes.js";

const app = express();
const port = Number(process.env.PORT || 3000);

// Base URL pública (en prod pon PUBLIC_BASE_URL, en local usa host detectado)
function getBaseUrl(req?: Request) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL;
  if (req) return `${req.protocol}://${req.get("host")}`;
  return `http://localhost:${port}`;
}

app.get("/health", (_req, res) => res.json({ ok: true }));

// Views (EJS) - ruta robusta para Windows
app.set("view engine", "ejs");
app.set("views", path.join(process.cwd(), "src", "views"));

// Forms + Session (para admin)
app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    secret: process.env.SESSION_SECRET ?? "dev-secret",
    resave: false,
    saveUninitialized: false,
  })
);

// Router admin
app.use("/admin", adminRouter);

/**
 * Login socio (solo RUT -> redirige a credencial)
 * GET /login-member
 * POST /login-member
 */
app.get("/login-member", (req: Request, res: Response) => {
  res.render("member/login-member", { error: null, rut: "" });
});

app.post("/login-member", async (req: Request, res: Response) => {
  try {
    const rutInput = String(req.body.rut ?? "").trim();

    if (!rutInput) {
      return res.status(400).render("member/login-member", {
        error: "Debes ingresar tu RUT.",
        rut: rutInput,
      });
    }

    const rut = normalizeRutMember(rutInput);
    if (!rut) {
      return res.status(400).render("member/login-member", {
        error: "RUT inválido. Debe incluir DV (ej: 9.313.137-1).",
        rut: rutInput,
      });
    }

    const member = await prisma.member.findUnique({ where: { rut } });

    if (!member) {
      return res.status(404).render("member/login-member", {
        error: "No encontramos tu RUT en el sistema. Verifica el DV o contacta a tu filial.",
        rut: rutInput,
      });
    }

    // Redirige a la credencial existente (ya la tienes lista)
    return res.redirect(`/credencial/${encodeURIComponent(member.token)}`);
  } catch (e: any) {
    return res.status(500).render("member/login-member", {
      error: `Error interno: ${String(e?.message ?? e)}`,
      rut: String(req.body.rut ?? ""),
    });
  }
});

/**
 * Normaliza RUT a formato DB: "num-dv" (sin puntos, DV en mayúscula)
 * Acepta input con puntos/guiones/espacios.
 */
function normalizeRutMember(raw: string) {
  const s = String(raw ?? "").trim().toUpperCase();
  const compact = s.replace(/[^0-9K]/g, "");
  if (compact.length < 2) return "";
  const dv = compact.slice(-1);
  const num = compact.slice(0, -1).replace(/^0+/, "") || "0";
  return `${num}-${dv}`;
}


/**
 * Validación por token (pantalla para el local que escanea)
 * GET /s/:token
 */
app.get("/s/:token", async (req: Request, res: Response) => {
  const token = String(req.params.token || "").trim();
  const checkedAt = new Date();

  const member = await prisma.member.findUnique({ where: { token } });

  // Si no existe: pantalla de código inválido (404)
  if (!member) {
    return res.status(404).send(
      renderPage({
        title: "CÓDIGO NO VÁLIDO",
        status: "INVALID",
        fullName: "",
        rutMasked: "",
        affiliate: "",
        checkedAt,
        token,
        baseUrl: getBaseUrl(req),
      })
    );
  }

  const isActive = member.status === "ACTIVE";

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  return res.send(
    renderPage({
      title: isActive ? "SOCIO VIGENTE" : "SOCIO NO VIGENTE",
      status: isActive ? "ACTIVE" : "INACTIVE",
      fullName: member.fullName,
      rutMasked: member.rutMasked,
      affiliate: member.affiliate ?? "-",
      checkedAt,
      token: member.token,
      baseUrl: getBaseUrl(req),
    })
  );
});

/**
 * Genera QR PNG con la URL de verificación
 * GET /qr/:token.png
 */
app.get("/qr/:token.png", async (req: Request, res: Response) => {
  const token = String(req.params.token || "").trim();

  // Validar que exista (evita QR basura)
  const member = await prisma.member.findUnique({ where: { token } });
  if (!member) return res.status(404).send("Token no encontrado");

  const baseUrl = getBaseUrl(req);
  const validateUrl = `${baseUrl}/s/${encodeURIComponent(token)}`;

  const png = await QRCode.toBuffer(validateUrl, {
    type: "png",
    errorCorrectionLevel: "M",
    margin: 2,
    scale: 8,
  });

  res.set("Content-Type", "image/png");
  res.set("Cache-Control", "no-store");
  res.send(png);
});

/**
 * Credencial imprimible (ideal para directiva / administración)
 * GET /credencial/:token
 */
app.get("/credencial/:token", async (req: Request, res: Response) => {
  const token = String(req.params.token || "").trim();
  const member = await prisma.member.findUnique({ where: { token } });
  if (!member) return res.status(404).send("No encontrado");

  const baseUrl = getBaseUrl(req);
  const validateUrl = `${baseUrl}/s/${encodeURIComponent(token)}`;
  const qrPngUrl = `${baseUrl}/qr/${encodeURIComponent(token)}.png`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Credencial FENATS</title>
  <style>
    :root{
      --border:#e5e7eb;
      --muted:#4b5563;
      --btn:#111827;
      --btnText:#ffffff;
    }
    *{box-sizing:border-box}
    body{
      margin:0;
      min-height:100vh;
      font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial;
      background: linear-gradient(180deg,#f7f7fb,#eef2ff);
      padding: 20px;
      display:flex;
      align-items:center;
      justify-content:center;
    }
    .card{
      width:min(720px,100%);
      background:#fff;
      border:1px solid var(--border);
      border-radius:18px;
      padding:18px;
      box-shadow:0 20px 60px rgba(0,0,0,.12);
    }
    .row{
      display:flex;
      gap:16px;
      align-items:center;
      justify-content:space-between;
      flex-wrap:wrap;
    }
    .info{flex:1; min-width: 260px;}
    .h1{margin:0;font-size:20px;font-weight:900;color:#111827;}
    .p{margin:8px 0 0;color:var(--muted);font-size:14px;line-height:1.3;}
    .qrWrap{
      display:flex;
      flex-direction:column;
      align-items:center;
      gap:10px;
      min-width: 210px;
    }
    .qr{
      width:180px;height:180px;
      background:#fff;
      border:1px solid var(--border);
      border-radius:14px;
      padding:10px;
    }
    .btns{
      margin-top:14px;
      display:flex;
      gap:10px;
      flex-wrap:wrap;
    }
    a,button{
      border:0;
      border-radius:14px;
      padding:14px 16px;
      font-weight:900;
      cursor:pointer;
      text-decoration:none;
      font-size:16px;
    }
    .primary{ background:var(--btn); color:var(--btnText); }
    .ghost{ background:#f3f4f6; color:#111827; }
    .hint{ margin-top:10px; color:#6b7280; font-size:12px; line-height:1.4; }
    @media print{
      body{background:#fff; padding:0;}
      .card{box-shadow:none; border:1px solid #ddd; border-radius:12px;}
      .btns,.hint{display:none !important;}
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="row">
      <div class="info">
        <h1 class="h1">Credencial FENATS</h1>
        <div class="p"><b>Nombre:</b> ${escapeHtml(member.fullName)}</div>
        <div class="p"><b>RUT:</b> ${escapeHtml(member.rutMasked)}</div>
        <div class="p"><b>Filial:</b> ${escapeHtml(member.affiliate ?? "-")}</div>
      </div>

      <div class="qrWrap">
        <img class="qr" src="${qrPngUrl}" alt="QR de validación" />
        <div class="p" style="margin:0;color:#111827;"><b>Escanear para validar</b></div>
      </div>
    </div>

    <div class="btns">
      <button class="primary" onclick="window.print()">Imprimir</button>
      <a class="ghost" href="${qrPngUrl}" download>Descargar QR</a>
      <a class="ghost" href="${validateUrl}" target="_blank" rel="noreferrer">Abrir verificación</a>
    </div>

    <div class="hint">
      Esta credencial está pensada para facilitar el acceso a convenios.
      La verificación oficial se realiza al escanear el QR (vigente / no vigente).
    </div>
  </div>
</body>
</html>`);
});

app.listen(port, () => console.log(`Servidor: http://localhost:${port}`));

type RenderStatus = "ACTIVE" | "INACTIVE" | "INVALID";

function formatCLDateTime(d: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()} ${pad(d.getHours())}:${pad(
    d.getMinutes()
  )}`;
}

function escapeHtml(s: string) {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderPage(input: {
  title: string;
  status: RenderStatus;
  fullName: string;
  rutMasked: string;
  affiliate: string;
  checkedAt: Date;
  token: string;
  baseUrl: string;
}) {
  const { title, status, fullName, rutMasked, affiliate, checkedAt, token, baseUrl } = input;

  const statusMeta =
    status === "ACTIVE"
      ? { badge: "VIGENTE", tone: "ok", subtitle: "Beneficio autorizado para convenios FENATS." }
      : status === "INACTIVE"
      ? { badge: "NO VIGENTE", tone: "warn", subtitle: "Socio no vigente. Beneficio no aplicable." }
      : { badge: "INVÁLIDO", tone: "bad", subtitle: "El código no corresponde a un socio registrado." };

  const safeName = escapeHtml(fullName || "-");
  const safeRut = escapeHtml(rutMasked || "-");
  const safeAffiliate = escapeHtml(affiliate || "-");
  const safeTitle = escapeHtml(title);

  const toneColor =
    statusMeta.tone === "ok" ? "var(--ok)" : statusMeta.tone === "warn" ? "var(--warn)" : "var(--bad)";

  const credencialUrl = `${baseUrl}/credencial/${encodeURIComponent(token)}`;

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>FENATS · Validación</title>
  <style>
    :root{
      --bg:#0b1220;
      --card:rgba(255,255,255,.08);
      --border:rgba(255,255,255,.12);
      --text:rgba(255,255,255,.92);
      --muted:rgba(255,255,255,.70);
      --shadow:0 20px 60px rgba(0,0,0,.35);
      --ok:#22c55e; --warn:#f59e0b; --bad:#ef4444;
      --btn:rgba(255,255,255,.10); --btnBorder:rgba(255,255,255,.16);
    }
    *{box-sizing:border-box}
    body{
      margin:0; min-height:100vh; color:var(--text);
      font-family: ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;
      background:
        radial-gradient(800px 500px at 20% 10%, rgba(34,197,94,.18), transparent 60%),
        radial-gradient(900px 600px at 90% 30%, rgba(59,130,246,.20), transparent 60%),
        radial-gradient(700px 500px at 40% 90%, rgba(245,158,11,.16), transparent 60%),
        var(--bg);
      display:flex; align-items:center; justify-content:center; padding:24px;
    }
    .wrap{width:min(820px,100%)}
    .top{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px}
    .brand{display:flex;align-items:center;gap:10px;font-weight:700;letter-spacing:.2px}
    .dot{width:12px;height:12px;border-radius:999px;background:${toneColor};box-shadow:0 0 0 6px rgba(255,255,255,.06)}
    .meta{color:var(--muted);font-size:13px;text-align:right;line-height:1.2}
    .card{background:var(--card);border:1px solid var(--border);border-radius:18px;box-shadow:var(--shadow);overflow:hidden}
    .hero{padding:22px 22px 16px;border-bottom:1px solid var(--border);display:flex;align-items:flex-start;justify-content:space-between;gap:14px}
    .hgroup h1{margin:0;font-size:26px;letter-spacing:.2px}
    .hgroup p{margin:6px 0 0;color:var(--muted);font-size:14px}
    .badge{display:inline-flex;align-items:center;gap:8px;padding:10px 12px;border-radius:999px;font-weight:800;letter-spacing:.6px;font-size:12px;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.06);white-space:nowrap}
    .pill{width:8px;height:8px;border-radius:999px;background:${toneColor};box-shadow:0 0 0 4px rgba(255,255,255,.06)}
    .grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;padding:18px 22px 10px}
    .field{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.10);border-radius:14px;padding:12px}
    .label{font-size:12px;color:var(--muted);margin-bottom:6px}
    .value{font-size:16px;font-weight:650;word-break:break-word}
    .hr{height:1px;background:rgba(255,255,255,.10);margin:10px 22px 0}
    .actions{padding:14px 22px 18px;display:flex;gap:10px;flex-wrap:wrap;align-items:center;justify-content:space-between}
    .btns{display:flex;gap:10px;flex-wrap:wrap}
    .btn{
      display:inline-flex;align-items:center;justify-content:center;
      padding:12px 14px;border-radius:14px;border:1px solid var(--btnBorder);
      background:var(--btn);color:var(--text);text-decoration:none;font-weight:900;cursor:pointer;font-size:15px;
    }
    .btnPrimary{border-color:rgba(255,255,255,.22);background:rgba(255,255,255,.14)}
    .foot{padding:0 22px 18px;color:var(--muted);font-size:12px;line-height:1.45}

    @media (max-width: 680px){
      .hero{flex-direction:column;align-items:flex-start}
      .meta{text-align:left}
      .grid{grid-template-columns:1fr}
      .actions{flex-direction:column;align-items:stretch}
      .btns{width:100%}
      .btn{width:100%}
    }

    @media print{
      body{background:#fff;color:#111;padding:0}
      .top{display:none}
      .card{box-shadow:none;border:1px solid #ddd;background:#fff}
      .actions,.foot{display:none}
      .field{border:1px solid #eee;background:#fff}
      .label{color:#555}
      .value{color:#111}
      .hgroup p{color:#555}
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <div class="brand"><span class="dot"></span><span>FENATS · Validación de Socio</span></div>
      <div class="meta">
        <div><b>Validado:</b> ${escapeHtml(formatCLDateTime(checkedAt))}</div>
        <div>Uso: verificación de convenios</div>
      </div>
    </div>

    <div class="card">
      <div class="hero">
        <div class="hgroup">
          <h1>${safeTitle}</h1>
          <p>${escapeHtml(statusMeta.subtitle)}</p>
        </div>
        <div class="badge"><span class="pill"></span><span>${escapeHtml(statusMeta.badge)}</span></div>
      </div>

      <div class="grid">
        <div class="field"><div class="label">Nombre</div><div class="value">${safeName}</div></div>
        <div class="field"><div class="label">RUT</div><div class="value">${safeRut}</div></div>
        <div class="field"><div class="label">Filial</div><div class="value">${safeAffiliate}</div></div>
        <div class="field"><div class="label">Estado</div><div class="value">${escapeHtml(
          status === "ACTIVE" ? "Activo" : status === "INACTIVE" ? "Inactivo" : "No encontrado"
        )}</div></div>
      </div>

      <div class="hr"></div>

      <div class="actions">
        <div class="btns">
          <button class="btn btnPrimary" onclick="window.print()">Imprimir</button>
          <a class="btn" href="${escapeHtml(credencialUrl)}" target="_blank" rel="noreferrer">Ver credencial</a>
        </div>
        <div style="color:var(--muted);font-size:12px">Si hay inconsistencia, contacte a la directiva FENATS.</div>
      </div>

      <div class="foot">
        Esta página confirma únicamente la <b>vigencia</b> del socio para efectos de convenios.
        No expone información sensible adicional.
      </div>
    </div>
  </div>
</body>
</html>`;
}


