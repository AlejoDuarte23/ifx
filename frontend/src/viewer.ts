import * as THREE from "three";
import { createRuntime, type ViewerRuntime } from "./runtime.js";
import { viewerMarkup, viewerStyles } from "./ui.js";
import {
  extractIfc,
  type CoreOptions,
  type ExtractedIfc,
  type TessellationQuality,
} from "./core.js";
import { prepareModel, type PreparedModel } from "./prepared.js";
import { assertSupportedIfcSchema } from "./schema.js";

export type IfcSource = Blob | ArrayBuffer | Uint8Array;
export type ViewerOptions = CoreOptions & {
  background?: THREE.ColorRepresentation;
  tessellationQuality?: TessellationQuality;
  ui?: boolean;
  openPropertiesOnSelect?: boolean;
  selectionColor?: THREE.ColorRepresentation;
};
export type Viewer = ViewerRuntime & {
  load(source: IfcSource): Promise<ExtractedIfc>;
  readonly data: ExtractedIfc | null;
  toLocal(point: THREE.Vector3): THREE.Vector3;
  toWorld(point: THREE.Vector3): THREE.Vector3;
};

export function createViewer(
  container: HTMLElement,
  options: ViewerOptions = {},
): Viewer {
  const host = document.createElement("div");
  host.style.cssText = "width:100%;height:100%;position:relative";
  container.append(host);
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = viewerStyles;
  shadow.append(style);
  const template = document.createElement("template");
  template.innerHTML = viewerMarkup;
  shadow.append(template.content.cloneNode(true));
  const root = shadow.querySelector<HTMLElement>("#ifx-root");
  if (options.ui === false)
    root
      .querySelectorAll<HTMLElement>(
        ".viewer-toolbar,.viewer-panel,.viewer-context-menu,.viewer-status",
      )
      .forEach((node) => (node.style.display = "none"));
  const runtime = createRuntime(root, options);
  if (options.background !== undefined)
    runtime.scene.background = new THREE.Color(options.background);
  let data: ExtractedIfc | null = null;
  let generation = 0;
  let disposed = false;
  let activeLoad: AbortController | null = null;
  const origin = () =>
    new THREE.Vector3().fromArray(
      runtime.getModelInfo().world_origin ?? [0, 0, 0],
    );
  return Object.freeze({
    ...runtime,
    get data() {
      return data;
    },
    async load(source: IfcSource) {
      if (disposed) throw new Error("The viewer has been disposed.");
      const request = ++generation;
      activeLoad?.abort();
      activeLoad = new AbortController();
      const bytes =
        source instanceof Blob
          ? new Uint8Array(await source.arrayBuffer())
          : source instanceof Uint8Array
            ? source
            : new Uint8Array(source);
      assertSupportedIfcSchema(bytes);
      const extracted = await extractIfc(
        bytes,
        options.tessellationQuality ?? "medium",
        { ...options, signal: activeLoad.signal },
      );
      if (disposed || request !== generation)
        throw new Error("Model load was cancelled.");
      data = extracted;
      await runtime.loadPrepared(prepareModel(extracted));
      if (disposed || request !== generation)
        throw new Error("Model load was cancelled.");
      return extracted;
    },
    async loadPrepared(input: Uint8Array | PreparedModel) {
      data = null;
      ++generation;
      activeLoad?.abort();
      return runtime.loadPrepared(input);
    },
    clear() {
      data = null;
      ++generation;
      activeLoad?.abort();
      runtime.clear();
    },
    dispose() {
      disposed = true;
      ++generation;
      activeLoad?.abort();
      runtime.dispose();
      host.remove();
    },
    toLocal: (point: THREE.Vector3) => point.clone().sub(origin()),
    toWorld: (point: THREE.Vector3) => point.clone().add(origin()),
  });
}
