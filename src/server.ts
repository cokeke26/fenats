import "dotenv/config";
import path from "node:path";
import express from "express";
import type { Request, Response } from "express";
import QRCode from "qrcode";
import session from "express-session";
import helmet from "helmet";
import connectPgSimple from "connect-pg-simple";
import pg from "pg";

import { prisma } from "./db/prisma.js";
import { adminRouter } from "./admin/admin.routes.js";

const app = express();
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      scriptSrc: ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
    },
  },
}));
const port = Number(process.env.PORT || 3000);

const pgPool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});
const PgStore = connectPgSimple(session);

const sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret && process.env.NODE_ENV === "production") {
  throw new Error("SESSION_SECRET no está definido. Configúralo en .env antes de iniciar en producción.");
}

function getBaseUrl(req?: Request) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL;
  if (req) return `${req.protocol}://${req.get("host")}`;
  return `http://localhost:${port}`;
}

app.get("/health", (_req, res) => res.json({ ok: true }));

app.set("view engine", "ejs");
app.set("views", path.join(process.cwd(), "src", "views"));

app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    secret: sessionSecret ?? "dev-secret-only",
    resave: false,
    saveUninitialized: false,
    store: new PgStore({
      pool: pgPool,
      createTableIfMissing: true, // crea la tabla automáticamente, sin migration
    }),
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 8 * 60 * 60 * 1000,
    },
  })
);

app.use("/assets", express.static(path.join(process.cwd(), "assets")));
app.use("/admin", adminRouter);

// ── Página principal pública ──
app.get("/", async (req: Request, res: Response) => {
  try {
    const [posts, photos, convenios, memberCount] = await Promise.all([
      prisma.post.findMany({
        where: { published: true },
        orderBy: { createdAt: "desc" },
        take: 6,
      }),
      prisma.photo.findMany({ orderBy: { createdAt: "desc" }, take: 5 }),
      prisma.convenio.findMany({ where: { active: true }, orderBy: { createdAt: "asc" } }),
      prisma.member.count({ where: { status: "ACTIVE" } }),
    ]);

    res.render("home", { posts, photos, convenios, memberCount, convenioCount: convenios.length });
  } catch (e: any) {
    res.status(500).send(`Error cargando página principal: ${String(e?.message ?? e)}`);
  }
});

