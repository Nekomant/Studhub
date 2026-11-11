import { Hono } from "hono";
import { students } from "../../students";
import { studentsApi } from "../../students/index.ts";
import { generateLessons } from "../domain/generate.ts";
import { lessonsRepo } from "../db/lessons-repo.ts";

export const ok = [Hono, students, studentsApi, generateLessons, lessonsRepo];
