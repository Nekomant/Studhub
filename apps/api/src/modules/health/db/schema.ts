// tmp
import { pgTable, text } from "drizzle-orm/pg-core";

export const tmpBroken = pgTable("tmp_broken", { id: text("id").primaryKey() });
