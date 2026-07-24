const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const root = __dirname;
const dataDir = path.join(root, "data");
const dbPath = path.join(dataDir, "db.json");
loadEnv();
const { supabaseConfigured, supabaseRequest, supabaseStorageRequest, testSupabaseConnection } = require("./supabase");

const port = Number(process.env.PORT || 4173);
const sessionTtlMs = Math.max(15, Number(process.env.SESSION_TTL_MINUTES || 480)) * 60 * 1000;
const sessionCookie = process.env.SESSION_COOKIE_NAME || "ofit_session";
const csrfHeader = "x-csrf-token";
const brevoApiKey = process.env.BREVO_API_KEY || "";
const mailFromName = process.env.MAIL_FROM_NAME || "OFIT Gym";
const mailFromEmail = process.env.MAIL_FROM_EMAIL || "";
const adminEmail = process.env.ADMIN_EMAIL || "";
const paymentAlias = "mayofitgym.mp";
const paymentCvu = "0000003100048667750478";
const paymentHolder = "Mayra Gutierrez";
const paymentProofBucket = process.env.SUPABASE_PAYMENT_PROOF_BUCKET || "comprobantes-pago";
const allowedOrigins = String(process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(origin => origin.trim())
  .filter(Boolean);
// Solo confiar en X-Forwarded-For si estas realmente detras de un proxy de confianza (Vercel, Nginx).
// Si no, un atacante puede falsear la IP y evadir los limites de intentos.
const trustProxy = String(process.env.TRUST_PROXY || "").toLowerCase() === "true";

const sessions = new Map();
const loginAttempts = new Map();
const registerAttempts = new Map();
const pendingRegistrations = new Map();

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml"
};

function loadEnv() {
  const envPath = path.join(root, ".env");
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

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(":")) return false;
  const [salt, hash] = stored.split(":");
  const candidate = crypto.scryptSync(String(password), salt, 64);
  const original = Buffer.from(hash, "hex");
  return original.length === candidate.length && crypto.timingSafeEqual(original, candidate);
}

// Versiones asincronas para las rutas HTTP: scrypt corre en el threadpool de libuv y NO bloquea
// el event loop, asi un aluvion de logins/registros no congela al resto de los usuarios.
// (Las versiones sync se siguen usando solo en el arranque: sembrado de DB, auditoria, hash senuelo.)
function hashPasswordAsync(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password), salt, 64, (err, derived) => {
      if (err) return reject(err);
      resolve(`${salt}:${derived.toString("hex")}`);
    });
  });
}

function verifyPasswordAsync(password, stored) {
  return new Promise(resolve => {
    if (!stored || !stored.includes(":")) return resolve(false);
    const [salt, hash] = stored.split(":");
    crypto.scrypt(String(password), salt, 64, (err, derived) => {
      if (err) return resolve(false);
      const original = Buffer.from(hash, "hex");
      resolve(original.length === derived.length && crypto.timingSafeEqual(original, derived));
    });
  });
}

function defaultDb() {
  function initialSecret(name, fallback) {
    if (process.env[name]) return process.env[name];
    if (process.env.NODE_ENV === "production") throw new Error(`Falta configurar ${name} en variables de entorno.`);
    return fallback;
  }
  const adminUser = normalizeUser(process.env.DEFAULT_ADMIN_USER || "admin");
  const coachUser = normalizeUser(process.env.DEFAULT_COACH_USER || "profe");
  const demoUser = normalizeUser(process.env.DEFAULT_DEMO_MEMBER_USER || "ana");
  return {
    staff: [
      { id: 1, user: adminUser, passwordHash: hashPassword(initialSecret("DEFAULT_ADMIN_PASSWORD", "admin123")), role: "admin", label: "Administradora" },
      { id: 2, user: coachUser, passwordHash: hashPassword(initialSecret("DEFAULT_COACH_PASSWORD", "profe123")), role: "coach", label: "Profesor" }
    ],
    members: [
      {
        id: 1,
        name: "Ana Costa",
        user: demoUser,
        passwordHash: hashPassword(initialSecret("DEFAULT_DEMO_MEMBER_PASSWORD", "ana123")),
        dni: "38999888",
        birthdate: "1999-09-20",
        email: "ana@mail.com",
        bodyNote: "Dolor lumbar ocasional.",
        activityIds: ["spinning", "conexion"],
        memberType: "member",
        attendance: 9,
        payment: "due",
        consistency: 68,
        source: "ficha",
        registeredAt: "2026-07-02",
        last: "Hoy 10:08"
      }
    ],
    activities: [
      { id: "funcional", name: "Funcional" },
      { id: "spinning", name: "Spinning" },
      { id: "calistenia", name: "Calistenia" },
      { id: "conexion", name: "Conexion Postural" },
      { id: "running", name: "Running" },
      { id: "urbano-kids", name: "Urbano Kids" },
      { id: "acrotelas-kids", name: "Acrotelas Kids" },
      { id: "acrotelas-teens", name: "Acrotelas Teens" },
      { id: "acrotelas-adultxs", name: "Acrotelas Adultxs" },
      { id: "acrotelas-multiedad", name: "Acrotelas Multiedad" },
      { id: "salsa", name: "Salsa" }
    ],
    classes: [
      { id: 1, activityId: "funcional", title: "Funcional", coach: "OFIT", day: "Lunes", time: "09:30", capacity: 30, booked: [], place: "OFIT Gym", focus: "Clase grupal funcional" },
      { id: 2, activityId: "spinning", title: "Spinning", coach: "OFIT", day: "Lunes", time: "10:30", capacity: 30, booked: [1], place: "OFIT Gym", focus: "Clase grupal de spinning" },
      { id: 3, activityId: "calistenia", title: "Calistenia", coach: "OFIT", day: "Lunes", time: "18:00", capacity: 30, booked: [], place: "OFIT Gym", focus: "Fuerza con peso corporal" },
      { id: 4, activityId: "conexion", title: "Conexion Postural", coach: "OFIT", day: "Martes", time: "15:00", capacity: 30, booked: [1], place: "OFIT Gym", focus: "Movilidad, postura y conciencia corporal" },
      { id: 5, activityId: "running", title: "Running", coach: "OFIT", day: "Viernes", time: "20:00", capacity: 30, booked: [], place: "OFIT Gym", focus: "Entrenamiento de running" },
      { id: 6, activityId: "acrotelas-teens", title: "Acrotelas Teens", coach: "OFIT", day: "Sabado", time: "10:00", capacity: 30, booked: [], place: "OFIT Gym", focus: "Acrotelas teens" }
    ],
    news: defaultNews(),
    accounting: defaultAccounting(),
    paymentProofs: [],
    paymentLink: "https://www.mercadopago.com.ar/"
  };
}

function defaultAccounting() {
  return [];
}

function defaultNews() {
  return [
    { id: 1, title: "Flyer del lunes", category: "Horarios", day: "Lunes", image: "assets/flyer-lunes.jpg", text: "Actividades del lunes en OFIT." },
    { id: 2, title: "Flyer del martes", category: "Horarios", day: "Martes", image: "assets/flyer-martes.jpg", text: "Actividades del martes en OFIT." },
    { id: 3, title: "Flyer del miercoles", category: "Horarios", day: "Miercoles", image: "assets/flyer-miercoles.jpg", text: "Actividades del miercoles en OFIT." },
    { id: 4, title: "Flyer del jueves", category: "Horarios", day: "Jueves", image: "assets/flyer-jueves.jpg", text: "Actividades del jueves en OFIT." },
    { id: 5, title: "Flyer del viernes", category: "Horarios", day: "Viernes", image: "assets/flyer-viernes.jpg", text: "Actividades del viernes en OFIT." },
    { id: 6, title: "Flyer del sabado", category: "Horarios", day: "Sabado", image: "assets/flyer-sabado.jpg", text: "Actividades del sabado en OFIT." }
  ];
}

function ensureDb() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);
  if (!fs.existsSync(dbPath)) writeDb(defaultDb());
}

function readDb() {
  ensureDb();
  try {
    const db = JSON.parse(fs.readFileSync(dbPath, "utf8"));
    if (ensureMemberNumbers(db)) writeDb(db);
    return db;
  } catch (error) {
    // db.json corrupto (p.ej. corte de energia a mitad de escritura): recuperar del backup.
    const bakPath = `${dbPath}.bak`;
    if (fs.existsSync(bakPath)) {
      try {
        const db = JSON.parse(fs.readFileSync(bakPath, "utf8"));
        writeDb(db);
        console.warn("data/db.json estaba corrupto: restaurado desde db.json.bak");
        return db;
      } catch {}
    }
    throw new Error("data/db.json ilegible y sin backup valido: " + error.message);
  }
}

function writeDb(db) {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);
  const serialized = JSON.stringify(db, null, 2);
  const tmpPath = `${dbPath}.tmp`;
  // Escribir en un temporal y renombrar: rename es atomico, nunca queda un db.json a medio escribir.
  fs.writeFileSync(tmpPath, serialized);
  if (fs.existsSync(dbPath)) { try { fs.copyFileSync(dbPath, `${dbPath}.bak`); } catch {} }
  fs.renameSync(tmpPath, dbPath);
}

function ensureMemberNumbers(db) {
  if (!Array.isArray(db.members)) return false;
  let changed = false;
  let next = db.members.reduce((max, member) => Math.max(max, Number(member.memberNumber) || 0), 0) + 1;
  db.members.forEach(member => {
    if (!member.memberNumber) {
      member.memberNumber = next++;
      changed = true;
    }
  });
  return changed;
}

function nextMemberNumber(db) {
  ensureMemberNumbers(db);
  return db.members.reduce((max, member) => Math.max(max, Number(member.memberNumber) || 0), 0) + 1;
}

function normalizeUser(user) {
  return String(user || "").toLowerCase().trim().replace(/\s+/g, ".").replace(/[^a-z0-9._-]/g, "").slice(0, 40);
}

