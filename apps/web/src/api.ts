import { createApiClient } from "@studhub/client-core";

// Клиент API ходит на тот же адрес, с которого открыта SPA: в dev и preview запросы идут через прокси Vite, в prod через Caddy.
export const api = createApiClient(window.location.origin);
