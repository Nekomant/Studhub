import { PgBoss } from "pg-boss";
import type { Logger } from "../logger/index.ts";

// Фоновые задачи на pg-boss (ТД §12, ADR-0002). Очередь и расписание хранятся в схеме `pgboss` той же БД.
// Модуль объявляет задачу через `define`: с расписанием (cron) или без него. Задачу без расписания запускает `send`.
// Любую задачу можно запустить и вручную через `send`; тесты запускают её синхронно через `runNow`.

export const JOBS_SCHEMA = "pgboss";

export type JobRetryPolicy = {
  // Сколько раз повторить задачу после первой ошибки. 0 — не повторять.
  limit: number;
  // Пауза до первого повтора, секунды.
  delaySeconds: number;
  // true — пауза растёт экспоненциально с каждым повтором.
  backoff?: boolean | undefined;
};

export const DEFAULT_RETRY: JobRetryPolicy = { limit: 3, delaySeconds: 30, backoff: true };

export type JobContext = {
  // Номер попытки, начиная с 1.
  attempt: number;
  logger: Logger;
};

export type JobDefinition<TData extends object = Record<string, never>> = {
  // Уникальное имя: латиница, цифры, `.`, `-`, `_`. Пример: `lessons.advance-statuses`.
  name: string;
  // cron-выражение (5 полей, время UTC). Без него задача запускается только событием.
  schedule?: string | undefined;
  retry?: JobRetryPolicy | undefined;
  handler: (data: TData, context: JobContext) => Promise<void>;
};

export type JobRunResult = { outcome: "completed" } | { outcome: "failed"; errorType: string };

export type JobStats = { succeeded: number; failed: number };

export type Jobs = {
  // Объявляет задачу. Вызывать до `start`.
  define<TData extends object>(definition: JobDefinition<TData>): void;
  // Создаёт схему pg-boss, очереди и расписание, запускает воркеры.
  start(): Promise<void>;
  // true после успешного `start` и до `stop`.
  isRunning(): boolean;
  // Дожидается активных задач (не дольше таймаута) и закрывает соединения.
  stop(): Promise<void>;
  // Ставит задачу в очередь. Возвращает id задачи.
  send(name: string, data?: object): Promise<string>;
  // Выполняет обработчик здесь и сейчас, без очереди и расписания. Для тестов.
  runNow(name: string, data?: object): Promise<JobRunResult>;
  // Сколько раз каждая задача завершилась успехом и ошибкой в этом процессе.
  stats(): Record<string, JobStats>;
};

type AnyDefinition = JobDefinition<object>;

const STOP_TIMEOUT_MS = 5_000;
const NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;

// В лог идёт только тип и код ошибки: текст ошибки и данные задачи могут содержать ПДн (ТД §9).
function describeError(error: unknown): { errorType: string; errorCode?: string } {
  if (!(error instanceof Error)) return { errorType: "UnknownError" };
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? { errorType: error.name, errorCode: code } : { errorType: error.name };
}

const START_RETRY_INITIAL_MS = 1_000;
const START_RETRY_MAX_MS = 60_000;

// Пауза, которую можно прервать сигналом остановки.
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done);
  });
}

// Запускает pg-boss и при ошибке повторяет запуск, пока процесс жив: пауза растёт вдвое до потолка.
// Ошибки только логируются: HTTP при этом работает. Возвращается после успешного запуска или по сигналу остановки.
export async function startJobsWithRetry(
  jobs: Jobs,
  options: {
    logger: Logger;
    signal: AbortSignal;
    initialDelayMs?: number;
    maxDelayMs?: number;
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  },
): Promise<void> {
  const { logger, signal } = options;
  const sleep = options.sleep ?? abortableSleep;
  let delay = options.initialDelayMs ?? START_RETRY_INITIAL_MS;
  const maxDelay = options.maxDelayMs ?? START_RETRY_MAX_MS;
  for (let attempt = 1; !signal.aborted; attempt++) {
    try {
      await jobs.start();
      logger.info({ attempt, running: jobs.isRunning() }, "фоновые задачи запущены");
      return;
    } catch (error) {
      logger.error(
        { attempt, running: jobs.isRunning(), retryInMs: delay, ...describeError(error) },
        "pg-boss не запустился, повторю",
      );
      await sleep(delay, signal);
      delay = Math.min(delay * 2, maxDelay);
    }
  }
}

