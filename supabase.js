const https = require("https");

const supabaseUrl = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
const supabaseKey = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || "";
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

function supabaseConfigured() {
  return Boolean(supabaseUrl && supabaseKey);
}

function supabaseRequest(path, { method = "GET", headers = {}, body, serviceRole = false } = {}) {
  if (!supabaseConfigured()) return Promise.reject(new Error("Supabase no esta configurado."));
  const apiKey = serviceRole ? supabaseServiceKey : supabaseKey;
  if (serviceRole && !apiKey) return Promise.reject(new Error("SUPABASE_SERVICE_ROLE_KEY no esta configurada."));

  const url = new URL(path, `${supabaseUrl}/rest/v1/`);
  const payload = body === undefined ? undefined : JSON.stringify(body);

  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method,
      headers: {
        apikey: apiKey,
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
        ...headers
      }
    }, response => {
      let raw = "";
      response.on("data", chunk => {
        raw += chunk;
      });
      response.on("end", () => {
        let data = raw;
        if (raw) {
          try {
            data = JSON.parse(raw);
          } catch {
            data = raw;
          }
        }

        if (response.statusCode < 200 || response.statusCode >= 300) {
          const error = new Error(data && data.message ? data.message : `Supabase respondio ${response.statusCode}`);
          error.statusCode = response.statusCode;
          error.data = data;
          reject(error);
          return;
        }

        resolve(data);
      });
    });

    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function supabaseStorageRequest(path, { method = "GET", headers = {}, body, serviceRole = true, responseType = "json" } = {}) {
  if (!supabaseConfigured()) return Promise.reject(new Error("Supabase no esta configurado."));
  const apiKey = serviceRole ? supabaseServiceKey : supabaseKey;
  if (serviceRole && !apiKey) return Promise.reject(new Error("SUPABASE_SERVICE_ROLE_KEY no esta configurada."));

  const url = new URL(path, `${supabaseUrl}/storage/v1/`);
  const payload = Buffer.isBuffer(body) || typeof body === "string" ? body : body === undefined ? undefined : JSON.stringify(body);

  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method,
      headers: {
        apikey: apiKey,
        Authorization: `Bearer ${apiKey}`,
        ...(Buffer.isBuffer(payload) ? {} : { "Content-Type": "application/json" }),
        ...headers
      }
    }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => {
        const rawBuffer = Buffer.concat(chunks);
        let data = rawBuffer;

        if (responseType !== "buffer") {
          const raw = rawBuffer.toString("utf8");
          data = raw;
          if (raw) {
            try {
              data = JSON.parse(raw);
            } catch {
              data = raw;
            }
          }
        }

        if (response.statusCode < 200 || response.statusCode >= 300) {
          const error = new Error(data && data.message ? data.message : `Supabase Storage respondio ${response.statusCode}`);
          error.statusCode = response.statusCode;
          error.data = data;
          reject(error);
          return;
        }

        resolve(data);
      });
    });

    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function testSupabaseConnection() {
  await supabaseRequest("clientes?select=id&limit=1");
  return { ok: true };
}

module.exports = {
  supabaseConfigured,
  supabaseRequest,
  supabaseStorageRequest,
  testSupabaseConnection
};