function text(value, max = 120) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeText(value, max = 120) {
  return escapeHtml(text(value, max));
}

function safeUrl(value, fallback = "") {
  try {
    const url = new URL(String(value || ""));
    if (!["https:", "http:"].includes(url.protocol)) return fallback;
    return url.toString();
  } catch {
    return fallback;
  }
}

function stripHtml(value) {
  return String(value || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function brevoReady() {
  return Boolean(brevoApiKey && mailFromEmail && validEmail(mailFromEmail));
}

function sendBrevoEmail({ to, subject, htmlContent }) {
  return new Promise((resolve, reject) => {
    if (!brevoReady()) return reject(new Error("Email no configurado. Falta BREVO_API_KEY o remitente."));
    if (!validEmail(to)) return reject(new Error("El socio no tiene un mail valido."));
    const payload = JSON.stringify({
      sender: { name: mailFromName, email: mailFromEmail },
      to: [{ email: to }],
      subject: text(subject, 140),
      htmlContent,
      textContent: stripHtml(htmlContent)
    });
    const req = https.request({
      hostname: "api.brevo.com",
      path: "/v3/smtp/email",
      method: "POST",
      headers: {
        "accept": "application/json",
        "api-key": brevoApiKey,
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload)
      }
    }, res => {
      let body = "";
      res.on("data", chunk => { body += chunk; });
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(body ? JSON.parse(body) : {});
        reject(new Error(`Brevo respondio ${res.statusCode}: ${body || "sin detalle"}`));
      });
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function mailLayout(title, body) {
  return `<div style="margin:0;padding:28px;background:#f6f2f8;font-family:Arial,sans-serif;color:#17131c">
    <div style="max-width:620px;margin:0 auto;background:#ffffff;border:1px solid #eadff0;border-radius:14px;overflow:hidden">
      <div style="padding:24px 26px;background:linear-gradient(135deg,#241029,#7b2fb8);color:#ffffff">
        <strong style="display:block;font-size:23px;letter-spacing:.2px">${escapeHtml(mailFromName)}</strong>
        <span style="display:block;margin-top:6px;color:#e8d7f5;font-size:14px">Gestion de socios y actividades</span>
      </div>
      <div style="padding:26px">
        <h1 style="font-size:24px;line-height:1.2;margin:0 0 16px;color:#17131c">${escapeHtml(title)}</h1>
        <div style="font-size:16px;line-height:1.58;color:#342d38">${body}</div>
      </div>
    </div>
  </div>`;
}

function paymentReminderHtml(member, db) {
  const link = safeUrl(db.paymentLink, "https://www.mercadopago.com.ar/");
  const dueText = member.dueDate ? `vence el <strong>${safeText(member.dueDate)}</strong>` : "esta proxima a vencer";
  return mailLayout("Recordatorio de cuota", `<p>Hola <strong>${safeText(member.name)}</strong>, te escribimos desde OFIT para recordarte que tu abono ${dueText}.</p>
    <div style="margin:20px 0;padding:16px;border-radius:12px;background:#fbf7ff;border:1px solid #eadff0">
      <strong style="display:block;margin-bottom:6px;color:#6b2ca0">Estado actual: pendiente</strong>
      <span>Si queres regularizarla ahora, podes hacerlo desde el link oficial de pago o por transferencia.</span>
    </div>
    <p style="margin:22px 0"><a href="${link}" style="display:inline-block;background:#7b2fb8;color:#fff;text-decoration:none;padding:14px 22px;border-radius:10px;font-weight:bold">Pagar cuota</a></p>
    <p>Si ya abonaste, no hace falta que respondas este mail: administracion va a actualizar tu estado apenas revise el pago.</p>
    <p style="margin-top:22px;color:#6f6675">Gracias por ser parte de OFIT.</p>`);
}

function paymentReminderStamp(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function daysSinceDate(value) {
  const textValue = String(value || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(textValue)) return Infinity;
  const then = new Date(`${textValue}T00:00:00.000Z`).getTime();
  if (!Number.isFinite(then)) return Infinity;
  return Math.floor((Date.now() - then) / 86400000);
}

function daysUntilDate(value) {
  const textValue = String(value || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(textValue)) return Infinity;
  const target = new Date(`${textValue}T00:00:00.000Z`).getTime();
  if (!Number.isFinite(target)) return Infinity;
  const today = new Date();
  const start = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.ceil((target - start) / 86400000);
}

function shouldSendPaymentReminder(member) {
  const daysUntilDue = daysUntilDate(member.dueDate);
  return member.payment === "due"
    && validEmail(member.email)
    && Number.isFinite(daysUntilDue)
    && daysUntilDue <= 3
    && daysSinceDate(member.lastPaymentReminder) >= 7;
}

async function sendAndTrackPaymentReminder(member, db) {
  await sendBrevoEmail({
    to: member.email,
    subject: "Recordatorio de vencimiento de cuota",
    htmlContent: paymentReminderHtml(member, db)
  });
  member.lastPaymentReminder = paymentReminderStamp();
  return updateMemberInSupabase(member);
}

function registrationAdminHtml(member) {
  const number = Number(member.memberNumber) || Number(member.id);
  return mailLayout(`Nuevo socio #${number}`, `<p>Se registro una nueva ficha desde el formulario publico.</p>
    <div style="margin:20px 0;padding:18px;border-radius:12px;background:#fbf7ff;border:1px solid #eadff0">
      <strong style="display:block;font-size:34px;line-height:1;color:#6b2ca0">#${number}</strong>
      <span style="display:block;margin-top:6px;color:#6f6675">Numero interno de socio</span>
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:15px">
      <tr><td style="padding:10px;border-bottom:1px solid #eee;color:#6f6675">Nombre</td><td style="padding:10px;border-bottom:1px solid #eee"><strong>${safeText(member.name)}</strong></td></tr>
      <tr><td style="padding:10px;border-bottom:1px solid #eee;color:#6f6675">DNI</td><td style="padding:10px;border-bottom:1px solid #eee">${safeText(member.dni || "-")}</td></tr>
      <tr><td style="padding:10px;border-bottom:1px solid #eee;color:#6f6675">Mail</td><td style="padding:10px;border-bottom:1px solid #eee">${safeText(member.email || "-")}</td></tr>
      <tr><td style="padding:10px;border-bottom:1px solid #eee;color:#6f6675">Usuario</td><td style="padding:10px;border-bottom:1px solid #eee">${safeText(member.user)}</td></tr>
      <tr><td style="padding:10px;border-bottom:1px solid #eee;color:#6f6675">Fecha</td><td style="padding:10px;border-bottom:1px solid #eee">${safeText(member.registeredAt || "-")}</td></tr>
    </table>
    <div style="margin-top:18px;padding:14px;border-radius:10px;background:#f8f8f8">
      <strong style="display:block;margin-bottom:6px">Observacion corporal</strong>
      <span>${safeText(member.bodyNote || "Sin datos cargados.", 800)}</span>
    </div>`);
}

async function sendRegistrationEmails(member, db) {
  const tasks = [];
  if (member.email) {
    tasks.push(sendBrevoEmail({
      to: member.email,
      subject: "Recibimos tu inscripcion en OFIT Gym",
      htmlContent: mailLayout("Inscripcion recibida", `<p>Hola <strong>${safeText(member.name)}</strong>, recibimos tu ficha de inscripcion.</p><p>Tu numero de socio es <strong>#${Number(member.memberNumber) || Number(member.id)}</strong>.</p><p>Tu usuario es <strong>${safeText(member.user)}</strong>. Ya podes entrar al sistema para ver novedades, clases y pagos.</p>`)
    }));
  }
  if (adminEmail) {
    const number = Number(member.memberNumber) || Number(member.id);
    tasks.push(sendBrevoEmail({
      to: adminEmail,
      subject: `Nuevo socio #${number}: ${text(member.name, 90)}`,
      htmlContent: registrationAdminHtml(member)
    }));
  }
  if (!tasks.length || !brevoReady()) return;
  const results = await Promise.allSettled(tasks);
  const failed = results.find(result => result.status === "rejected");
  if (failed) console.error("No se pudo enviar algun mail de registro:", failed.reason.message);
}

function verificationEmailHtml(name, code) {
  return mailLayout("Codigo de verificacion", `<p>Hola <strong>${safeText(name)}</strong>, recibimos tu ficha de inscripcion en OFIT Gym.</p>
    <p>Para confirmar que este correo es tuyo, ingresa este codigo en la pagina:</p>
    <div style="margin:22px 0;padding:18px;border-radius:12px;background:#fbf7ff;border:1px solid #eadff0;text-align:center">
      <strong style="display:block;font-size:34px;letter-spacing:8px;color:#6b2ca0">${safeText(code, 8)}</strong>
      <span style="display:block;margin-top:8px;color:#6f6675">El codigo vence en 10 minutos.</span>
    </div>
    <p>Si vos no completaste esta ficha, podes ignorar este mensaje.</p>`);
}

async function sendVerificationEmail(email, name, code) {
  await sendBrevoEmail({
    to: email,
    subject: "Codigo de verificacion OFIT Gym",
    htmlContent: verificationEmailHtml(name, code)
  });
}

function validPassword(password) {
  return typeof password === "string" && password.length >= 6 && password.length <= 80;
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "")) && String(email).length <= 120;
}

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function validDni(value) {
  return /^[0-9.\-]{6,20}$/.test(String(value || ""));
}

function validTime(value) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || ""));
}

function validDay(value) {
  return ["Lunes", "Martes", "Miercoles", "Jueves", "Viernes", "Sabado", "Domingo"].includes(String(value || ""));
}

function cleanClass(item) {
  return {
    id: Number(item.id),
    activityId: safeText(item.activityId, 60),
    title: safeText(item.title, 80),
    coach: safeText(item.coach, 60),
    day: safeText(item.day, 20),
    time: safeText(item.time, 10),
    capacity: Math.max(1, Math.min(10000, Number(item.capacity) || 10000)),
    booked: Array.isArray(item.booked) ? item.booked.map(Number).filter(Boolean) : [],
    place: "",
    focus: safeText(item.focus, 160)
  };
}

