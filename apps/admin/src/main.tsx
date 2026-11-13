import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Stub } from "./stub.tsx";
import "./styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("В index.html нет элемента #root");

createRoot(container).render(
  <StrictMode>
    <Stub />
  </StrictMode>,
);
