import { registerSW } from "virtual:pwa-register";

// Регистрирует service worker, который кэширует только статику (ТД §8). Режим обновления «prompt», но обработчика
// onNeedRefresh пока нет: баннер «Доступна новая версия» и установку приложения добавит этап 7.
// До него новая версия начинает работать после закрытия всех вкладок приложения.
export function registerServiceWorker() {
  registerSW({ immediate: true });
}
