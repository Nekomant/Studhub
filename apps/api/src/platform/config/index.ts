import { z } from "zod";

// Схема переменных окружения (ТД §12). Единственное место, где они описаны.
// Новые переменные добавляем сюда и в `.env.example` (тест проверяет).

const postgresUrl = z
  .string()
  .refine((value) => /^postgres(ql)?:\/\/.+/.test(value), "должен начинаться с postgres://");

export const configSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: postgresUrl,
  TEST_DATABASE_URL: postgresUrl.optional(),
  S3_ENDPOINT: z.url(),
  S3_REGION: z.string().min(1),
  S3_BUCKET: z.string().min(3),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
});

export type Config = z.infer<typeof configSchema>;
export type ConfigIssue = z.core.$ZodIssue;

// Текст ошибки содержит имена переменных и причину, но не их значения:
// в секретах значения не должны попадать в логи (ТД §9).
export function formatConfigIssues(issues: readonly ConfigIssue[]): string {
  return issues
    .map((issue) => {
      const name = issue.path.map(String).join(".") || "(корень)";
      const reason = issue.message.includes("received undefined") ? "не задана" : "задана неверно";
      return `- ${name}: ${reason}`;
    })
    .join("\n");
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`Неверная конфигурация окружения:\n${formatConfigIssues(result.error.issues)}`);
  }
  return result.data;
}

// Вызывается при старте приложения: при ошибке печатает список проблем и завершает процесс.
export function runStartupConfigCheck(
  env: Record<string, string | undefined>,
  deps: { log: (message: string) => void; exit: (code: number) => void },
): Config | undefined {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    deps.log(`Неверная конфигурация окружения:\n${formatConfigIssues(result.error.issues)}`);
    deps.exit(1);
    return undefined;
  }
  return result.data;
}
