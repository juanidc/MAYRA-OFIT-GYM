const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const envPath = path.join(root, ".env");
const dbPath = path.join(root, "data", "db.json");

function loadEnv() {
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index < 1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}

function mapClass(item) {
  return {
    id: Number(item.id),
    actividad_id: String(item.activityId || "").trim(),
    titulo: String(item.title || "").trim(),
    profesor: String(item.coach || "OFIT").trim() || "OFIT",
    dia: String(item.day || "").trim(),
    horario: String(item.time || "").trim(),
    reservados: Array.isArray(item.booked) ? item.booked.map(Number).filter(Boolean) : [],
    descripcion: String(item.focus || "").trim() || null,
    activo: true
  };
}

async function main() {
  loadEnv();
  const { supabaseConfigured, supabaseRequest } = require("../supabase");
  if (!supabaseConfigured()) throw new Error("Supabase no esta configurado.");
  if (!fs.existsSync(dbPath)) throw new Error("No existe data/db.json.");

  const db = JSON.parse(fs.readFileSync(dbPath, "utf8"));
  const classes = Array.isArray(db.classes) ? db.classes : [];
  const rows = classes.map(mapClass);

  if (!rows.length) {
    console.log("No hay clases locales para migrar.");
    return;
  }

  const result = await supabaseRequest("clases?on_conflict=id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: rows,
    serviceRole: true
  });

  console.log(`Migradas ${Array.isArray(result) ? result.length : rows.length} clases a Supabase.`);
}

main().catch(error => {
  const details = [
    error.message,
    error.statusCode ? `status=${error.statusCode}` : "",
    error.data ? `data=${JSON.stringify(error.data)}` : "",
    error.code ? `code=${error.code}` : ""
  ].filter(Boolean).join(" ");
  console.error(details || "Error desconocido.");
  process.exitCode = 1;
});
