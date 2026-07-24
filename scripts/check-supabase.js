const fs = require("fs");
const path = require("path");

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

const { supabaseConfigured, testSupabaseConnection } = require("../supabase");

async function main() {
  if (!supabaseConfigured()) {
    console.log("SUPABASE_NOT_CONFIGURED");
    process.exitCode = 1;
    return;
  }

  try {
    await testSupabaseConnection();
    console.log("SUPABASE_OK");
  } catch (error) {
    const details = [
      error.message,
      error.code ? `code=${error.code}` : "",
      error.statusCode ? `status=${error.statusCode}` : "",
      error.data ? `data=${JSON.stringify(error.data)}` : ""
    ].filter(Boolean).join(" ");
    console.log(`SUPABASE_ERROR: ${details || "sin detalle"}`);
    process.exitCode = 1;
  }
}

main();
