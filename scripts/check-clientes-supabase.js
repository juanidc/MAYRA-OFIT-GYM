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

const { supabaseRequest } = require("../supabase");

async function main() {
  const rows = await supabaseRequest("clientes?select=id,numero_alumno,nombre_completo,usuario,email&order=numero_alumno.asc", {
    serviceRole: true
  });
  console.log(JSON.stringify(rows, null, 2));
}

main().catch(error => {
  console.error(error.message || "No se pudo verificar clientes.");
  process.exitCode = 1;
});