// ── Página de Historia de FENATS ──
app.get("/historia", (req: Request, res: Response) => {
  // TODO: Cargar desde DB o archivos
  // Por ahora, datos de ejemplo
  const historia = {
    contenido: `
      <p>FENATS, es un Sindicato, que a lo largo de su historia ha representado trabajadores de la Salud, es multiestamental y pluralista, La Incorporación se realiza a través de un sistema de afiliación voluntaria, mediante el cual se adquiere la condición de socio de la Asociación FENATS, existente en cada uno de los Hospitales Públicos de todo el país.</p>
      <p>La historia de FENATS se remonta al año 1946, donde los trabajadores/as de la Salud comienzan a reunirse en grupos organizados al interior de los establecimientos hospitalarios, sólo por asociatividad, sin ningún respaldo legal. Esto cambia en el año 1968, cuando el Decreto Supremo de Justicia Nº 1706, la Federación Nacional de Trabajadores de la Salud FENATS, adquiere su Personalidad Jurídica, como corporación de derecho privado.  Por esta misma época, los trabajadores ya organizados, transforman su organización en sindical y social. Esta última condición, los lleva a unirse al movimiento obrero de Chile.</p>
      <p>Los trabajadores de la salud organizados sindicalmente y con el reconocimiento de las autoridades de la época, dio paso a una importante lucha reivindicativa, produciéndose las primeras movilizaciones de trabajadores/as. La lucha de esos años, permitió importantes avances para el movimiento social, que se concretaron posteriormente durante el Gobierno del Dr. Salvador Allende G.</p>
      <p>Dentro de las reivindicaciones de esa época se encuentran las siguientes: Asignación Trienal, Reconocimientos de escalafones por especialidad, Goce de grado superior, Jubilación, entre otros temas. Estos logros obtenidos por los trabajadores, fueron transgredidos a partir del año 1973, con la instauración de la dictadura Militar, lo que limitó además el accionar de los dirigentes sindicales, haciendo que lo obtenido por largos años, fuera prácticamente abolido.</p>
      <p>Posteriormente, a raíz de la instauración definitiva de la dictadura militar, se comienza a vivir la etapa más dolorosa y aberrante del movimiento sindical chileno.  Se impidió la organización de los trabajadores de la salud, donde dirigentes y trabajadores sufrieron el exilio, la exoneración,  la detención y la desaparición.  En nuestra región, el 3 de octubre de 1973, en el Hospital Coronel  fue detenido el dirigente Zenon Sáez Fuentes, quién hasta el día de hoy se encuentra entre los nombres de los detenidos y desaparecidos.  Esto conlleva un retroceso enorme, en función de las reivindicaciones laborales, que se habían obtenido con esfuerzo de todos los trabajadores y sus dirigentes.</p>
      <p>Cuando se produce el retorno a la democracia, se retoman las actividades sindicales, con la confianza de reestablecer las mejoras tan anheladas por todos, pero es un proceso lento y sólo a partir de la promulgación de la ley 19296, el 14 de marzo de 1994, se establecen las normas para las Asociaciones de funcionarios de la Administración del Estado. El día 27 de Julio de 1995, se consolidan los estatutos de las tres instancias o formas de Organización, que tiene nuestro sindicato; las Asociaciones en cada uno de los establecimientos de Salud, la Federación a nivel Regional y la Confederación a nivel Nacional.</p>
      <p>Los trabajadores/as vuelven a la lucha reivindicativa, que con los años ha significado grandes logros para todos los trabajadores/as de la Salud, en los cuales se encuentran, por ejemplo: Encasillamiento en los años 1996, 2006 y 2016, Traspaso de Honorarios a la contrata, Incentivo al retiro, Derecho a la alimentación, Mejoramiento de la Asignación de 4º turno, Nivelación del porcentaje de la ley 19.490, Aumento de trienios, entre otras.</p>
      <p>La Federación Fenats Octava región esta compuesta por 31 Asociaciones de funcionarios pertenecientes a las provincias de Arauco, Bío-Bio, Concepción, Talcahuano y la región de Ñuble. Cuenta con más de 9.000 socios afiliados.</p>    
    `,
  };

  // 9 personas en la directiva - LISTOS PARA AGREGAR FOTOS Y NOMBRES
  const directiva = [
    { nombre: "Evelyn Betancourt Gálvez", cargo: "Presidenta ", establecimiento: "Hospital Penco-Lirquén", foto: "/assets/photos/evelyn.jpg" },
    { nombre: "Ana Soto Jara ", cargo: "Secretaria", establecimiento: "Hospital Guillermo Grant Benavente", foto: "/assets/photos/secretaria.jpg" },
    { nombre: "Gloria Cancino Marín ", cargo: "Tesorera", establecimiento: "Hospital Traumatológico", foto: "/assets/photos/tesorera.jpg" },
    { nombre: "Claudia Diaz Espinoza ", cargo: "Secretaria de Organización", establecimiento: "Hospital de Huépil", foto: "/assets/photos/secreorg.jpg" },
    { nombre: "Guillermo Fierro Garcés", cargo: "Secretario de Actas", establecimiento: "Hospital de Lebu", foto: "/assets/photos/secreactas.jpg" },
    { nombre: "Adolfo Becar Troncoso ", cargo: "1° Director", establecimiento: "Hospital Guillermo Grant Benavente", foto: "/assets/photos/1erdirector.jpg" },
    { nombre: "Leonardo Recabal Pincheira ", cargo: "2° Director", establecimiento: "Hospital Cañete", foto: "/assets/photos/2dodirector.jpg" },
    { nombre: "Jorge Urrutia Ruiz ", cargo: "3° Director", establecimiento: "CESFAM Víctor Manuel Fernández", foto: "/assets/photos/3erdirector.jpg" },
    { nombre: "María Curin Rivas ", cargo: "4° Director", establecimiento: "Hospital Traumatológico", foto: "/assets/photos/4todirector.jpg" },
  ];

  res.render("historia", {
    historia,
    directiva,
    organigrama: { imagen: "/assets/photos/organigrama.png" },
  });
});

app.get("/login-member", (req: Request, res: Response) => {
  res.render("member/login-member", { error: null, rut: "" });
});

