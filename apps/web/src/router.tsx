import { appRoutes, startPath } from "@studhub/client-core";
import { createRootRoute, createRoute, createRouter, redirect } from "@tanstack/react-router";
import { NotFound } from "./screens/not-found.tsx";
import { ServerStatus } from "./screens/server-status.tsx";
import { Stub } from "./screens/stub.tsx";
import { AppShell } from "./shell/app-shell.tsx";

// Маршруты строятся из карты в client-core (ТД §3, §8): адреса и подписи живут там, здесь только отрисовка.
const rootRoute = createRootRoute({ component: AppShell, notFoundComponent: NotFound });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: startPath, replace: true });
  },
});

const screenRoutes = appRoutes.map((entry) =>
  createRoute({
    getParentRoute: () => rootRoute,
    path: entry.path,
    // Статус сервера на стартовом экране проверяет связь SPA с API; настоящий экран «Сегодня» его заменит.
    component: () => <Stub title={entry.label}>{entry.path === startPath ? <ServerStatus /> : null}</Stub>,
  }),
);

export const router = createRouter({ routeTree: rootRoute.addChildren([indexRoute, ...screenRoutes]) });
