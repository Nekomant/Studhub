import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";

// Ошибки API в формате application/problem+json (RFC 9457) с полем code для машинной обработки (ТД §6.1).
// Стек и внутренние детали в ответ не попадают.

export const problemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  code: z.string(),
  details: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});

export type ProblemDetail = z.infer<typeof problemSchema>;

export const PROBLEM_CONTENT_TYPE = "application/problem+json; charset=utf-8";

export type ProblemOptions = {
  status: ContentfulStatusCode;
  code: string;
  title: string;
  details?: ProblemDetail["details"];
};

// Ошибка, которую обработчик ошибок превращает в problem+json с нужным статусом.
export class ProblemError extends Error {
  readonly status: ContentfulStatusCode;
  readonly code: string;
  readonly details: ProblemDetail["details"];

  constructor(options: ProblemOptions) {
    super(options.title);
    this.name = "ProblemError";
    this.status = options.status;
    this.code = options.code;
    this.details = options.details;
  }
}

export function problemBody(options: ProblemOptions): ProblemDetail {
  return {
    type: "about:blank",
    title: options.title,
    status: options.status,
    code: options.code,
    ...(options.details ? { details: options.details } : {}),
  };
}

export function problemResponse(c: Context, options: ProblemOptions): Response {
  return c.body(JSON.stringify(problemBody(options)), options.status, { "Content-Type": PROBLEM_CONTENT_TYPE });
}
