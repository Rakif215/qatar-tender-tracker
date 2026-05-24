import "dotenv/config";
import pg from "pg";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? "postgres://localhost:5432/qatar_tenders",
});

export async function withClient(callback) {
  const client = await pool.connect();
  try {
    return await callback(client);
  } finally {
    client.release();
  }
}

