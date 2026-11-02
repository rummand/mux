import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);

// Installable as an app (Chrome, Edge, Safari's "Add to Dock" / "Add to Home Screen"); not from the Vite dev server.
if ("serviceWorker" in navigator && location.port !== "5173") void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