function cleanActivity(activity) {
  return { id: safeText(activity.id, 60), name: safeText(activity.name, 80) };
}

function cleanNews(item) {
  const image = String(item.image || "").trim();
  return {
    id: Number(item.id),
    title: safeText(item.title, 90),
    category: safeText(item.category || "Horarios", 30),
    day: safeText(item.day || "Todos", 20),
    image: image.startsWith("assets/") || /^data:image\/(png|jpe?g|gif|webp);base64,/i.test(image) ? safeText(image, 1600000) : safeUrl(image, ""),
    text: safeText(item.text, 240)
  };
}

function cleanPaymentProof(item, includeImage = false) {
  const clean = {
    id: Number(item.id),
    memberId: Number(item.memberId),
    memberName: safeText(item.memberName, 90),
    note: safeText(item.note, 240),
    status: safeText(item.status || "Pendiente", 30),
    createdAt: safeText(item.createdAt, 20)
  };
  if (includeImage) {
    const image = String(item.image || "").trim();
    clean.image = /^data:image\/(png|jpe?g|webp);base64,/i.test(image) ? safeText(image, 1500000) : `/api/payment-proofs/${clean.id}/image`;
  }
  return clean;
}

function cleanAccountingEntry(item) {
  const type = item && item.type === "expense" ? "expense" : "income";
  const date = dateOnly(item && item.date) || new Date().toISOString().slice(0, 10);
  const month = /^\d{4}-\d{2}$/.test(String(item && item.month || "")) ? String(item.month).slice(0, 7) : date.slice(0, 7);
  return {
    id: Number(item && item.id) || Date.now(),
    type,
    concept: safeText(item && item.concept, 90) || (type === "income" ? "Entrada" : "Salida"),
    category: safeText(item && item.category, 60) || (type === "income" ? "General" : "Gasto"),
    date,
    month,
    amount: Math.max(0, Math.round(Number(item && item.amount) || 0)),
    note: safeText(item && item.note, 180)
  };
}

function dateOnly(value) {
  const textValue = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}/.test(textValue) ? textValue.slice(0, 10) : "";
}

function fullNameFromCliente(cliente) {
  const full = String(cliente.nombre_completo || "").trim();
  if (full) return full;
  return [cliente.nombre, cliente.apellido].map(value => String(value || "").trim()).filter(Boolean).join(" ");
}

function splitMemberName(name) {
  const clean = String(name || "").trim().replace(/\s+/g, " ");
  if (!clean) return { nombre: "", apellido: "" };
  const parts = clean.split(" ");
  if (parts.length === 1) return { nombre: clean, apellido: "" };
  return { nombre: parts[0], apellido: parts.slice(1).join(" ") };
}

function normalizePlan(value) {
  const tipo = String(value || "").toLowerCase();
  if (tipo.includes("8") || tipo.includes("eight") || tipo.includes("ocho") || tipo.includes("non")) return "eight-classes";
  return "free-pass";
}

function planLabel(value) {
  return normalizePlan(value) === "eight-classes" ? "8 clases" : "Pase libre";
}

function addOneMonth(date = new Date()) {
  const next = new Date(date.getTime());
  next.setMonth(next.getMonth() + 1);
  return next.toISOString().slice(0, 10);
}

function clienteToMember(cliente) {
  const actividades = Array.isArray(cliente.actividades) ? cliente.actividades : [];
  const tipo = String(cliente.tipo_alumno || "").toLowerCase();
  const pago = String(cliente.estado_pago || "").toLowerCase();
  return {
    id: Number(cliente.id),
    memberNumber: Number(cliente.numero_alumno) || Number(cliente.id),
    name: fullNameFromCliente(cliente),
    user: String(cliente.usuario || "").trim(),
    passwordHash: String(cliente.password_hash || "").trim(),
    dni: String(cliente.dni || "").trim(),
    birthdate: dateOnly(cliente.fecha_nacimiento),
    email: String(cliente.email || "").trim().toLowerCase(),
    bodyNote: String(cliente.patologia || cliente.observaciones || "").trim(),
    activityIds: actividades.map(id => String(id).trim()).filter(Boolean),
    memberType: normalizePlan(tipo),
    attendance: Number(cliente.asistencia) || 0,
    payment: pago.includes("dia") || pago.includes("paid") ? "paid" : "due",
    consistency: Number(cliente.constancia) || 0,
    source: String(cliente.origen || "").trim(),
    registeredAt: dateOnly(cliente.created_at),
    dueDate: dateOnly(cliente.fecha_vencimiento),
    last: String(cliente.ultimo_movimiento || "").trim(),
    lastPayment: dateOnly(cliente.ultimo_pago),
    lastPaymentReminder: dateOnly(cliente.ultimo_recordatorio_pago)
  };
}

function memberToCliente(member) {
  const names = splitMemberName(member.name);
  const createdAt = dateOnly(member.registeredAt);
  const row = {
    id: Number(member.id),
    nombre: names.nombre,
    apellido: names.apellido,
    nombre_completo: String(member.name || "").trim(),
    telefono: null,
    fecha_vencimiento: dateOnly(member.dueDate) || null,
    activo: true,
    observaciones: String(member.bodyNote || "").trim() || null,
    email: String(member.email || "").trim().toLowerCase() || null,
    dni: String(member.dni || "").trim() || null,
    tipo_alumno: planLabel(member.memberType),
    estado_pago: member.payment === "paid" ? "Al dia" : "Pendiente",
    numero_alumno: Number(member.memberNumber) || null,
    patologia: String(member.bodyNote || "").trim() || null,
    fecha_nacimiento: dateOnly(member.birthdate) || null,
    usuario: String(member.user || "").trim() || null,
    password_hash: String(member.passwordHash || "").trim() || null,
    actividades: Array.isArray(member.activityIds) ? member.activityIds : [],
    asistencia: Number(member.attendance) || 0,
    constancia: Number(member.consistency) || 0,
    origen: String(member.source || "").trim() || null,
    ultimo_movimiento: String(member.last || "").trim() || null,
    ultimo_pago: dateOnly(member.lastPayment) || null,
    ultimo_recordatorio_pago: dateOnly(member.lastPaymentReminder) || null
  };
  if (createdAt) row.created_at = `${createdAt}T00:00:00.000Z`;
  return row;
}

async function loadMembersFromSupabase() {
  const rows = await supabaseRequest("clientes?select=*&order=numero_alumno.asc", { serviceRole: true });
  return Array.isArray(rows) ? rows.map(clienteToMember) : [];
}

async function createMemberInSupabase(member) {
  const rows = await supabaseRequest("clientes", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: memberToCliente(member),
    serviceRole: true
  });
  return clienteToMember(Array.isArray(rows) ? rows[0] : rows);
}

async function updateMemberInSupabase(member) {
  const rows = await supabaseRequest(`clientes?id=eq.${encodeURIComponent(member.id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: memberToCliente(member),
    serviceRole: true
  });
  return clienteToMember(Array.isArray(rows) ? rows[0] : rows);
}

async function deleteMemberFromSupabase(memberId) {
  await supabaseRequest(`clientes?id=eq.${encodeURIComponent(memberId)}`, {
    method: "DELETE",
    headers: { Prefer: "return=minimal" },
    serviceRole: true
  });
}

function claseToClass(row) {
  return {
    id: Number(row.id),
    activityId: String(row.actividad_id || "").trim(),
    title: String(row.titulo || "").trim(),
    coach: String(row.profesor || "OFIT").trim(),
    day: String(row.dia || "").trim(),
    time: String(row.horario || "").trim(),
    capacity: 10000,
    booked: Array.isArray(row.reservados) ? row.reservados.map(Number).filter(Boolean) : [],
    place: "",
    focus: String(row.descripcion || "").trim()
  };
}

function classToClase(item) {
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

async function loadClassesFromSupabase() {
  const rows = await supabaseRequest("clases?select=*&activo=eq.true&order=dia.asc,horario.asc", { serviceRole: true });
  return Array.isArray(rows) ? rows.map(claseToClass) : [];
}

async function createClassInSupabase(item) {
  const rows = await supabaseRequest("clases", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: classToClase(item),
    serviceRole: true
  });
  return claseToClass(Array.isArray(rows) ? rows[0] : rows);
}

async function updateClassInSupabase(item) {
  const rows = await supabaseRequest(`clases?id=eq.${encodeURIComponent(item.id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: classToClase(item),
    serviceRole: true
  });
  return claseToClass(Array.isArray(rows) ? rows[0] : rows);
}

async function deleteClassFromSupabase(classId) {
  await supabaseRequest(`clases?id=eq.${encodeURIComponent(classId)}`, {
    method: "DELETE",
    headers: { Prefer: "return=minimal" },
    serviceRole: true
  });
}

async function deleteClassesByActivityFromSupabase(activityId) {
  await supabaseRequest(`clases?actividad_id=eq.${encodeURIComponent(activityId)}`, {
    method: "DELETE",
    headers: { Prefer: "return=minimal" },
    serviceRole: true
  });
}

async function dbWithSupabaseMembers() {
  const db = readDb();
  try {
    db.members = await loadMembersFromSupabase();
  } catch (error) {
    db.members = Array.isArray(db.members) ? db.members : [];
  }
  try {
    db.classes = await loadClassesFromSupabase();
  } catch (error) {
    db.classes = Array.isArray(db.classes) ? db.classes : [];
  }
  db.news = await loadNews(db);
  db.paymentProofs = await loadPaymentProofs(db);
  return db;
}

function comprobanteToPaymentProof(row) {
  return {
    id: Number(row.id),
    memberId: Number(row.cliente_id),
    memberName: String(row.socio_nombre || "").trim(),
    image: String(row.imagen || "").trim(),
    note: String(row.nota || "").trim(),
    status: String(row.estado || "Pendiente").trim(),
    createdAt: dateOnly(row.created_at)
  };
}

function paymentProofToComprobante(item) {
  return {
    id: Number(item.id),
    cliente_id: Number(item.memberId),
    socio_nombre: String(item.memberName || "").trim(),
    imagen: String(item.image || "").trim(),
    nota: String(item.note || "").trim() || null,
    estado: String(item.status || "Pendiente").trim(),
    activo: true
  };
}

async function loadPaymentProofs(db) {
  try {
    const rows = await supabaseRequest("comprobantes_pago?select=*&activo=eq.true&order=created_at.desc", { serviceRole: true });
    return Array.isArray(rows) ? rows.map(comprobanteToPaymentProof) : [];
  } catch (error) {
    return Array.isArray(db.paymentProofs) ? db.paymentProofs : [];
  }
}

async function createPaymentProofInSupabase(item) {
  const rows = await supabaseRequest("comprobantes_pago", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: paymentProofToComprobante(item),
    serviceRole: true
  });
  return comprobanteToPaymentProof(Array.isArray(rows) ? rows[0] : rows);
}