export function createJobs(options: { databaseUrl: string; logger: Logger }): Jobs {
  const { logger } = options;
  const definitions = new Map<string, AnyDefinition>();
  const counters = new Map<string, JobStats>();
  let boss: PgBoss | undefined;

  function definitionOf(name: string): AnyDefinition {
    const definition = definitions.get(name);
    if (!definition) throw new Error(`Задача «${name}» не объявлена`);
    return definition;
  }

  function retryOf(definition: AnyDefinition): JobRetryPolicy {
    return definition.retry ?? DEFAULT_RETRY;
  }

  // Общий путь выполнения для воркера и `runNow`: учёт, лог ошибки без ПДн, ошибка уходит наверх.
  async function execute(definition: AnyDefinition, data: object, attempt: number, jobId?: string): Promise<void> {
    const counter = counters.get(definition.name);
    if (!counter) throw new Error(`Задача «${definition.name}» не объявлена`);
    try {
      await definition.handler(data, { attempt, logger: logger.child({ job: definition.name }) });
      counter.succeeded += 1;
    } catch (error) {
      counter.failed += 1;
      logger.error(
        {
          job: definition.name,
          jobId,
          attempt,
          willRetry: attempt - 1 < retryOf(definition).limit,
          ...describeError(error),
        },
        "задача завершилась ошибкой",
      );
      throw error;
    }
  }

  return {
    define(definition) {
      if (boss) throw new Error("Задачи объявляют до запуска pg-boss");
      if (!NAME_PATTERN.test(definition.name)) throw new Error(`Недопустимое имя задачи «${definition.name}»`);
      if (definitions.has(definition.name)) throw new Error(`Задача «${definition.name}» уже объявлена`);
      definitions.set(definition.name, definition as unknown as AnyDefinition);
      counters.set(definition.name, { succeeded: 0, failed: 0 });
    },

    async start() {
      if (boss) throw new Error("pg-boss уже запущен");
      const instance = new PgBoss({ connectionString: options.databaseUrl, schema: JOBS_SCHEMA, max: 4 });
      // Ошибки самого pg-boss (потеря соединения и т. п.) только логируем: процесс и HTTP продолжают работать.
      instance.on("error", (error) => logger.error(describeError(error), "ошибка pg-boss"));
      try {
        await instance.start();
        // Расписания задач, которых нет в коде (удалили или переименовали), снимаем: иначе pg-boss ставит их в очередь без воркера.
        const scheduled = new Set([...definitions.values()].filter((item) => item.schedule).map((item) => item.name));
        for (const schedule of await instance.getSchedules()) {
          if (!scheduled.has(schedule.name)) await instance.unschedule(schedule.name, schedule.key);
        }
        for (const definition of definitions.values()) {
          const retry = retryOf(definition);
          const queueOptions = {
            retryLimit: retry.limit,
            retryDelay: retry.delaySeconds,
            retryBackoff: retry.backoff ?? false,
          };
          // Новая очередь создаётся сразу с политикой повторов. У существующей политика из кода главнее той,
          // что осталась от прошлой версии.
          if (await instance.getQueue(definition.name)) await instance.updateQueue(definition.name, queueOptions);
          else await instance.createQueue(definition.name, queueOptions);
          if (definition.schedule) await instance.schedule(definition.name, definition.schedule, {});
          await instance.work<object>(definition.name, async ([job]) => {
            if (!job) return;
            await execute(definition, job.data, job.retryCount + 1, job.id);
          });
        }
      } catch (error) {
        // Незапущенный экземпляр закрываем, иначе он держит соединения. Ошибку закрытия не показываем: главная ошибка выше.
        await instance.stop({ graceful: false, timeout: STOP_TIMEOUT_MS }).catch(() => {});
        throw error;
      }
      boss = instance;
    },

    isRunning() {
      return boss !== undefined;
    },

    async stop() {
      const instance = boss;
      boss = undefined;
      if (instance) await instance.stop({ graceful: true, timeout: STOP_TIMEOUT_MS });
    },

    async send(name, data = {}) {
      definitionOf(name);
      if (!boss) throw new Error("pg-boss не запущен");
      const id = await boss.send(name, data);
      if (!id) throw new Error(`Задача «${name}» не поставлена в очередь`);
      return id;
    },

    async runNow(name, data = {}) {
      const definition = definitionOf(name);
      try {
        await execute(definition, data, 1);
        return { outcome: "completed" };
      } catch (error) {
        return { outcome: "failed", errorType: describeError(error).errorType };
      }
    },

    stats() {
      return Object.fromEntries([...counters].map(([name, counter]) => [name, { ...counter }]));
    },
  };
}
