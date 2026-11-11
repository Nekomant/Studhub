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

type Env = Record<string, string | undefined>;

// Пустая строка (`S3_BUCKET=` в файле окружения) считается незаданной переменной.
function normalize(env: Env): Env {
  return Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ""));
}

// Текст ошибки содержит имена переменных и причину, но не их значения:
// в секретах значения не должны попадать в логи (ТД §9).
export function formatConfigIssues(issues: readonly ConfigIssue[], env: Env): string {
  const present = normalize(env);
  return issues
    .map((issue) => {
      const name = issue.path.map(String).join(".") || "(корень)";
      const reason = present[name] === undefined ? "не задана" : "задана неверно";
      return `- ${name}: ${reason}`;
    })
    .join("\n");
}

export function loadConfig(env: Env): Config {
  const result = configSchema.safeParse(normalize(env));
  if (!result.success) {
    throw new Error(`Неверная конфигурация окружения:\n${formatConfigIssues(result.error.issues, env)}`);
  }
  return result.data;
}

// Вызывается при старте приложения: при ошибке печатает список проблем и завершает процесс.
export function runStartupConfigCheck(
  env: Env,
  deps: { log: (message: string) => void; exit: (code: number) => void },
): Config | undefined {
  try {
    return loadConfig(env);
  } catch (error) {
    deps.log(error instanceof Error ? error.message : String(error));
    deps.exit(1);
    return undefined;
  }
}
