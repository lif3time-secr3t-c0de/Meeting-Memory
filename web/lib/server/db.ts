import { Pool } from "pg";
import type { QueryResultRow } from "pg";

let pool: Pool | null = null;

function shouldUseSsl(): boolean {
  const raw = process.env.DATABASE_SSL?.trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes";
}

export function getDbPool(): Pool | null {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) return null;

  if (!pool) {
    pool = new Pool({
      connectionString,
      ssl: shouldUseSsl() ? { rejectUnauthorized: false } : undefined,
    });
  }

  return pool;
}

export async function runQuery<T extends QueryResultRow = QueryResultRow>(
  queryText: string,
  values: unknown[] = [],
): Promise<{ rows: T[]; rowCount: number; skipped: boolean }> {
  const dbPool = getDbPool();
  if (!dbPool) {
    return { rows: [], rowCount: 0, skipped: true };
  }

  const result = await dbPool.query<T>(queryText, values);
  return {
    rows: result.rows,
    rowCount: result.rowCount ?? 0,
    skipped: false,
  };
}