app.post("/login-member", async (req: Request, res: Response) => {
  try {
    const rutInput = String(req.body.rut ?? "").trim();
    if (!rutInput) {
      return res.status(400).render("member/login-member", { error: "Debes ingresar tu RUT.", rut: rutInput });
    }
    const rut = normalizeRutMember(rutInput);
    if (!rut) {
      return res.status(400).render("member/login-member", {
        error: "RUT inválido. Debe incluir DV (ej: 9.313.137-1).", rut: rutInput,
      });
    }
    const member = await prisma.member.findUnique({ where: { rut } });
    if (!member) {
      return res.status(404).render("member/login-member", {
        error: "No encontramos tu RUT en el sistema. Verifica el DV o contacta a tu base.", rut: rutInput,
      });
    }
    return res.redirect(`/credencial/${encodeURIComponent(member.token)}`);
  } catch (e: any) {
    return res.status(500).render("member/login-member", {
      error: `Error interno: ${String(e?.message ?? e)}`, rut: String(req.body.rut ?? ""),
    });
  }
});

function normalizeRutMember(raw: string) {
  const s = String(raw ?? "").trim().toUpperCase();
  const compact = s.replace(/[^0-9K]/g, "");
  if (compact.length < 2) return "";
  const dv  = compact.slice(-1);
  const num = compact.slice(0, -1).replace(/^0+/, "") || "0";
  return `${num}-${dv}`;
}

/* ── Validación pública /s/:token ── */
app.get("/s/:token", async (req: Request, res: Response) => {
  try {
    const token     = String(req.params.token || "").trim();
    const checkedAt = new Date();
    const member    = await prisma.member.findUnique({ where: { token } });

    if (!member) {
      return res.status(404).send(renderValidation({
        title: "Código no válido", status: "INVALID",
        fullName: "", rutMasked: "", affiliate: "",
        checkedAt, token, baseUrl: getBaseUrl(req),
      }));
    }

    const isActive = member.status === "ACTIVE";
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.send(renderValidation({
      title: isActive ? "Socio vigente" : "Socio no vigente",
      status: isActive ? "ACTIVE" : "INACTIVE",
      fullName: member.fullName, rutMasked: member.rutMasked,
      affiliate: member.affiliate ?? "-",
      checkedAt, token: member.token, baseUrl: getBaseUrl(req),
    }));
  } catch (e: any) {
    res.status(500).send(`Error al validar socio: ${String(e?.message ?? e)}`);
  }
});

/* ── QR PNG ── */
app.get("/qr/:token.png", async (req: Request, res: Response) => {
  try {
    const token  = String(req.params.token || "").trim();
    const member = await prisma.member.findUnique({ where: { token } });
    if (!member) return res.status(404).send("Token no encontrado");

    const png = await QRCode.toBuffer(`${getBaseUrl(req)}/s/${encodeURIComponent(token)}`, {
      type: "png", errorCorrectionLevel: "M", margin: 2, scale: 8,
    });

    res.set("Content-Type", "image/png");
    res.set("Cache-Control", "no-store");
    res.send(png);
  } catch (e: any) {
    res.status(500).send(`Error generando QR: ${String(e?.message ?? e)}`);
  }
});

