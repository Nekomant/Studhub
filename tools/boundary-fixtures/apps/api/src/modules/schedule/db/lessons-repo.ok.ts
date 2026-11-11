import { and, eq } from "drizzle-orm";
import { pgTable } from "drizzle-orm/pg-core";
import type { Lesson } from "../domain/lesson.ts";

export type L = Lesson;
export const ok = [and, eq, pgTable];
