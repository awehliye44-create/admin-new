import { createRoot } from "react-dom/client";
import { initSentry } from "./lib/sentry";
import { resolveMapboxToken } from "./lib/mapbox";
import App from "./App.tsx";
import "./index.css";

// Initialise Sentry BEFORE React renders (admin panel only)
initSentry();

// Resolve Mapbox web token before first map mount (env or get-mapbox-token).
void resolveMapboxToken().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : "Mapbox token preload failed";
  console.warn("[mapbox] preload:", msg);
});

createRoot(document.getElementById("root")!).render(<App />);
