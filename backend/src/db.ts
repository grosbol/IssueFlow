import { Pool } from "pg";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const pool = new Pool({
  connectionString: config.databaseUrl,
});

export async function runSqlFile(relativePath: string) {
  const sqlPath = path.resolve(__dirname, "..", relativePath);
  const sql = await readFile(sqlPath, "utf8");
  await pool.query(sql);
}
