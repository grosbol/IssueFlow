import { runSqlFile, pool } from "../db.js";

runSqlFile("sql/seed.sql")
  .then(async () => {
    console.log("Seed completed");
    await pool.end();
  })
  .catch(async (error) => {
    console.error("Seed failed", error);
    await pool.end();
    process.exit(1);
  });