async function updatePaymentProofInSupabase(item) {
  const rows = await supabaseRequest(`comprobantes_pago?id=eq.${encodeURIComponent(item.id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: paymentProofToComprobante(item),
    serviceRole: true
  });
  return comprobanteToPaymentProof(Array.isArray(rows) ? rows[0] : rows);
}

function dataImageToFile(image) {
  const match = String(image || "").trim().match(/^data:image\/(png|jpe?g|webp);base64,([a-z0-9+/=]+)$/i);
  if (!match) return null;
  const subtype = match[1].toLowerCase() === "jpeg" ? "jpg" : match[1].toLowerCase();
  return {
    extension: subtype,
    contentType: subtype === "jpg" ? "image/jpeg" : `image/${subtype}`,
    buffer: Buffer.from(match[2], "base64")
  };
}

async function uploadPaymentProofToStorage(item, image) {
  const file = dataImageToFile(image);
  if (!file) throw new Error("Comprobante invalido.");
  if (file.buffer.length > 5_000_000) throw new Error("La imagen es muy pesada. Proba con una captura menor a 5 MB.");
  const storagePath = `socios/${Number(item.memberId)}/${Number(item.id)}.${file.extension}`;
  await supabaseStorageRequest(`object/${paymentProofBucket}/${storagePath}`, {
    method: "POST",
    headers: {
      "Content-Type": file.contentType,
      "Cache-Control": "3600",
      "x-upsert": "true"
    },
    body: file.buffer,
    responseType: "json",
    serviceRole: true
  });
  return storagePath;
}

async function downloadPaymentProofFromStorage(pathValue) {
  return supabaseStorageRequest(`object/${paymentProofBucket}/${encodeURI(String(pathValue || "").replace(/^\/+/, ""))}`, {
    method: "GET",
    responseType: "buffer",
    serviceRole: true
  });
}

function contentTypeFromProofPath(pathValue) {
  const value = String(pathValue || "").toLowerCase();
  if (value.endsWith(".png")) return "image/png";
  if (value.endsWith(".webp")) return "image/webp";
  return "image/jpeg";
}

function noticiaToNews(row) {
  return {
    id: Number(row.id),
    title: String(row.titulo || "").trim(),
    category: String(row.categoria || "Horarios").trim(),
    day: String(row.dia || "Todos").trim(),
    image: String(row.imagen || "").trim(),
    text: String(row.descripcion || "").trim()
  };
}

function newsToNoticia(item) {
  return {
    titulo: String(item.title || "").trim(),
    categoria: String(item.category || "Horarios").trim(),
    dia: String(item.day || "Todos").trim(),
    imagen: String(item.image || "").trim() || null,
    descripcion: String(item.text || "").trim() || null,
    activo: true
  };
}

async function loadNews(db) {
  try {
    const rows = await supabaseRequest("novedades?select=*&activo=eq.true&order=created_at.desc", { serviceRole: true });
    return Array.isArray(rows) && rows.length ? rows.map(noticiaToNews) : (Array.isArray(db.news) && db.news.length ? db.news : defaultNews());
  } catch (error) {
    return Array.isArray(db.news) && db.news.length ? db.news : defaultNews();
  }
}

async function createNewsInSupabase(item) {
  const rows = await supabaseRequest("novedades", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: newsToNoticia(item),
    serviceRole: true
  });
  return noticiaToNews(Array.isArray(rows) ? rows[0] : rows);
}

async function deleteNewsInSupabase(id) {
  await supabaseRequest(`novedades?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: { activo: false, updated_at: new Date().toISOString() },
    serviceRole: true
  });
}

function cleanMember(member, includePrivate = false) {
  if (!member) return null;
  const clean = {
    id: Number(member.id),
    memberNumber: Number(member.memberNumber) || Number(member.id),
    name: safeText(member.name, 90),
    user: safeText(member.user, 40),
    dni: safeText(member.dni, 20),
    birthdate: safeText(member.birthdate, 20),
    email: safeText(member.email, 120),
    bodyNote: safeText(member.bodyNote, 800),
    activityIds: Array.isArray(member.activityIds) ? member.activityIds.map(id => safeText(id, 60)) : [],
    memberType: normalizePlan(member.memberType),
    attendance: Number(member.attendance) || 0,
    payment: member.payment === "paid" ? "paid" : "due",
    consistency: Number(member.consistency) || 0,
    source: safeText(member.source, 40),
    registeredAt: safeText(member.registeredAt, 20),
    dueDate: safeText(member.dueDate, 20),
    last: safeText(member.last, 40),
    lastPayment: safeText(member.lastPayment, 20),
    lastPaymentReminder: safeText(member.lastPaymentReminder, 80),
    password: "",
    hasPassword: Boolean(member.passwordHash)
  };
  if (!includePrivate) {
    delete clean.bodyNote;
    delete clean.dni;
    delete clean.birthdate;
    delete clean.email;
  }
  return clean;
}

function publicDb(db) {
  return {
    activities: (Array.isArray(db.activities) ? db.activities : []).map(cleanActivity),
    classes: (Array.isArray(db.classes) ? db.classes : []).map(cleanClass),
    news: (db.news || []).map(cleanNews),
    paymentLink: safeUrl(db.paymentLink, "https://www.mercadopago.com.ar/"),
    paymentInfo: { alias: paymentAlias, cvu: paymentCvu, holder: paymentHolder }
  };
}

function sessionPayload(session, db) {
  if (session.role === "member") {
    const member = db.members.find(m => m.id === session.memberId);
    if (!member) return { user: null, ...publicDb(db), csrfToken: session.csrfToken };
    return { user: { role: "member", memberId: session.memberId }, member: cleanMember(member, true), paymentProofs: (db.paymentProofs || []).filter(p => Number(p.memberId) === Number(session.memberId)).map(p => cleanPaymentProof(p, false)), ...publicDb(db), csrfToken: session.csrfToken };
  }
  return { user: { role: session.role, label: session.label }, members: db.members.map(m => cleanMember(m, true)), paymentProofs: (db.paymentProofs || []).map(p => cleanPaymentProof(p, true)), ...publicDb(db), csrfToken: session.csrfToken };
}

function securityHeaders(extra = {}) {
  return {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "X-Frame-Options": "DENY",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'self'; frame-ancestors 'none'",
    ...extra
  };
}

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (origin === "null" && process.env.NODE_ENV !== "production") return true;
  const hostOrigin = `${req.headers["x-forwarded-proto"] || "http"}://${req.headers.host}`;
  return origin === hostOrigin || allowedOrigins.includes(origin);
}

function corsHeaders(req) {
  const origin = req.headers.origin;
  if (!origin || !originAllowed(req)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Headers": `Content-Type, ${csrfHeader}`,
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "Vary": "Origin"
  };
}

function send(res, status, payload, headers = {}) {
  res.writeHead(status, securityHeaders({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers }));
  res.end(JSON.stringify(payload));
}

function parseCookies(req) {
  return String(req.headers.cookie || "").split(";").reduce((cookies, part) => {
    const index = part.indexOf("=");
    if (index > -1) cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
    return cookies;
  }, {});
}

