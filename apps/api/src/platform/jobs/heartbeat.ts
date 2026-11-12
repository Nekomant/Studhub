import type { JobDefinition } from "./index.ts";

export const HEARTBEAT_JOB = "platform.heartbeat";

// Служебная задача-пример: раз в минуту пишет в лог, что фоновые задачи работают.
// Показывает модулям, как объявить задачу с cron. Данных не читает и не пишет.
export const heartbeatJob: JobDefinition = {
  name: HEARTBEAT_JOB,
  schedule: "* * * * *",
  retry: { limit: 0, delaySeconds: 1 },
  handler: async (_data, { logger }) => {
    logger.info("фоновые задачи работают");
  },
};
