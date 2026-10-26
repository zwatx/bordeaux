import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App, AppErrorBoundary } from "./app/App";
import { WindowsTitleBar } from "./components/WindowsTitleBar";
import { installTooltips } from "./components/tooltips";
import "./styles/app.css";
import "./styles/library.css";
import "./styles/routine-workspace.css";
import "./styles/robot-push.css";
import "./styles/workspace.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Renderer root element is missing");
}

document.documentElement.dataset.platform = window.bordeauxAPI?.platform || "web";
installTooltips();

createRoot(root).render(
  <StrictMode>
    <div className={window.bordeauxAPI?.platform === "win32" ? "windows-desktop" : "desktop-root"}>
      <WindowsTitleBar />
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
    </div>
  </StrictMode>,
);
