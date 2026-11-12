import { registerSW } from "virtual:pwa-register";

// Регистрирует service worker, который кэширует только статику (ТД §8). Баннер «Доступна новая версия»
// и установку приложения добавит этап 7: пока обновление применяется, когда закрыты все вкладки.
export function registerServiceWorker() {
  registerSW({ immediate: true });
}
