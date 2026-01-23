import * as XLSX from "xlsx";

export type FenatsRow = {
  rutRaw: string;          // "10017452-9" o "10017452" + DV
  fullName: string;        // nombre completo
  genderText: string | null;
};

function norm(v: unknown) {
  return String(v ?? "").trim();
}

function upper(v: unknown) {
  return norm(v).toUpperCase();
}

function isLikelyRutNumber(s: string) {
  // Solo dígitos, largo razonable para RUT (sin DV)
  return /^[0-9]+$/.test(s) && s.length >= 6 && s.length <= 9;
}

function isLikelyDV(s: string) {
  // DV puede ser 0-9 o K
  return /^[0-9K]$/.test(s);
}

function joinRutDv(rutPart: string, dvPart: string) {
  const r = norm(rutPart).replace(/[^0-9]/g, "");
  const dv = upper(dvPart).replace(/[^0-9K]/g, "");
  if (!r || !dv) return "";
  return `${r}-${dv}`;
}

/**
 * Lee Excel FENATS aunque la tabla no parta en A1.
 * Soporta encabezados:
 *  - "RUT" + "DV" en columnas separadas
 *  - "RUT DV" en una sola columna
 * Requiere además "NOMBRE" y opcional "GENERO".
 */
export function parseFenatsExcel(buffer: Buffer): FenatsRow[] {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const wsName = wb.SheetNames[0];
  const ws = wb.Sheets[wsName];
  if (!ws) return [];

  // Matriz (array-of-arrays) para escaneo
  const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: false });

  let headerRow = -1;

  // Caso A: RUT + DV separados
  let rutCol = -1;
  let dvCol = -1;

  // Caso B: RUT DV en una sola columna
  let rutDvCol = -1;

  let nameCol = -1;
  let genderCol = -1;

  // 1) Buscar encabezado de la tabla (prioriza "RUT" + "DV")
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r] ?? [];
    const idxRut = row.findIndex((c) => upper(c) === "RUT");
    const idxDv = row.findIndex((c) => upper(c) === "DV");
    const idxRutDv = row.findIndex((c) => upper(c) === "RUT DV");
    const idxNom = row.findIndex((c) => upper(c) === "NOMBRE");
    const idxGen = row.findIndex((c) => upper(c) === "GENERO");

    // Preferimos RUT + DV separados (como tu archivo)
    if (idxRut !== -1 && idxDv !== -1 && idxNom !== -1) {
      headerRow = r;
      rutCol = idxRut;
      dvCol = idxDv;
      nameCol = idxNom;
      genderCol = idxGen; // puede ser -1 (opcional)
      break;
    }

    // Fallback: RUT DV en una sola columna
    if (idxRutDv !== -1 && idxNom !== -1) {
      headerRow = r;
      rutDvCol = idxRutDv;
      nameCol = idxNom;
      genderCol = idxGen;
      break;
    }
  }

  if (headerRow === -1) return [];

  // 2) Leer filas: no "break" por primer vacío; paramos cuando ya no hay datos por un rato
  const out: FenatsRow[] = [];
  let emptyStreak = 0;

  for (let r = headerRow + 1; r < grid.length; r++) {
    const row = grid[r] ?? [];

    // Nombre
    const fullName = norm(row[nameCol]);
    const genderText = genderCol >= 0 ? (norm(row[genderCol]) || null) : null;

    // RUT
    let rutRaw = "";

    if (rutDvCol >= 0) {
      // "RUT DV" en una sola celda
      rutRaw = norm(row[rutDvCol]);
    } else {
      const rutPart = norm(row[rutCol]);
      const dvPart = norm(row[dvCol]);

      // A veces el rut viene como número y el DV separado
      if (rutPart && dvPart) {
        rutRaw = joinRutDv(rutPart, dvPart);
      } else if (rutPart) {
        // Si por algún motivo el DV viene pegado o la celda trae "10017452-9"
        rutRaw = rutPart;
      }
    }

    // Normalización mínima: si viene "10017452 9" o "10017452-9", lo dejamos consistente
    rutRaw = rutRaw.replace(/\s+/g, "").toUpperCase();

    // Filas basura / pivots / títulos: si no parecen datos, las saltamos
    const hasAnyData = !!(rutRaw || fullName || genderText);
    if (!hasAnyData) {
      emptyStreak++;
      if (emptyStreak >= 25) break; // corta si ya estamos lejos de la tabla
      continue;
    }
    emptyStreak = 0;

    // Validaciones suaves para evitar capturar la tabla pivot u otras cosas
    // Si tenemos rutCol/dvCol separados, aseguramos que parezcan RUT y DV
    if (rutDvCol < 0) {
      const rutPart = norm(row[rutCol]).replace(/[^0-9]/g, "");
      const dvPart = upper(row[dvCol]).replace(/[^0-9K]/g, "");

      // Si no calza, probablemente es otra tabla, saltar
      if (rutPart && (!isLikelyRutNumber(rutPart) || (dvPart && !isLikelyDV(dvPart)))) {
        continue;
      }
    }

    // Si no hay nombre, no lo importamos (tu regla original)
    if (!fullName) continue;

    // Si no hay rut, no lo importamos
    if (!rutRaw) continue;

    out.push({ rutRaw, fullName, genderText });
  }

  return out;
}