function cookieHeader(req, value, maxAge) {
  const secure = req.headers["x-forwarded-proto"] === "https";
  return `${sessionCookie}=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

// Tope duro de vida de una sesion sin importar la actividad: una cookie robada
// no puede mantenerse viva indefinidamente renovando el vencimiento deslizante.
const sessionAbsoluteMaxMs = 7 * 24 * 60 * 60 * 1000;

function createSession(req, identity) {
  const id = randomToken();
  const now = Date.now();
  const session = { ...identity, id, csrfToken: randomToken(18), createdAt: now, expiresAt: now + sessionTtlMs };
  sessions.set(id, session);
  return session;
}

function getSession(req) {
  const id = parseCookies(req)[sessionCookie];
  const session = id && sessions.get(id);
  if (!session) return null;
  const now = Date.now();
  if (session.expiresAt < now || (session.createdAt || 0) + sessionAbsoluteMaxMs < now) {
    sessions.delete(id);
    return null;
  }
  session.expiresAt = now + sessionTtlMs;
  return session;
}

function requireSession(req, res) {
  const session = getSession(req);
  if (!session) {
    send(res, 401, { error: "Necesitas iniciar sesion." });
    return null;
  }
  return session;
}

function requireRole(req, res, roles) {
  const session = requireSession(req, res);
  if (!session) return null;
  if (!roles.includes(session.role)) {
    send(res, 403, { error: "No tenes permisos para esta accion." });
    return null;
  }
  return session;
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a == null ? "" : a));
  const bufB = Buffer.from(String(b == null ? "" : b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function requireCsrf(req, res, session) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return true;
  if (!safeEqual(req.headers[csrfHeader], session.csrfToken)) {
    send(res, 403, { error: "Sesion no verificada. Volve a iniciar sesion." });
    return false;
  }
  return true;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    let settled = false;
    const fail = message => {
      if (settled) return;
      settled = true;
      reject(new Error(message));
    };
    req.on("data", chunk => {
      if (settled) return;
      body += chunk;
      if (body.length > 8_000_000) {
        fail("Cuerpo de la peticion demasiado grande.");
        req.destroy();
      }
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("JSON invalido."));
      }
    });
    req.on("error", () => fail("Error al leer la peticion."));
    req.on("aborted", () => fail("Peticion cancelada."));
  });
}

function clientKey(req) {
  if (trustProxy) {
    const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    if (forwarded) return forwarded;
  }
  return req.socket.remoteAddress || "local";
}

function loginAllowed(req) {
  const item = loginAttempts.get(clientKey(req));
  return !item || item.until <= Date.now();
}

function recordLoginFailure(req) {
  const key = clientKey(req);
  const item = loginAttempts.get(key) || { count: 0, until: 0 };
  item.count += 1;
  if (item.count >= 8) item.until = Date.now() + 1000 * 60 * 5;
  loginAttempts.set(key, item);
}

function clearLoginFailures(req) {
  loginAttempts.delete(clientKey(req));
}

// El registro es publico: sin limite, un atacante puede llenar la base y disparar
// mails ilimitados desde la cuenta de Brevo (costo y reputacion). Max 5 por hora por IP.
function registerAllowed(req) {
  const key = clientKey(req);
  const now = Date.now();
  const windowMs = 60 * 60 * 1000;
  const item = registerAttempts.get(key) || { count: 0, resetAt: now + windowMs };
  if (item.resetAt <= now) { item.count = 0; item.resetAt = now + windowMs; }
  if (item.count >= 5) return false;
  item.count += 1;
  registerAttempts.set(key, item);
  return true;
}

// Evita que sesiones e intentos vencidos crezcan en memoria sin fin.
function sweepExpired() {
  const now = Date.now();
  for (const [id, session] of sessions) if (session.expiresAt < now || (session.createdAt || 0) + sessionAbsoluteMaxMs < now) sessions.delete(id);
  for (const [key, item] of loginAttempts) if ((item.until || 0) < now) loginAttempts.delete(key);
  for (const [key, item] of registerAttempts) if (item.resetAt < now) registerAttempts.delete(key);
  sweepPendingRegistrations();
}

// Hash senuelo: se usa cuando el usuario no existe para que el login tarde lo mismo
// exista o no el usuario, y no se pueda enumerar cuentas midiendo el tiempo de respuesta.
const dummyPasswordHash = hashPassword(randomToken());

// Genera un id numerico unico entre staff, alumnos y clases. Date.now() solo no alcanza:
// dos registros creados en el mismo milisegundo compartirian id y se confundiria la identidad.
function uniqueId(db) {
  const used = new Set();
  for (const group of [db.staff, db.members, db.classes, db.accounting]) {
    if (Array.isArray(group)) for (const item of group) used.add(Number(item.id));
  }
  let id = Date.now();
  while (used.has(id)) id += 1;
  return id;
}

// Cierra las sesiones activas de un alumno (al resetear su clave o al borrarlo).
function destroyMemberSessions(memberId) {
  for (const [id, session] of sessions) {
    if (session.role === "member" && session.memberId === memberId) sessions.delete(id);
  }
}

function userExists(db, user) {
  return db.staff.some(s => s.user === user) || db.members.some(m => m.user === user);
}

function emailExists(db, email, exceptMemberId = null) {
  const normalized = String(email || "").trim().toLowerCase();
  if (!normalized) return false;
  return db.members.some(member => Number(member.id) !== Number(exceptMemberId) && String(member.email || "").trim().toLowerCase() === normalized);
}

function pendingRegistrationKey(email) {
  return String(email || "").trim().toLowerCase();
}

function sweepPendingRegistrations() {
  const now = Date.now();
  for (const [key, item] of pendingRegistrations) if (!item || item.expiresAt < now) pendingRegistrations.delete(key);
}

function validateActivityIds(db, ids) {
  const allowed = new Set(db.activities.map(a => a.id));
  if (!Array.isArray(ids)) return [];
  return [...new Set(ids.filter(id => allowed.has(id)))].slice(0, 40);
}

function activitySlug(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function resolveActivityId(db, value) {
  const name = text(value, 80);
  if (!name) return "";
  const existing = db.activities.find(activity =>
    activity.id === name ||
    String(activity.name || "").trim().toLowerCase() === name.toLowerCase()
  );
  if (existing) return existing.id;
  const base = activitySlug(name) || `actividad-${Date.now()}`;
  let id = base;
  let counter = 2;
  while (db.activities.some(activity => activity.id === id)) {
    id = `${base}-${counter}`;
    counter += 1;
  }
  db.activities.push({ id, name });
  writeDb(db);
  return id;
}

async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/api/supabase/status") {
    if (!supabaseConfigured()) {
      return send(res, 200, {
        configured: false,
        ok: false,
        message: "Supabase todavia no esta configurado en .env."
      });
    }

    try {
      await testSupabaseConnection();
      try {
        await supabaseRequest("clientes?select=id&limit=1", { serviceRole: true });
        return send(res, 200, { configured: true, ok: true, serviceRole: true });
      } catch (serviceError) {
        return send(res, 200, {
          configured: true,
          ok: false,
          publicKey: true,
          serviceRole: false,
          statusCode: serviceError.statusCode || null,
          error: serviceError.message || "No se pudo conectar con Supabase usando service role.",
          details: serviceError.data || null
        });
      }
    } catch (error) {
      return send(res, 200, {
        configured: true,
        ok: false,
        statusCode: error.statusCode || null,
        error: error.message || "No se pudo conectar con Supabase.",
        details: error.data || null
      });
    }
  }

  let db;
  try {
    db = await dbWithSupabaseMembers();
  } catch (error) {
    return send(res, 500, { error: "No se pudo conectar con la base de socios en Supabase." });
  }

  if (req.method === "GET" && url.pathname === "/api/public") {
    return send(res, 200, publicDb(db));
  }

  if (req.method === "GET" && url.pathname === "/api/session") {
    const session = getSession(req);
    return send(res, 200, session ? sessionPayload(session, db) : { user: null, ...publicDb(db) });
  }

  if (req.method === "POST" && url.pathname === "/api/logout") {
    const id = parseCookies(req)[sessionCookie];
    if (id) sessions.delete(id);
    return send(res, 200, { ok: true }, { "Set-Cookie": cookieHeader(req, "", 0) });
  }

  if (req.method === "POST" && url.pathname === "/api/register/start") {
    if (!registerAllowed(req)) return send(res, 429, { error: "Demasiadas solicitudes desde tu conexion. Proba de nuevo mas tarde." });
    const body = await readBody(req);
    const user = normalizeUser(body.user || body.name);
    const name = text(body.name, 90);
    if (!name || !user || !validPassword(body.password)) return send(res, 400, { error: "Completa nombre, usuario y una contrasena de al menos 6 caracteres." });
    if (!validDni(body.dni)) return send(res, 400, { error: "DNI invalido." });
    if (!validDate(body.birthdate)) return send(res, 400, { error: "Fecha de nacimiento invalida." });
    if (!validEmail(body.email)) return send(res, 400, { error: "Mail invalido." });
    const passwordHash = await hashPasswordAsync(body.password);
    db = await dbWithSupabaseMembers();
    if (userExists(db, user)) return send(res, 409, { error: "Ese usuario ya existe." });
    if (emailExists(db, body.email)) return send(res, 409, { error: "Ese mail ya esta registrado." });
    if (!brevoReady()) return send(res, 500, { error: "La verificacion por mail no esta configurada." });
    const email = text(body.email, 120).toLowerCase();
    const code = String(crypto.randomInt(100000, 1000000));
    pendingRegistrations.set(pendingRegistrationKey(email), {
      attempts: 0,
      codeHash: crypto.createHash("sha256").update(code).digest("hex"),
      expiresAt: Date.now() + 10 * 60 * 1000,
      data: {
        name,
        user,
        passwordHash,
        dni: text(body.dni, 20),
        birthdate: text(body.birthdate, 20),
        email,
        bodyNote: text(body.bodyNote, 800)
      }
    });
    await sendVerificationEmail(email, name, code);
    return send(res, 200, { ok: true, email, message: "Te enviamos un codigo de verificacion al mail." });
  }

  if (req.method === "POST" && url.pathname === "/api/register/verify") {
    const body = await readBody(req);
    const email = pendingRegistrationKey(body.email);
    const code = String(body.code || "").trim();
    if (!validEmail(email) || !/^\d{6}$/.test(code)) return send(res, 400, { error: "Codigo invalido." });
    const pending = pendingRegistrations.get(email);
    if (!pending || pending.expiresAt < Date.now()) {
      pendingRegistrations.delete(email);
      return send(res, 400, { error: "El codigo vencio. Pedi uno nuevo." });
    }
    const codeHash = crypto.createHash("sha256").update(code).digest("hex");
    if (!safeEqual(codeHash, pending.codeHash)) {
      pending.attempts = Number(pending.attempts || 0) + 1;
      if (pending.attempts >= 5) pendingRegistrations.delete(email);
      return send(res, 400, { error: "Codigo incorrecto." });
    }
    db = await dbWithSupabaseMembers();
    if (userExists(db, pending.data.user)) {
      pendingRegistrations.delete(email);
      return send(res, 409, { error: "Ese usuario ya existe." });
    }
    if (emailExists(db, pending.data.email)) {
      pendingRegistrations.delete(email);
      return send(res, 409, { error: "Ese mail ya esta registrado." });
    }
    const member = {
      id: uniqueId(db),
      memberNumber: nextMemberNumber(db),
      name: pending.data.name,
      user: pending.data.user,
      passwordHash: pending.data.passwordHash,
      dni: pending.data.dni,
      birthdate: pending.data.birthdate,
      email: pending.data.email,
      bodyNote: pending.data.bodyNote,
      activityIds: [],
      memberType: "free-pass",
      attendance: 0,
      payment: "due",
      dueDate: "",
      consistency: 0,
      source: "ficha",
    registeredAt: new Date().toISOString().slice(0, 10),
    last: "Recien",
    lastPayment: "",
    lastPaymentReminder: ""
    };
    const savedMember = await createMemberInSupabase(member);
    db.members = await loadMembersFromSupabase();
    pendingRegistrations.delete(email);
    await sendRegistrationEmails(savedMember, db);
    const session = createSession(req, { role: "member", memberId: savedMember.id });
    return send(res, 201, sessionPayload(session, db), { "Set-Cookie": cookieHeader(req, session.id, Math.floor(sessionTtlMs / 1000)) });
  }

  if (req.method === "POST" && url.pathname === "/api/login") {
    if (!loginAllowed(req)) return send(res, 429, { error: "Demasiados intentos. Proba de nuevo en unos minutos." });
    const body = await readBody(req);
    db = await dbWithSupabaseMembers();
    const user = normalizeUser(body.user);
    if (!user || !validPassword(body.password)) {
      recordLoginFailure(req);
      return send(res, 401, { error: "Usuario o contrasena incorrectos." });
    }
    const staff = db.staff.find(s => s.user === user);
    const member = staff ? null : db.members.find(m => m.user === user);
    const account = staff || member;
    // Siempre corremos un scrypt (real o senuelo) para que el tiempo de respuesta sea el mismo
    // exista o no la cuenta: asi no se puede enumerar usuarios midiendo cuanto tarda el login.
    const passwordOk = await verifyPasswordAsync(body.password, account ? account.passwordHash : dummyPasswordHash);
    if (!account || !passwordOk) {
      recordLoginFailure(req);
      return send(res, 401, { error: "Usuario o contrasena incorrectos." });
    }
    clearLoginFailures(req);
    const identity = staff ? { role: staff.role, label: staff.label } : { role: "member", memberId: member.id };
    const session = createSession(req, identity);
    return send(res, 200, sessionPayload(session, db), { "Set-Cookie": cookieHeader(req, session.id, Math.floor(sessionTtlMs / 1000)) });
  }

  if (req.method === "POST" && url.pathname === "/api/members") {
    const session = requireRole(req, res, ["admin", "coach"]);
    if (!session || !requireCsrf(req, res, session)) return;
    const body = await readBody(req);
    const user = normalizeUser(body.user || body.name);
    const name = text(body.name, 90);
    if (!name || !user || !validPassword(body.password || "socio123")) return send(res, 400, { error: "Datos de socio incompletos." });
    if (body.email && !validEmail(body.email)) return send(res, 400, { error: "Mail invalido." });
    if (body.birthdate && !validDate(body.birthdate)) return send(res, 400, { error: "Fecha de nacimiento invalida." });
    if (body.dni && !validDni(body.dni)) return send(res, 400, { error: "DNI invalido." });
    const passwordHash = await hashPasswordAsync(body.password || "socio123");
    db = await dbWithSupabaseMembers();
    if (userExists(db, user)) return send(res, 409, { error: "Ese usuario ya existe." });
    if (body.email && emailExists(db, body.email)) return send(res, 409, { error: "Ese mail ya esta registrado." });
    const member = {
      id: uniqueId(db),
      memberNumber: nextMemberNumber(db),
      name,
      user,
      passwordHash,
      dni: text(body.dni, 20),
      birthdate: text(body.birthdate, 20),
      email: text(body.email, 120),
      bodyNote: text(body.bodyNote, 800),
      activityIds: validateActivityIds(db, body.activityIds),
      memberType: normalizePlan(body.memberType),
      attendance: 0,
      payment: body.payment === "paid" ? "paid" : "due",
      dueDate: dateOnly(body.dueDate) || (body.payment === "paid" ? addOneMonth() : ""),
      consistency: 0,
      source: "manual",
      registeredAt: new Date().toISOString().slice(0, 10),
      last: "Recien",
      lastPayment: body.payment === "paid" ? paymentReminderStamp() : "",
      lastPaymentReminder: ""
    };
    const savedMember = await createMemberInSupabase(member);
    db.members = await loadMembersFromSupabase();
    return send(res, 201, { member: cleanMember(savedMember, true), members: db.members.map(m => cleanMember(m, true)) });
  }

  const memberMatch = url.pathname.match(/^\/api\/members\/(\d+)$/);
  if (req.method === "PATCH" && memberMatch) {
    const session = requireRole(req, res, ["admin", "coach"]);
    if (!session || !requireCsrf(req, res, session)) return;
    const body = await readBody(req);
    // Si hay cambio de clave, validar y calcular el hash (async) ANTES de leer la DB,
    // para que la seccion critica de lectura->escritura no tenga ningun await.
    let newPasswordHash = null;
    if (body.password) {
      if (session.role !== "admin") return send(res, 403, { error: "Solo admin puede resetear contrasenas." });
      if (!validPassword(body.password)) return send(res, 400, { error: "La nueva contrasena debe tener al menos 6 caracteres." });
      newPasswordHash = await hashPasswordAsync(body.password);
    }
    db = await dbWithSupabaseMembers();
    const member = db.members.find(m => m.id === Number(memberMatch[1]));
    if (!member) return send(res, 404, { error: "Socio no encontrado." });
    if (body.name !== undefined) {
      const name = text(body.name, 90);
      if (!name) return send(res, 400, { error: "Nombre requerido." });
      member.name = name;
    }
    if (body.user !== undefined) {
      const user = normalizeUser(body.user);
      if (!user) return send(res, 400, { error: "Usuario requerido." });
      const taken = db.staff.some(s => s.user === user) || db.members.some(m => m.id !== member.id && m.user === user);
      if (taken) return send(res, 409, { error: "Ese usuario ya existe." });
      member.user = user;
    }
    if (body.dni !== undefined) {
      if (body.dni && !validDni(body.dni)) return send(res, 400, { error: "DNI invalido." });
      member.dni = text(body.dni, 20);
    }
    if (body.birthdate !== undefined) {
      if (body.birthdate && !validDate(body.birthdate)) return send(res, 400, { error: "Fecha de nacimiento invalida." });
      member.birthdate = text(body.birthdate, 20);
    }
    if (body.email !== undefined) {
      if (body.email && !validEmail(body.email)) return send(res, 400, { error: "Mail invalido." });
      if (body.email && emailExists(db, body.email, member.id)) return send(res, 409, { error: "Ese mail ya esta registrado." });
      member.email = text(body.email, 120);
    }
    if (body.bodyNote !== undefined) member.bodyNote = text(body.bodyNote, 800);
    if (body.payment && session.role === "admin") {
      const wasDue = member.payment !== "paid";
      member.payment = body.payment === "paid" ? "paid" : "due";
      if (member.payment === "paid" && wasDue) {
        member.dueDate = addOneMonth();
        member.lastPayment = paymentReminderStamp();
      }
    }
    if (body.memberType && session.role === "admin") member.memberType = normalizePlan(body.memberType);
    if (body.dueDate !== undefined && session.role === "admin") {
      if (body.dueDate && !validDate(body.dueDate)) return send(res, 400, { error: "Fecha de vencimiento invalida." });
      member.dueDate = dateOnly(body.dueDate);
    }
    if (Array.isArray(body.activityIds)) member.activityIds = validateActivityIds(db, body.activityIds);
    if (newPasswordHash) {
      member.passwordHash = newPasswordHash;
      destroyMemberSessions(member.id); // al cambiar la clave, invalidar las sesiones abiertas del alumno
    }
    if (typeof body.consistency === "number") member.consistency = Math.max(0, Math.min(100, body.consistency));
    const savedMember = await updateMemberInSupabase(member);
    db.members = await loadMembersFromSupabase();
    return send(res, 200, { member: cleanMember(savedMember, true), members: db.members.map(m => cleanMember(m, true)) });
  }

  if (req.method === "DELETE" && memberMatch) {
    const session = requireRole(req, res, ["admin"]);
    if (!session || !requireCsrf(req, res, session)) return;
    const memberId = Number(memberMatch[1]);
    const memberIndex = db.members.findIndex(m => m.id === memberId);
    if (memberIndex === -1) return send(res, 404, { error: "Socio no encontrado." });
    await deleteMemberFromSupabase(memberId);
    db.members.splice(memberIndex, 1);
    for (const item of db.classes) {
      const nextBooked = Array.isArray(item.booked) ? item.booked.filter(id => Number(id) !== memberId) : [];
      if (nextBooked.length !== (item.booked || []).length) {
        item.booked = nextBooked;
        await updateClassInSupabase(item);
      }
    }
    db.classes = await loadClassesFromSupabase();
    destroyMemberSessions(memberId); // sin esto, la sesion del alumno borrado sigue viva y /api/session revienta
    return send(res, 200, { ok: true, members: db.members.map(m => cleanMember(m, true)), classes: db.classes.map(cleanClass) });
  }

  const paymentReminderMatch = url.pathname.match(/^\/api\/members\/(\d+)\/payment-reminder$/);
  if (req.method === "POST" && paymentReminderMatch) {
    const session = requireRole(req, res, ["admin", "coach"]);
    if (!session || !requireCsrf(req, res, session)) return;
    const member = db.members.find(m => m.id === Number(paymentReminderMatch[1]));
    if (!member) return send(res, 404, { error: "Socio no encontrado." });
    if (member.payment === "paid") return send(res, 400, { error: "El socio ya figura al dia." });
    try {
      await sendAndTrackPaymentReminder(member, db);
      db.members = await loadMembersFromSupabase();
      return send(res, 200, { ok: true, members: db.members.map(m => cleanMember(m, true)) });
    } catch (error) {
      return send(res, 500, { error: error.message });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/payment-reminders/run") {
    const session = requireRole(req, res, ["admin"]);
    if (!session || !requireCsrf(req, res, session)) return;
    const dueMembers = db.members.filter(shouldSendPaymentReminder);
    const results = [];
    for (const member of dueMembers) {
      try {
        await sendAndTrackPaymentReminder(member, db);
        results.push({ id: member.id, ok: true });
      } catch (error) {
        results.push({ id: member.id, ok: false, error: error.message });
      }
    }
    try {
      db.members = await loadMembersFromSupabase();
    } catch (error) {
      db.members = Array.isArray(db.members) ? db.members : [];
    }
    return send(res, 200, {
      ok: true,
      sent: results.filter(result => result.ok).length,
      failed: results.filter(result => !result.ok).length,
      results,
      members: db.members.map(m => cleanMember(m, true))
    });
  }

  if (req.method === "POST" && url.pathname === "/api/payment-proofs") {
    const session = requireSession(req, res);
    if (!session || !requireCsrf(req, res, session)) return;
    const body = await readBody(req);
    const memberId = session.role === "member" ? session.memberId : Number(body.memberId);
    const member = db.members.find(m => Number(m.id) === Number(memberId));
    if (!member) return send(res, 404, { error: "Socio no encontrado." });
    const image = String(body.image || "").trim();
    if (!/^data:image\/(png|jpe?g|webp);base64,/i.test(image)) return send(res, 400, { error: "Subi una imagen valida del comprobante." });
    if (image.length > 7_000_000) return send(res, 400, { error: "La imagen es muy pesada. Proba con una captura menor a 5 MB." });
    const item = {
      id: uniqueId(db),
      memberId: member.id,
      memberName: member.name,
      image: "",
      note: text(body.note, 240),
      status: "Pendiente",
      createdAt: new Date().toISOString().slice(0, 10)
    };
    try {
      item.image = await uploadPaymentProofToStorage(item, image);
      await createPaymentProofInSupabase(item);
      db.paymentProofs = await loadPaymentProofs(db);
    } catch (error) {
      item.image = image;
      db.paymentProofs = Array.isArray(db.paymentProofs) ? db.paymentProofs : [];
      db.paymentProofs.unshift(item);
      writeDb(db);
    }
    return send(res, 201, {
      ok: true,
      paymentProofs: session.role === "member"
        ? db.paymentProofs.filter(p => Number(p.memberId) === Number(member.id)).map(p => cleanPaymentProof(p, false))
        : db.paymentProofs.map(p => cleanPaymentProof(p, true))
    });
  }

  if (req.method === "GET" && url.pathname === "/api/accounting") {
    const session = requireRole(req, res, ["admin"]);
    if (!session) return;
    const entries = (Array.isArray(db.accounting) ? db.accounting : []).map(cleanAccountingEntry);
    return send(res, 200, { entries });
  }

  if (req.method === "POST" && url.pathname === "/api/accounting") {
    const session = requireRole(req, res, ["admin"]);
    if (!session || !requireCsrf(req, res, session)) return;
    const body = await readBody(req);
    db.accounting = Array.isArray(db.accounting) ? db.accounting : [];
    const entry = cleanAccountingEntry({ ...body, id: uniqueId(db) });
    db.accounting.unshift(entry);
    writeDb(db);
    return send(res, 201, { entries: db.accounting.map(cleanAccountingEntry) });
  }

  const accountingMatch = url.pathname.match(/^\/api\/accounting\/(\d+)$/);
  if (accountingMatch && req.method === "PATCH") {
    const session = requireRole(req, res, ["admin"]);
    if (!session || !requireCsrf(req, res, session)) return;
    const id = Number(accountingMatch[1]);
    const body = await readBody(req);
    db.accounting = Array.isArray(db.accounting) ? db.accounting : [];
    const index = db.accounting.findIndex(item => Number(item.id) === id);
    if (index === -1) return send(res, 404, { error: "Movimiento no encontrado." });
    db.accounting[index] = cleanAccountingEntry({ ...db.accounting[index], ...body, id });
    writeDb(db);
    return send(res, 200, { entries: db.accounting.map(cleanAccountingEntry) });
  }

  if (accountingMatch && req.method === "DELETE") {
    const session = requireRole(req, res, ["admin"]);
    if (!session || !requireCsrf(req, res, session)) return;
    const id = Number(accountingMatch[1]);
    db.accounting = (Array.isArray(db.accounting) ? db.accounting : []).filter(item => Number(item.id) !== id);
    writeDb(db);
    return send(res, 200, { entries: db.accounting.map(cleanAccountingEntry) });
  }

  const proofImageMatch = url.pathname.match(/^\/api\/payment-proofs\/(\d+)\/image$/);
  if (req.method === "GET" && proofImageMatch) {
    const session = requireRole(req, res, ["admin", "coach"]);
    if (!session) return;
    const proof = (db.paymentProofs || []).find(p => Number(p.id) === Number(proofImageMatch[1]));
    if (!proof) return send(res, 404, { error: "Comprobante no encontrado." });
    const image = String(proof.image || "").trim();
    if (/^data:image\/(png|jpe?g|webp);base64,/i.test(image)) {
      const file = dataImageToFile(image);
      if (!file) return send(res, 404, { error: "Imagen no encontrada." });
      res.writeHead(200, securityHeaders({ "Content-Type": file.contentType, "Cache-Control": "private, no-store" }));
      res.end(file.buffer);
      return;
    }
    try {
      const file = await downloadPaymentProofFromStorage(image);
      res.writeHead(200, securityHeaders({ "Content-Type": contentTypeFromProofPath(image), "Cache-Control": "private, no-store" }));
      res.end(file);
    } catch (error) {
      return send(res, 404, { error: "Imagen no encontrada en Storage." });
    }
    return;
  }

  const proofApproveMatch = url.pathname.match(/^\/api\/payment-proofs\/(\d+)\/approve$/);
  if (req.method === "POST" && proofApproveMatch) {
    const session = requireRole(req, res, ["admin"]);
    if (!session || !requireCsrf(req, res, session)) return;
    const proof = (db.paymentProofs || []).find(p => Number(p.id) === Number(proofApproveMatch[1]));
    if (!proof) return send(res, 404, { error: "Comprobante no encontrado." });
    const member = db.members.find(m => Number(m.id) === Number(proof.memberId));
    if (!member) return send(res, 404, { error: "Socio no encontrado." });
    proof.status = "Aprobado";
    member.payment = "paid";
    member.lastPayment = paymentReminderStamp();
    member.dueDate = addOneMonth();
    try {
      await updatePaymentProofInSupabase(proof);
    } catch (error) {
      db.paymentProofs = db.paymentProofs.map(item => Number(item.id) === Number(proof.id) ? proof : item);
      writeDb(db);
    }
    await updateMemberInSupabase(member);
    db.members = await loadMembersFromSupabase();
    db.paymentProofs = await loadPaymentProofs(db);
    return send(res, 200, {
      ok: true,
      members: db.members.map(m => cleanMember(m, true)),
      paymentProofs: db.paymentProofs.map(p => cleanPaymentProof(p, true))
    });
  }

  if (req.method === "POST" && url.pathname === "/api/news") {
    const session = requireRole(req, res, ["admin", "coach"]);
    if (!session || !requireCsrf(req, res, session)) return;
    const body = await readBody(req);
    const title = text(body.title, 90);
    if (!title) return send(res, 400, { error: "Titulo requerido." });
    const item = {
      id: uniqueId(db),
      title,
      category: text(body.category || "Eventos", 30),
      day: text(body.day || "Todos", 20),
      image: String(body.image || "").trim().slice(0, 1500000),
      text: text(body.text || "Nueva informacion para socios.", 240)
    };
    try {
      await createNewsInSupabase(item);
      db.news = await loadNews(db);
    } catch (error) {
      db.news = Array.isArray(db.news) ? db.news : [];
      db.news.unshift(item);
      writeDb(db);
    }
    return send(res, 201, { news: db.news.map(cleanNews) });
  }

  const newsDeleteMatch = url.pathname.match(/^\/api\/news\/(\d+)$/);
  if (req.method === "DELETE" && newsDeleteMatch) {
    const session = requireRole(req, res, ["admin", "coach"]);
    if (!session || !requireCsrf(req, res, session)) return;
    const newsId = Number(newsDeleteMatch[1]);
    try {
      await deleteNewsInSupabase(newsId);
      const localNews = Array.isArray(db.news) && db.news.length ? db.news : defaultNews();
      db.news = localNews.filter(item => Number(item.id) !== newsId);
      writeDb(db);
      db.news = (await loadNews(db)).filter(item => Number(item.id) !== newsId);
    } catch (error) {
      const sourceNews = Array.isArray(db.news) && db.news.length ? db.news : defaultNews();
      db.news = sourceNews.filter(item => Number(item.id) !== newsId);
      writeDb(db);
    }
    return send(res, 200, { ok: true, news: db.news.map(cleanNews) });
  }

  const activityDeleteMatch = url.pathname.match(/^\/api\/activities\/([A-Za-z0-9._-]+)$/);
  if (req.method === "DELETE" && activityDeleteMatch) {
    const session = requireRole(req, res, ["admin"]);
    if (!session || !requireCsrf(req, res, session)) return;
    db = await dbWithSupabaseMembers();
    const activityId = safeText(activityDeleteMatch[1], 60);
    const exists = db.activities.some(activity => activity.id === activityId);
    if (!exists) return send(res, 404, { error: "Actividad no encontrada." });
    db.activities = db.activities.filter(activity => activity.id !== activityId);
    const updatedMembers = [];
    for (const member of db.members) {
      const nextActivityIds = Array.isArray(member.activityIds) ? member.activityIds.filter(id => id !== activityId) : [];
      if (nextActivityIds.length !== (member.activityIds || []).length) {
        member.activityIds = nextActivityIds;
        updatedMembers.push(updateMemberInSupabase(member));
      }
    }
    if (updatedMembers.length) await Promise.all(updatedMembers);
    db.members = await loadMembersFromSupabase();
    await deleteClassesByActivityFromSupabase(activityId);
    db.classes = await loadClassesFromSupabase();
    writeDb(db);
    return send(res, 200, {
      ok: true,
      activities: db.activities.map(cleanActivity),
      members: db.members.map(m => cleanMember(m, true)),
      classes: db.classes.map(cleanClass)
    });
  }

  if (req.method === "POST" && url.pathname === "/api/classes") {
    const session = requireRole(req, res, ["admin", "coach"]);
    if (!session || !requireCsrf(req, res, session)) return;
    const body = await readBody(req);
    db = await dbWithSupabaseMembers();
    const activityId = resolveActivityId(db, body.activityId || body.title);
    if (!activityId) return send(res, 400, { error: "Actividad requerida." });
    if (!validDay(body.day)) return send(res, 400, { error: "Dia invalido." });
    if (!validTime(body.time)) return send(res, 400, { error: "Horario invalido." });
    if (!text(body.title, 80)) return send(res, 400, { error: "Nombre de clase requerido." });
    const item = {
      id: uniqueId(db),
      activityId,
      title: text(body.title, 80),
      coach: text(body.coach || "OFIT", 60),
      day: text(body.day, 20),
      time: text(body.time, 10),
      capacity: 10000,
      booked: [],
      place: "",
      focus: text(body.focus, 160)
    };
    const savedItem = await createClassInSupabase(item);
    db.classes = await loadClassesFromSupabase();
    return send(res, 201, { classItem: cleanClass(savedItem), activities: db.activities.map(cleanActivity), classes: db.classes.map(cleanClass) });
  }

  const classEditMatch = url.pathname.match(/^\/api\/classes\/(\d+)$/);
  if ((req.method === "PATCH" || req.method === "DELETE") && classEditMatch) {
    const session = requireRole(req, res, ["admin", "coach"]);
    if (!session || !requireCsrf(req, res, session)) return;
    db = await dbWithSupabaseMembers();
    const classId = Number(classEditMatch[1]);
    const item = db.classes.find(c => c.id === classId);
    if (!item) return send(res, 404, { error: "Clase no encontrada." });
    if (req.method === "DELETE") {
      await deleteClassFromSupabase(classId);
      db.classes = await loadClassesFromSupabase();
      return send(res, 200, { ok: true, classes: db.classes.map(cleanClass) });
    }
    const body = await readBody(req);
    const activityId = resolveActivityId(db, body.activityId || body.title);
    if (!activityId) return send(res, 400, { error: "Actividad requerida." });
    if (!validDay(body.day)) return send(res, 400, { error: "Dia invalido." });
    if (!validTime(body.time)) return send(res, 400, { error: "Horario invalido." });
    if (!text(body.title, 80)) return send(res, 400, { error: "Nombre de clase requerido." });
    item.activityId = activityId;
    item.title = text(body.title, 80);
    item.coach = text(body.coach || "OFIT", 60);
    item.day = text(body.day, 20);
    item.time = text(body.time, 10);
    item.capacity = 10000;
    item.place = "";
    item.focus = text(body.focus, 160);
    item.booked = Array.isArray(item.booked) ? item.booked : [];
    const savedItem = await updateClassInSupabase(item);
    db.classes = await loadClassesFromSupabase();
    return send(res, 200, { classItem: cleanClass(savedItem), activities: db.activities.map(cleanActivity), classes: db.classes.map(cleanClass) });
  }

  const classBookMatch = url.pathname.match(/^\/api\/classes\/(\d+)\/book$/);
  if (req.method === "POST" && classBookMatch) {
    const session = requireSession(req, res);
    if (!session || !requireCsrf(req, res, session)) return;
    const body = await readBody(req);
    db = await dbWithSupabaseMembers();
    const item = db.classes.find(c => c.id === Number(classBookMatch[1]));
    if (!item) return send(res, 404, { error: "Clase no encontrada." });
    const memberId = session.role === "member" ? session.memberId : Number(body.memberId);
    if (!memberId) return send(res, 400, { error: "Socio requerido." });
    const member = db.members.find(m => m.id === memberId);
    if (!member) return send(res, 404, { error: "Socio no encontrado." });
    item.booked = Array.isArray(item.booked) ? item.booked : [];
    if (!item.booked.includes(member.id)) {
      item.booked.push(member.id);
    }
    const savedItem = await updateClassInSupabase(item);
    db.classes = await loadClassesFromSupabase();
    return send(res, 200, { classItem: cleanClass(savedItem), classes: db.classes.map(cleanClass) });
  }

  return send(res, 404, { error: "Ruta no encontrada." });
}

const blockedStaticFiles = new Set(["server.js", "package.json", ".env", ".env.example", ".gitignore", "iniciar-servidor.bat"]);

// Nunca servir secretos, base de datos, codigo fuente ni logs por HTTP.
function isBlockedStatic(relPath) {
  const parts = relPath.split(/[\\/]+/).filter(Boolean);
  if (!parts.length) return false;
  if (parts.some(part => part.startsWith("."))) return true;        // .env, .git, dotfiles y dotdirs
  if (parts[0].toLowerCase() === "data") return true;                // data/db.json: hashes y datos personales
  const base = parts[parts.length - 1].toLowerCase();
  if (base.endsWith(".log")) return true;                            // server.out.log / server.err.log
  if (blockedStaticFiles.has(base)) return true;                     // codigo fuente y configuracion
  return false;
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let requested;
  try {
    requested = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400, securityHeaders());
    return res.end("Bad request");
  }
  if (requested === "/") requested = "/index.html";
  const filePath = path.normalize(path.join(root, requested));
  // startsWith(root + separador) evita escapar a carpetas hermanas con el mismo prefijo (GIMNASIOS-secret).
  if (filePath !== root && !filePath.startsWith(root + path.sep)) {
    res.writeHead(403, securityHeaders());
    return res.end("Forbidden");
  }
  if (isBlockedStatic(path.relative(root, filePath))) {
    res.writeHead(404, securityHeaders({ "Content-Type": "text/plain; charset=utf-8" }));
    return res.end("No encontrado");
  }
  let finalPath = filePath;
  if (!fs.existsSync(finalPath) || fs.statSync(finalPath).isDirectory()) finalPath = path.join(root, "index.html");
  const ext = path.extname(finalPath);
  const cacheControl = [".html", ".js", ".css"].includes(ext) ? "no-store" : "public, max-age=3600";
  res.writeHead(200, securityHeaders({ "Content-Type": mime[ext] || "application/octet-stream", "Cache-Control": cacheControl }));
  fs.createReadStream(finalPath).pipe(res);
}

// Revisa la configuracion real contra los hashes guardados y avisa fuerte si algo quedo inseguro.
function securityAudit() {
  const warnings = [];
  const weakPasswords = [
    "admin123", "profe123", "ana123", "socio123", "alumno123",
    "cambiar-admin-antes-de-publicar", "cambiar-profe-antes-de-publicar", "cambiar-alumno-antes-de-publicar"
  ];
  try {
    const db = readDb();
    for (const account of [...(db.staff || []), ...(db.members || [])]) {
      if (!account.passwordHash) continue;
      const weak = weakPasswords.find(candidate => verifyPassword(candidate, account.passwordHash));
      if (weak) warnings.push(`La cuenta "${account.user}" usa una contrasena debil/por defecto. Cambiala ya.`);
    }
  } catch (error) {
    warnings.push("No se pudo leer data/db.json para auditar contrasenas: " + error.message);
  }
  if (process.env.NODE_ENV === "production" && !allowedOrigins.length) {
    warnings.push("ALLOWED_ORIGINS esta vacio en produccion: configura los dominios permitidos.");
  }
  if (brevoApiKey) {
    warnings.push("Hay una BREVO_API_KEY cargada. Si este .env estuvo en un zip o repo compartido, ROTALA en Brevo.");
  }
  if (warnings.length) {
    console.warn("\n===== AVISOS DE SEGURIDAD OFIT =====");
    warnings.forEach(w => console.warn("  ! " + w));
    console.warn("====================================\n");
  }
}

// Sin gestor de procesos (el .bat no reinicia): un error imprevisto no debe tumbar el server para siempre.
process.on("unhandledRejection", reason => console.error("Rechazo de promesa no manejado:", reason));
process.on("uncaughtException", error => console.error("Excepcion no capturada (el server sigue vivo):", error));

async function runAutomaticPaymentReminders() {
  if (process.env.AUTO_PAYMENT_REMINDERS !== "true") return;
  try {
    const db = await dbWithSupabaseMembers();
    const dueMembers = db.members.filter(shouldSendPaymentReminder);
    for (const member of dueMembers) {
      await sendAndTrackPaymentReminder(member, db);
    }
    if (dueMembers.length) console.log(`Recordatorios automaticos enviados: ${dueMembers.length}`);
  } catch (error) {
    console.error("No se pudieron enviar recordatorios automaticos:", error.message);
  }
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/api/")) {
    if (!originAllowed(req)) {
      send(res, 403, { error: "Origen no permitido." });
      return;
    }
    for (const [key, value] of Object.entries(corsHeaders(req))) res.setHeader(key, value);
    if (req.method === "OPTIONS") {
      res.writeHead(204, securityHeaders());
      res.end();
      return;
    }
    handleApi(req, res).catch(() => send(res, 500, { error: "Error interno del servidor." }));
    return;
  }
  serveStatic(req, res);
});

const sweepTimer = setInterval(sweepExpired, 10 * 60 * 1000);
if (sweepTimer.unref) sweepTimer.unref();

const paymentReminderTimer = setInterval(runAutomaticPaymentReminders, 24 * 60 * 60 * 1000);
if (paymentReminderTimer.unref) paymentReminderTimer.unref();

server.listen(port, () => {
  console.log(`OFIT Gym funcionando en http://127.0.0.1:${port}`);
  securityAudit();
});
