import { createRuntime } from "../../../frontend/src/runtime.js";
const config = (globalThis as any).__IFX_VIEWER_CONFIG__;
if (!config?.payload) throw new Error("IFX viewer configuration is missing.");
const root = document.getElementById("ifx-root");
const viewer = createRuntime(root, config);
(globalThis as any).IFXViewer = viewer;
viewer.on("select", (detail) =>
  globalThis.dispatchEvent(new CustomEvent("ifx:select", { detail })),
);
const spec = config.payload;
const compressed =
  spec.mode === "url"
    ? new Uint8Array(await (await fetch(spec.url)).arrayBuffer())
    : Uint8Array.from(
        atob(document.getElementById(spec.elementId).textContent.trim()),
        (char) => char.charCodeAt(0),
      );
try {
  await viewer.loadPrepared(compressed);
  globalThis.dispatchEvent(
    new CustomEvent("ifx:ready", { detail: { viewer } }),
  );
} catch (error) {
  root.querySelector('[role="status"]').textContent = String(error);
  throw error;
}
