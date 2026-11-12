import type { Logger } from "./logger/index.ts";

// Остановка процесса: сначала HTTP (запросы в работе доводим до конца), потом фоновые задачи.
// Возвращает код выхода: 0 — всё остановилось штатно, 1 — шаг упал или не уложился в таймаут.

export type ShutdownSteps = {
  // Перестаёт принимать запросы и вызывает колбэк, когда все запросы в работе закончились.
  closeServer: (done: (error?: Error) => void) => void;
  // Закрывает соединения, которые не дождались конца запроса после таймаута.
  forceCloseServer?: (() => void) | undefined;
  // Останавливает запуск и воркеры pg-boss.
  stopJobs: () => Promise<void>;
};

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<{ timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve({ timedOut: true }), ms);
    promise.then(
      () => {
        clearTimeout(timer);
        resolve({ timedOut: false });
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export async function gracefulShutdown(
  steps: ShutdownSteps,
  options: { logger: Logger; httpTimeoutMs: number; jobsTimeoutMs: number },
): Promise<0 | 1> {
  const { logger } = options;
  let code: 0 | 1 = 0;

  const closed = new Promise<void>((resolve, reject) =>
    steps.closeServer((error) => (error ? reject(error) : resolve())),
  );
  try {
    const result = await withTimeout(closed, options.httpTimeoutMs);
    if (result.timedOut) {
      logger.warn({ timeoutMs: options.httpTimeoutMs }, "запросы не закончились за таймаут, закрываю соединения");
      steps.forceCloseServer?.();
      code = 1;
    }
  } catch {
    logger.error("HTTP-сервер не закрылся штатно");
    code = 1;
  }

  try {
    const result = await withTimeout(steps.stopJobs(), options.jobsTimeoutMs);
    if (result.timedOut) {
      logger.error({ timeoutMs: options.jobsTimeoutMs }, "фоновые задачи не остановились за таймаут");
      code = 1;
    }
  } catch {
    logger.error("фоновые задачи не остановились штатно");
    code = 1;
  }
  return code;
}
