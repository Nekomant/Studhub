import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger } from "./index.ts";

function captureLogger() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  const logger = createLogger({ level: "info", destination: stream });
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  return { logger, lines, flush };
}

const secrets = {
  name: "Анна Петрова",
  phone: "+79161234567",
  email: "anna@example.com",
  telegram: "@anna_petrova",
  noteText: "мама просила не давать задания на выходных",
  accessToken: "tok_live_secret_123",
  cookie: "sh_session=abc123secret",
  authorization: "Bearer xyz789secret",
};

describe("логгер pino", () => {
  it("[SH-004 AC-4] пишет каждую запись одной строкой JSON", async () => {
    const { logger, lines, flush } = captureLogger();
    logger.info({ status: 200, path: "/healthz" }, "запрос");
    await flush();
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0] ?? "");
    expect(record.msg).toBe("запрос");
    expect(record.status).toBe(200);
    expect(record.path).toBe("/healthz");
  });

  it("[SH-004 AC-4] поля с ПДн и секреты маскируются, в том числе вложенные", async () => {
    const { logger, lines, flush } = captureLogger();
    logger.info(
      {
        ...secrets,
        student: { name: secrets.name, phone: secrets.phone },
        headers: { authorization: secrets.authorization, cookie: secrets.cookie },
      },
      "событие",
    );
    await flush();
    const text = lines.join("");
    for (const value of Object.values(secrets)) {
      expect(text).not.toContain(value);
    }
    const record = JSON.parse(lines[0] ?? "");
    expect(record.name).toBe("[Redacted]");
    expect(record.student.phone).toBe("[Redacted]");
    expect(record.headers.authorization).toBe("[Redacted]");
  });

  it("[SH-004 AC-4] поля без ПДн остаются в записи", async () => {
    const { logger, lines, flush } = captureLogger();
    logger.info({ requestId: "req-1", durationMs: 12 }, "ok");
    await flush();
    const record = JSON.parse(lines[0] ?? "");
    expect(record.requestId).toBe("req-1");
    expect(record.durationMs).toBe(12);
  });
});
