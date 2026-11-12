import type { JobDefinition, Jobs } from "../jobs/index.ts";

// Служебные задачи для API-тестов. main.ts объявляет их только при APP_MODE=test.

export const FLAKY_JOB = "test.flaky";

export type FlakyData = { failTimes?: number };

// Падает первые `failTimes` попыток (по умолчанию все), потом завершается успешно.
// Политика повторов короткая, чтобы тест не ждал дольше нескольких секунд.
const flakyJob: JobDefinition<FlakyData> = {
  name: FLAKY_JOB,
  retry: { limit: 2, delaySeconds: 1 },
  handler: async (data, { attempt }) => {
    if (attempt <= (data.failTimes ?? Number.POSITIVE_INFINITY)) {
      // Текст ошибки с ПДн нужен, чтобы тест проверил: лог его не повторяет.
      throw new Error("Иванов Иван +79990001122 не найден");
    }
  },
};

export function defineTestJobs(jobs: Jobs): void {
  jobs.define(flakyJob);
}
