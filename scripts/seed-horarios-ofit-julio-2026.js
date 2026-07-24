const fs = require("fs");
const path = require("path");

const dbPath = path.join(__dirname, "..", "data", "db.json");
const envPath = path.join(__dirname, "..", ".env");

if (fs.existsSync(envPath)) {
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

const { supabaseRequest } = require("../supabase");

const activityNames = {
  funcional: "Funcional",
  spinning: "Spinning",
  calistenia: "Calistenia",
  conexion: "Conexion Postural",
  running: "Running",
  "urbano-kids": "Urbano Kids",
  "acrotelas-kids": "Acrotelas Kids",
  "acrotelas-teens": "Acrotelas Teens",
  "acrotelas-adultxs": "Acrotelas Adultxs",
  "acrotelas-multiedad": "Acrotelas Multiedad",
  "bici-libre": "Bici Libre"
};

const descriptions = {
  funcional: "Entrenamiento funcional grupal.",
  spinning: "Clase grupal de spinning.",
  calistenia: "Fuerza y control con peso corporal.",
  conexion: "Movilidad, postura y conciencia corporal.",
  running: "Entrenamiento de running.",
  "urbano-kids": "Urbano para chicos.",
  "acrotelas-kids": "Acrotelas para chicos.",
  "acrotelas-teens": "Acrotelas para teens.",
  "acrotelas-adultxs": "Acrotelas para adultxs.",
  "acrotelas-multiedad": "Acrotelas multiedad.",
  "bici-libre": "Lun, mier y vier de 17 a 19 hs. Valido solo para pase libre."
};

const schedule = [
  ["Martes", "08:00", "calistenia"],
  ["Jueves", "08:00", "calistenia"],
  ["Miercoles", "08:30", "conexion"],
  ["Martes", "09:00", "spinning"],
  ["Jueves", "09:00", "spinning"],
  ["Lunes", "09:30", "funcional", "E.Funcional"],
  ["Miercoles", "09:30", "funcional", "E.Funcional"],
  ["Viernes", "09:30", "funcional", "E.Funcional"],
  ["Sabado", "10:00", "acrotelas-teens"],
  ["Lunes", "10:30", "spinning"],
  ["Miercoles", "10:30", "spinning"],
  ["Viernes", "10:30", "spinning"],
  ["Sabado", "11:00", "acrotelas-kids"],
  ["Martes", "15:00", "conexion"],
  ["Jueves", "15:00", "conexion"],
  ["Viernes", "15:00", "conexion"],
  ["Martes", "16:00", "conexion"],
  ["Jueves", "16:00", "conexion"],
  ["Sabado", "16:00", "urbano-kids"],
  ["Lunes", "17:00", "funcional", "E.Funcional"],
  ["Miercoles", "17:00", "funcional", "E.Funcional"],
  ["Miercoles", "17:00", "acrotelas-teens"],
  ["Viernes", "17:00", "funcional", "E.Funcional"],
  ["Lunes", "17:00", "bici-libre"],
  ["Miercoles", "17:00", "bici-libre"],
  ["Viernes", "17:00", "bici-libre"],
  ["Martes", "17:30", "urbano-kids"],
  ["Lunes", "18:00", "acrotelas-multiedad"],
  ["Lunes", "18:00", "calistenia"],
  ["Miercoles", "18:00", "calistenia"],
  ["Miercoles", "18:00", "acrotelas-kids"],
  ["Viernes", "18:00", "calistenia"],
  ["Lunes", "19:00", "funcional", "E.Funcional"],
  ["Lunes", "19:00", "spinning"],
  ["Lunes", "19:00", "acrotelas-adultxs"],
  ["Martes", "19:00", "conexion"],
  ["Miercoles", "19:00", "funcional", "E.Funcional"],
  ["Miercoles", "19:00", "spinning"],
  ["Jueves", "19:00", "conexion"],
  ["Viernes", "19:00", "funcional", "E.Funcional"],
  ["Viernes", "19:00", "spinning"],
  ["Martes", "20:00", "conexion"],
  ["Miercoles", "20:00", "running"],
  ["Jueves", "20:00", "conexion"],
  ["Viernes", "20:00", "running"]
];

function syncActivities() {
  const db = JSON.parse(fs.readFileSync(dbPath, "utf8"));
  const existing = new Set((db.activities || []).map(activity => activity.id));
  Object.entries(activityNames).forEach(([id, name]) => {
    if (!existing.has(id)) db.activities.push({ id, name });
  });
  fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
}

function rowToClass(row, index) {
  const [day, time, activityId, customTitle] = row;
  const title = customTitle || activityNames[activityId] || activityId;
  return {
    id: index + 1,
    actividad_id: activityId,
    titulo: title,
    profesor: "OFIT",
    dia: day,
    horario: time,
    reservados: [],
    descripcion: descriptions[activityId] || "",
    activo: true,
    updated_at: new Date().toISOString()
  };
}

async function main() {
  syncActivities();
  await supabaseRequest("clases?id=gte.0", {
    method: "DELETE",
    serviceRole: true,
    headers: { Prefer: "return=minimal" }
  });
  const rows = schedule.map(rowToClass);
  await supabaseRequest("clases", {
    method: "POST",
    body: rows,
    serviceRole: true
  });
  console.log(`Horarios OFIT cargados: ${rows.length} clases.`);
}

main().catch(error => {
  console.error(error.message);
  if (error.data) console.error(JSON.stringify(error.data, null, 2));
  process.exit(1);
});
