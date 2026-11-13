import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerServiceWorker } from "./pwa.ts";
import { router } from "./router.tsx";
import "./styles.css";

const queryClient = new QueryClient();
const container = document.getElementById("root");
if (!container) throw new Error("В index.html нет элемента #root");

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);

registerServiceWorker();
