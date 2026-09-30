import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { app, listen, refresh } from "./store.ts";
import { fitZoom } from "./Timeline.tsx";

createRoot(document.getElementById("root")!).render(<App />);
refresh().then(() => {
  const { project } = app.get();
  if (project) app.set({ pxPerFrame: fitZoom(project) });
});
listen();
