import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

export const ok = [drizzle, Pool];
