import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "@/styles/theme.css";

const dark = window.matchMedia("(prefers-color-scheme: dark)");
const applyTheme = (on: boolean) =>
  document.documentElement.classList.toggle("dark", on);

applyTheme(dark.matches);
dark.addEventListener("change", (e) => applyTheme(e.matches));

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
