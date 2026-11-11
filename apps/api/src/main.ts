import { runStartupConfigCheck } from "./platform/config/index.ts";

// Сборку приложения добавит задача «Каркас API» (SH-004). Сейчас здесь только проверка окружения.
runStartupConfigCheck(process.env, { log: console.error, exit: (code) => process.exit(code) });
