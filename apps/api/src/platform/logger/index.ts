import pino, { type DestinationStream, type Logger } from "pino";

export type { Logger };

// Поля, в которых могут быть ПДн или секреты (ТД §9). Совпадение по имени поля без учёта регистра.
// Значения в логах не пишем, даже частично.
const SENSITIVE_KEY = /name|phone|email|telegram|token|secret|password|cookie|authorization|note|^summary$|^plan$/i;
const MASK = "[Redacted]";

// Маскирует поля рекурсивно: внутри вложенных объектов и массивов тоже.
export function maskSensitive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskSensitive);
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Error) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, inner]) => [key, SENSITIVE_KEY.test(key) ? MASK : maskSensitive(inner)]),
  );
}

export function createLogger(options: { level: string; destination?: DestinationStream }): Logger {
  return pino(
    {
      level: options.level,
      formatters: {
        log: (object) => maskSensitive(object) as Record<string, unknown>,
      },
    },
    options.destination,
  );
}
