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

function dateOrNull(value) {
  const text = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function timestampOrNull(value) {
  const date = dateOrNull(value);
  return date ? `${date}T00:00:00.000Z` : undefined;
}

function splitName(fullName) {
  const clean = String(fullName || "").trim().replace(/\s+/g, " ");
  if (!clean) return { nombre: "", apellido: "" };
  const parts = clean.split(" ");
  if (parts.length === 1) return { nombre: clean, apellido: "" };
  return { nombre: parts[0], apellido: parts.slice(1).join(" ") };
}

function mapMemberToCliente(member) {
  const { nombre, apellido } = splitName(member.name);
  const createdAt = timestampOrNull(member.registeredAt);
  const row = {
    id: Number(member.id),
    nombre,
    apellido,
    nombre_completo: String(member.name || "").trim(),
    telefono: null,
    fecha_vencimiento: null,
    activo: true,
    observaciones: String(member.bodyNote || "").trim() || null,
    email: String(member.email || "").trim().toLowerCase() || null,
    dni: String(member.dni || "").trim() || null,
    tipo_alumno: member.memberType === "non-member" ? "No socio" : "Socio",
    estado_pago: member.payment === "paid" ? "Al dia" : "Pendiente",
    numero_alumno: Number(member.memberNumber) || null,
    patologia: String(member.bodyNote || "").trim() || null,
    fecha_nacimiento: dateOrNull(member.birthdate),
    usuario: String(member.user || "").trim() || null,
    password_hash: String(member.passwordHash || "").trim() || null,
    actividades: Array.isArray(member.activityIds) ? member.activityIds : [],
    asistencia: Number(member.attendance) || 0,
    constancia: Number(member.consistency) || 0,
    origen: String(member.source || "").trim() || null,
    ultimo_movimiento: String(member.last || "").trim() || null
  };

  if (createdAt) row.created_at = createdAt;
  return row;
}

async function main() {
  loadEnv();
  const { supabaseConfigured, supabaseRequest } = require("../supabase");
  if (!supabaseConfigured()) throw new Error("Supabase no esta configurado.");
  if (!fs.existsSync(dbPath)) throw new Error("No existe data/db.json.");

  const db = JSON.parse(fs.readFileSync(dbPath, "utf8"));
  const members = Array.isArray(db.members) ? db.members : [];
  const rows = members.map(mapMemberToCliente);

  if (!rows.length) {
    console.log("No hay alumnos locales para migrar.");
    return;
  }

  const result = await supabaseRequest("clientes?on_conflict=id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: rows,
    serviceRole: true
  });

  console.log(`Migrados ${Array.isArray(result) ? result.length : rows.length} alumnos a Supabase.`);
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
