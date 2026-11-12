import { healthQueryOptions } from "@studhub/client-core";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api.ts";

// Статус сервера по /healthz через сгенерированный клиент: показывает, что SPA достучалась до API.
export function ServerStatus() {
  const health = useQuery(healthQueryOptions(api));
  const text = health.isPending ? "Проверяем сервер…" : health.isError ? "Сервер недоступен" : "Сервер доступен";
  return (
    <p role="status" className="small mt-6 rounded-md bg-sunken px-3 py-2 text-ink-muted">
      {text}
    </p>
  );
}