/* ── Credencial imprimible /credencial/:token ── */
app.get("/credencial/:token", async (req: Request, res: Response) => {
  try {
    const token  = String(req.params.token || "").trim();
    const member = await prisma.member.findUnique({ where: { token } });
    if (!member) return res.status(404).send("No encontrado");

    const baseUrl     = getBaseUrl(req);
    const validateUrl = `${baseUrl}/s/${encodeURIComponent(token)}`;
    const qrPngUrl    = `${baseUrl}/qr/${encodeURIComponent(token)}.png`;
    const logoUrl     = `${baseUrl}/assets/screenshots/logo_fenats.jpeg`;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Credencial FENATS · ${escapeHtml(member.rutMasked)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com"/>
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
  <link href="https://fonts.googleapis.com/css2?family=Barlow:wght@400;600&family=Barlow+Condensed:wght@700;900&display=swap" rel="stylesheet"/>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{min-height:100vh;background:#f4f4f4;font-family:'Barlow',sans-serif;color:#111;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;background-image:radial-gradient(circle at 90% 10%,rgba(212,0,0,.06) 0%,transparent 45%),radial-gradient(circle at 10% 90%,rgba(212,0,0,.04) 0%,transparent 45%);}
    body::before{content:'';display:block;position:fixed;top:0;left:0;right:0;height:5px;background:#d40000;z-index:10;}
    .wrap{width:min(680px,100%);margin-top:5px;}
    .brand{display:flex;align-items:center;gap:14px;margin-bottom:22px;}
    .brand-logo{width:56px;height:56px;object-fit:contain;border-radius:50%;background:white;padding:3px;box-shadow:0 4px 16px rgba(212,0,0,.20);}
    .brand-name{font-family:'Barlow Condensed',sans-serif;font-size:26px;font-weight:900;color:#d40000;letter-spacing:1.5px;text-transform:uppercase;line-height:1.1;}
    .brand-sub{font-size:11px;font-weight:600;color:#666;letter-spacing:0.5px;text-transform:uppercase;}
    .card{background:white;border:1.5px solid #e4e4e4;border-radius:18px;box-shadow:0 1px 4px rgba(0,0,0,.05),0 12px 40px rgba(0,0,0,.08);overflow:hidden;}
    .card-head{background:#d40000;padding:18px 24px 16px;}
    .card-head-title{font-family:'Barlow Condensed',sans-serif;font-size:20px;font-weight:900;color:white;letter-spacing:0.5px;text-transform:uppercase;}
    .card-head-sub{font-size:11px;color:rgba(255,255,255,.75);margin-top:3px;}
    .card-body{padding:22px 24px;}
    .main-row{display:flex;gap:20px;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;}
    .info{flex:1;min-width:220px;}
    .logo-wrapper{display:flex;align-items:center;justify-content:center;flex-shrink:0;min-width:120px;}
    .logo-card{max-width:120px;width:100%;height:auto;object-fit:contain;border-radius:0;background:transparent;padding:0;box-shadow:none;border:none;}
    .info-row{margin-bottom:14px;}
    .info-label{font-size:11px;font-weight:700;color:#666;letter-spacing:0.8px;text-transform:uppercase;}
    .info-value{font-size:17px;font-weight:700;color:#111;margin-top:2px;}
    .qr-col{display:flex;flex-direction:column;align-items:center;gap:8px;flex-shrink:0;}
    .qr-img{width:160px;height:160px;border:1.5px solid #e4e4e4;border-radius:12px;padding:8px;background:white;}
    .qr-label{font-size:11px;font-weight:700;color:#666;letter-spacing:0.5px;text-transform:uppercase;text-align:center;}
    .divider{height:1px;background:#e4e4e4;margin:4px 0 16px;}
    .btns{display:flex;gap:10px;flex-wrap:wrap;}
    .btn{display:inline-flex;align-items:center;justify-content:center;padding:11px 16px;border-radius:9px;font-family:'Barlow',sans-serif;font-size:13px;font-weight:700;cursor:pointer;text-decoration:none;border:1.5px solid #e4e4e4;background:white;color:#111;transition:background .12s,border-color .12s;}
    .btn:hover{background:#f5f5f5;border-color:#bbb;}
    .btn-primary{background:#d40000;border-color:#d40000;color:white;}
    .btn-primary:hover{background:#b80000;border-color:#b80000;}
    .foot{margin-top:14px;font-size:12px;color:#aaa;line-height:1.5;}
    @media(max-width:500px){.main-row{flex-direction:column;align-items:center;}.qr-img{width:180px;height:180px;}}
    @media print{body::before{display:none;}body{background:white;padding:0;}.wrap{margin-top:0;}.card{box-shadow:none;border:1px solid #ddd;}.brand,.btns,.foot{display:none !important;}}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="brand">
      <img class="brand-logo" src="${logoUrl}" alt="Logo FENATS"/>
      <div>
        <div class="brand-name">FENATS</div>
        <div class="brand-sub">Octava Región · Credencial Digital</div>
      </div>
    </div>
    <div class="card">
      <div class="card-head">
        <div class="card-head-title">Credencial de socio</div>
        <div class="card-head-sub">Presenta este QR para verificar vigencia en convenios</div>
      </div>
      <div class="card-body">
        <div class="main-row">
          <div class="info">
            <div class="info-row"><div class="info-label">Nombre</div><div class="info-value">${escapeHtml(member.fullName)}</div></div>
            <div class="info-row"><div class="info-label">RUT</div><div class="info-value">${escapeHtml(member.rutMasked)}</div></div>
            <div class="info-row"><div class="info-label">Base</div><div class="info-value">${escapeHtml(member.affiliate ?? "-")}</div></div>
          </div>
          <div class="logo-wrapper" style="align-self:center;">
            <img class="logo-card" src="${logoUrl}" alt="Logo FENATS" />
          </div>
          <div class="qr-col">
            <img class="qr-img" src="${qrPngUrl}" alt="QR de validación"/>
            <div class="qr-label">Escanear para validar</div>
          </div>
        </div>
        <div class="divider"></div>
        <div class="btns">
          <button type="button" class="btn btn-primary" onclick="window.print()">Imprimir</button>
          <a class="btn" href="${qrPngUrl}" download>Descargar QR</a>
          <a class="btn" href="${validateUrl}" target="_blank" rel="noreferrer">Abrir verificación</a>
        </div>
        <div class="foot">Esta credencial facilita el acceso a convenios FENATS. La verificación oficial se realiza escaneando el QR.</div>
      </div>
    </div>
  </div>
</body>
</html>`);
  } catch (e: any) {
    res.status(500).send(`Error cargando credencial: ${String(e?.message ?? e)}`);
  }
});

app.listen(port, () => console.log(`Servidor: http://localhost:${port}`));

type RenderStatus = "ACTIVE" | "INACTIVE" | "INVALID";

function formatCLDateTime(d: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function escapeHtml(s: string) {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderValidation(input: {
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

  const logoUrl = `${baseUrl}/assets/screenshots/logo_fenats.jpeg`;

  const meta =
    status === "ACTIVE"
      ? { badge: "Vigente",    headerBg: "#15803d", subtitle: "Beneficio autorizado para convenios FENATS." }
      : status === "INACTIVE"
      ? { badge: "No vigente", headerBg: "#b45309", subtitle: "Socio no vigente. Beneficio no aplicable." }
      : { badge: "Inválido",   headerBg: "#d40000", subtitle: "El código no corresponde a un socio registrado." };

  const safeName      = escapeHtml(fullName || "-");
  const safeRut       = escapeHtml(rutMasked || "-");
  const safeAffiliate = escapeHtml(affiliate || "-");
  const credencialUrl = `${baseUrl}/credencial/${encodeURIComponent(token)}`;

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>FENATS · Validación</title>
  <link rel="preconnect" href="https://fonts.googleapis.com"/>
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
  <link href="https://fonts.googleapis.com/css2?family=Barlow:wght@400;600&family=Barlow+Condensed:wght@700;900&display=swap" rel="stylesheet"/>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{min-height:100vh;background:#f4f4f4;font-family:'Barlow',sans-serif;color:#111;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;background-image:radial-gradient(circle at 90% 10%,rgba(212,0,0,.06) 0%,transparent 45%),radial-gradient(circle at 10% 90%,rgba(212,0,0,.04) 0%,transparent 45%);}
    body::before{content:'';display:block;position:fixed;top:0;left:0;right:0;height:5px;background:#d40000;z-index:10;}
    .wrap{width:min(680px,100%);margin-top:5px;}
    .top{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:18px;}
    .brand-left{display:flex;align-items:center;gap:12px;}
    .brand-logo{width:48px;height:48px;object-fit:contain;border-radius:50%;background:white;padding:3px;box-shadow:0 3px 12px rgba(212,0,0,.18);}
    .brand-name{font-family:'Barlow Condensed',sans-serif;font-size:22px;font-weight:900;color:#d40000;letter-spacing:1px;text-transform:uppercase;line-height:1.1;}
    .brand-sub{font-size:11px;font-weight:600;color:#666;letter-spacing:0.4px;text-transform:uppercase;}
    .brand-meta{text-align:right;font-size:12px;color:#666;line-height:1.5;}
    .brand-meta b{color:#111;}
    .card{background:white;border:1.5px solid #e4e4e4;border-radius:18px;box-shadow:0 1px 4px rgba(0,0,0,.05),0 12px 40px rgba(0,0,0,.08);overflow:hidden;}
    .card-head{background:${meta.headerBg};padding:20px 24px 18px;display:flex;align-items:flex-start;justify-content:space-between;gap:14px;}
    .card-title{font-family:'Barlow Condensed',sans-serif;font-size:28px;font-weight:900;color:white;letter-spacing:0.3px;text-transform:uppercase;}
    .card-subtitle{margin-top:4px;font-size:13px;color:rgba(255,255,255,.82);line-height:1.4;}
    .badge{display:inline-flex;align-items:center;gap:7px;padding:8px 14px;border-radius:999px;background:rgba(255,255,255,.18);border:1.5px solid rgba(255,255,255,.32);font-family:'Barlow Condensed',sans-serif;font-size:14px;font-weight:900;letter-spacing:0.5px;color:white;white-space:nowrap;flex-shrink:0;}
    .badge-dot{width:8px;height:8px;border-radius:50%;background:white;}
    .card-body{padding:22px 24px 20px;}
    .grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:18px;}
    .field{background:#fafafa;border:1.5px solid #e4e4e4;border-radius:12px;padding:13px 14px;}
    .field-label{font-size:11px;font-weight:700;color:#666;letter-spacing:0.7px;text-transform:uppercase;margin-bottom:5px;}
    .field-value{font-size:16px;font-weight:700;color:#111;word-break:break-word;}
    .divider{height:1px;background:#e4e4e4;margin-bottom:16px;}
    .actions{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;}
    .btns{display:flex;gap:8px;flex-wrap:wrap;}
    .btn{display:inline-flex;align-items:center;justify-content:center;padding:10px 14px;border-radius:9px;font-family:'Barlow',sans-serif;font-size:13px;font-weight:700;cursor:pointer;text-decoration:none;border:1.5px solid #e4e4e4;background:white;color:#111;transition:background .12s,border-color .12s;}
    .btn:hover{background:#f5f5f5;border-color:#bbb;}
    .btn-primary{background:#d40000;border-color:#d40000;color:white;}
    .btn-primary:hover{background:#b80000;}
    .actions-note{font-size:12px;color:#999;}
    .foot{margin-top:14px;font-size:12px;color:#aaa;line-height:1.5;padding-top:14px;border-top:1px solid #e4e4e4;}
    @media(max-width:500px){.grid{grid-template-columns:1fr;}.actions{flex-direction:column;align-items:stretch;}.btns{width:100%;}.btn{width:100%;}.top{flex-direction:column;align-items:flex-start;}.brand-meta{text-align:left;}}
    @media print{body::before{display:none;}body{background:white;padding:0;}.actions,.foot{display:none !important;}.card{box-shadow:none;border:1px solid #ddd;}}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <div class="brand-left">
        <img class="brand-logo" src="${logoUrl}" alt="Logo FENATS"/>
        <div>
          <div class="brand-name">FENATS</div>
          <div class="brand-sub">Octava Región · Validación de Socio</div>
        </div>
      </div>
      <div class="brand-meta">
        <div><b>Validado:</b> ${escapeHtml(formatCLDateTime(checkedAt))}</div>
        <div>Uso: verificación de convenios</div>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <div>
          <div class="card-title">${escapeHtml(title)}</div>
          <div class="card-subtitle">${escapeHtml(meta.subtitle)}</div>
        </div>
        <div class="badge"><span class="badge-dot"></span><span>${escapeHtml(meta.badge)}</span></div>
      </div>
      <div class="card-body">
        <div class="grid">
          <div class="field"><div class="field-label">Nombre</div><div class="field-value">${safeName}</div></div>
          <div class="field"><div class="field-label">RUT</div><div class="field-value">${safeRut}</div></div>
          <div class="field"><div class="field-label">Base</div><div class="field-value">${safeAffiliate}</div></div>
          <div class="field"><div class="field-label">Estado</div><div class="field-value">${escapeHtml(status === "ACTIVE" ? "Activo" : status === "INACTIVE" ? "Inactivo" : "No encontrado")}</div></div>
        </div>
        <div class="divider"></div>
        <div class="actions">
          <div class="btns">
            ${status !== "INVALID" ? `<a class="btn" href="${escapeHtml(credencialUrl)}" target="_blank" rel="noreferrer">Ver credencial</a>` : ""}
          </div>
          <div class="actions-note">Si hay inconsistencia, contacte a la directiva FENATS.</div>
        </div>
        <div class="foot">Esta página confirma únicamente la <b>vigencia</b> del socio para efectos de convenios. No expone información sensible adicional.</div>
      </div>
    </div>
  </div>
</body>
</html>`;
}

