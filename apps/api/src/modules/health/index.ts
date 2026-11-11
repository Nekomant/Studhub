// Публичный вход модуля здоровья. Другие модули и main.ts импортируют только этот файл.
export { createHealthRepository } from "./db/health-repository.ts";
export { healthRoutes } from "./http/routes.ts";
