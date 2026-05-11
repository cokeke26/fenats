import ExcelJS from "exceljs";

export type FenatsRow = {
  rutRaw: string;
  fullName: string;
  genderText: string | null;
  affiliate: string; // columna BASE — obligatoria
};

export type ParseResult = {
  rows: FenatsRow[];
  errors: { rowNum: number; reason: string }[];
};

function norm(v: unknown) {
  return String(v ?? "").trim();
}

function upper(v: unknown) {
  return norm(v).toUpperCase();
}

function isLikelyRutNumber(s: string) {
  return /^[0-9]+$/.test(s) && s.length >= 6 && s.length <= 9;
}

function isLikelyDV(s: string) {
  return /^[0-9K]$/.test(s);
}

function joinRutDv(rutPart: string, dvPart: string) {
  const r  = norm(rutPart).replace(/[^0-9]/g, "");
  const dv = upper(dvPart).replace(/[^0-9K]/g, "");
  if (!r || !dv) return "";
  return `${r}-${dv}`;
}

/**
 * Lee Excel FENATS aunque la tabla no parta en A1.
 *
 * Soporta tres formatos de RUT:
 *   A) "RUT" + "DV" en columnas separadas
 *   B) "RUT DV" en una sola columna
 *   C) "RUT" en una sola columna con DV incluido  ← formato real FENATS
 *
 * Encabezados detectados sin importar mayúsculas/minúsculas.
 * Retorna filas válidas + lista de errores por número de fila Excel.
 */
export async function parseFenatsExcel(buffer: Buffer): Promise<ParseResult> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);

  const ws = wb.worksheets[0];
  if (!ws) return { rows: [], errors: [] };

  // ExcelJS indexa desde 1 — row.values[0] siempre es undefined, slice(1) lo elimina
  const grid: unknown[][] = [];
  ws.eachRow({ includeEmpty: true }, (row: ExcelJS.Row) => {
    grid.push((row.values as unknown[]).slice(1));
  });

  let headerRow = -1;
  let rutCol    = -1;
  let dvCol     = -1;
  let rutDvCol  = -1;
  let nameCol   = -1;
  let genderCol = -1;
  let baseCol   = -1;

  for (let r = 0; r < grid.length; r++) {
    const row = grid[r] ?? [];

    const idxRut   = row.findIndex((c) => upper(c) === "RUT");
    const idxDv    = row.findIndex((c) => upper(c) === "DV");
    const idxRutDv = row.findIndex((c) => upper(c) === "RUT DV");
    const idxNom   = row.findIndex((c) => upper(c) === "NOMBRE");
    const idxGen   = row.findIndex((c) => upper(c) === "GENERO");
    const idxBase  = row.findIndex((c) => upper(c) === "BASE");

    if (idxRut !== -1 && idxDv !== -1 && idxNom !== -1) {
      headerRow = r; rutCol = idxRut; dvCol = idxDv;
      nameCol = idxNom; genderCol = idxGen; baseCol = idxBase;
      break;
    }

    if (idxRutDv !== -1 && idxNom !== -1) {
      headerRow = r; rutDvCol = idxRutDv;
      nameCol = idxNom; genderCol = idxGen; baseCol = idxBase;
      break;
    }

    if (idxRut !== -1 && idxDv === -1 && idxNom !== -1) {
      headerRow = r; rutDvCol = idxRut;
      nameCol = idxNom; genderCol = idxGen; baseCol = idxBase;
      break;
    }
  }

  if (headerRow === -1) return { rows: [], errors: [] };

  const rows: FenatsRow[]                            = [];
  const errors: { rowNum: number; reason: string }[] = [];
  let emptyStreak = 0;

  for (let r = headerRow + 1; r < grid.length; r++) {
    const row         = grid[r] ?? [];
    const excelRowNum = r + 1;

    const fullName   = norm(row[nameCol]);
    const genderText = genderCol >= 0 ? (norm(row[genderCol]) || null) : null;
    const affiliate  = baseCol   >= 0 ? norm(row[baseCol])             : "";

    let rutRaw = "";

    if (rutDvCol >= 0) {
      rutRaw = norm(row[rutDvCol]);
    } else {
      const rutPart = norm(row[rutCol]);
      const dvPart  = norm(row[dvCol]);
      if (rutPart && dvPart) {
        rutRaw = joinRutDv(rutPart, dvPart);
      } else if (rutPart) {
        rutRaw = rutPart;
      }
    }

    rutRaw = rutRaw.replace(/\s+/g, "").toUpperCase();

    const hasAnyData = !!(rutRaw || fullName || genderText || affiliate);
    if (!hasAnyData) {
      emptyStreak++;
      if (emptyStreak >= 25) break;
      continue;
    }
    emptyStreak = 0;

    if (rutDvCol < 0) {
      const rutPart = norm(row[rutCol]).replace(/[^0-9]/g, "");
      const dvPart  = upper(row[dvCol]).replace(/[^0-9K]/g, "");
      if (rutPart && (!isLikelyRutNumber(rutPart) || (dvPart && !isLikelyDV(dvPart)))) {
        continue;
      }
    }

    if (!fullName) {
      errors.push({ rowNum: excelRowNum, reason: "Falta el nombre." });
      continue;
    }

    if (!rutRaw) {
      errors.push({ rowNum: excelRowNum, reason: `Falta el RUT (nombre: ${fullName}).` });
      continue;
    }

    if (!affiliate) {
      errors.push({
        rowNum: excelRowNum,
        reason: `Falta la BASE/Filial (nombre: ${fullName}, RUT: ${rutRaw}).`,
      });
      continue;
    }

    rows.push({ rutRaw, fullName, genderText, affiliate });
  }

  return { rows, errors };
}

