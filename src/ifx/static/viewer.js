// src/runtime.ts
import * as THREE3 from "three";

// src/navigation.ts
import * as THREE from "three";
function wheelZoomScale(pixels) {
  return Math.exp(Math.max(-1200, Math.min(1200, pixels)) * 2e-3);
}
function cursorZoom(position, forward, direction, distance, scale) {
  if (![...position, ...forward, ...direction, distance, scale].every(Number.isFinite) || distance <= 0 || scale <= 0) return null;
  const nextDistance = distance * scale;
  const alignment = forward.reduce((sum, value, i) => sum + value * direction[i], 0);
  if (alignment <= 0 || !Number.isFinite(nextDistance)) return null;
  const moved = position.map((value, i) => value + direction[i] * (distance - nextDistance));
  const target = moved.map((value, i) => value + forward[i] * nextDistance * alignment);
  return [...moved, ...target].every(Number.isFinite) ? { position: moved, target } : null;
}
function modelClipping(position, target, bounds) {
  const distance = Math.hypot(...position.map((value, i) => value - target[i]));
  const near = Math.max(distance / 1e3, 1e-7);
  const centre = [0, 1, 2].map((i) => (bounds[i] + bounds[i + 3]) / 2);
  const radius = Math.hypot(...[0, 1, 2].map((i) => bounds[i + 3] - bounds[i])) / 2;
  return { near, far: Math.max(Math.hypot(...position.map((value, i) => value - centre[i])) + radius, near * 100) };
}
function attachCursorNavigation(viewer2) {
  const { camera, controls, renderer } = viewer2;
  const lifetime = new AbortController();
  controls.minDistance = 0;
  controls.maxDistance = Infinity;
  renderer.domElement.addEventListener("wheel", (event) => {
    if (!controls.enabled || !controls.enableZoom) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const rect = renderer.domElement.getBoundingClientRect();
    const pointer = new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, 1 - (event.clientY - rect.top) / rect.height * 2);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(pointer, camera);
    const forward = camera.getWorldDirection(new THREE.Vector3());
    const alignment = forward.dot(ray.ray.direction);
    if (alignment <= 0) return;
    const distance = viewer2.hitTest(event.clientX, event.clientY)?.distance ?? camera.position.distanceTo(controls.target) / alignment;
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1;
    const moved = cursorZoom(camera.position.toArray(), forward.toArray(), ray.ray.direction.toArray(), distance, wheelZoomScale(event.deltaY * unit * (event.ctrlKey ? 4 : 1)));
    if (!moved) return;
    camera.position.fromArray(moved.position);
    controls.target.fromArray(moved.target);
    controls.update();
    viewer2.invalidate();
  }, { capture: true, passive: false, signal: lifetime.signal });
  return () => lifetime.abort();
}

// src/runtime.ts
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  acceleratedRaycast,
  computeBoundsTree,
  disposeBoundsTree,
  CENTER
} from "three-mesh-bvh";

// src/overlays.ts
import * as THREE2 from "three";
function disposeObject(object) {
  disposeObjects([object]);
}
function disposeObjects(objects) {
  const geometries = /* @__PURE__ */ new Set();
  const materials = /* @__PURE__ */ new Set();
  for (const object of objects)
    object.traverse((child) => {
      const rendered = child;
      if (rendered.geometry) geometries.add(rendered.geometry);
      if (rendered.material)
        for (const material of Array.isArray(rendered.material) ? rendered.material : [rendered.material])
          materials.add(material);
    });
  for (const geometry of geometries) {
    geometry.disposeBoundsTree?.();
    geometry.dispose();
  }
  for (const material of materials) material.dispose();
}
var OverlayScenes = class {
  constructor(scene, invalidate) {
    this.scene = scene;
    this.invalidate = invalidate;
  }
  scene;
  invalidate;
  groups = /* @__PURE__ */ new Map();
  hasScene(name) {
    return this.groups.has(name);
  }
  addScene(name) {
    if (!name.trim()) throw new Error("An overlay name is required.");
    let group = this.groups.get(name);
    if (!group) {
      group = new THREE2.Group();
      group.name = name;
      this.groups.set(name, group);
      this.scene.add(group);
      this.invalidate();
    }
    return group;
  }
  addObject(object, name) {
    this.addScene(name).add(object);
    this.invalidate();
  }
  addMesh(mesh, name) {
    this.addObject(mesh, name);
  }
  removeMesh(mesh, name, dispose = false) {
    const group = this.groups.get(name);
    if (mesh.parent !== group) return;
    group.remove(mesh);
    if (dispose) disposeObject(mesh);
    this.invalidate();
  }
  clearScene(name, dispose = false) {
    const group = this.groups.get(name);
    if (!group) return;
    for (const child of [...group.children]) {
      group.remove(child);
      if (dispose) disposeObject(child);
    }
    this.invalidate();
  }
  setVisible(name, visible) {
    const group = this.groups.get(name);
    if (group) {
      group.visible = visible;
      this.invalidate();
    }
  }
  removeScene(name, dispose = false) {
    const group = this.groups.get(name);
    if (!group) return;
    this.clearScene(name, dispose);
    group.removeFromParent();
    this.groups.delete(name);
    this.invalidate();
  }
  dispose() {
    disposeObjects([...this.groups.values()]);
    for (const group of this.groups.values()) {
      group.removeFromParent();
      group.clear();
    }
    this.groups.clear();
    this.invalidate();
  }
};

// src/types.ts
function elementRanges(element) {
  return element.geometry_ranges ?? [element];
}

// src/runtime.ts
THREE3.Mesh.prototype.raycast = acceleratedRaycast;
THREE3.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE3.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
function createRuntime(root2, CONFIG = {}) {
  let statusTimer;
  let disposed = false;
  let loadVersion = 0;
  const lifetime = new AbortController();
  const events = new EventTarget();
  const emit = (type, detail) => events.dispatchEvent(new CustomEvent(type, { detail }));
  const MAGIC = "IFCVIEW1";
  const SECTION_NAMES = [
    "opaque_positions",
    "opaque_normals",
    "opaque_colors",
    "opaque_indices",
    "transparent_positions",
    "transparent_normals",
    "transparent_colors",
    "transparent_indices"
  ];
  const SEMANTIC_HELPER_TYPES = /* @__PURE__ */ new Set([
    "IfcSpace",
    "IfcSpatialZone",
    "IfcOpeningElement",
    "IfcVirtualElement"
  ]);
  const MEASURE_UNIT_TYPES = /* @__PURE__ */ new Map([
    ["IFCLENGTHMEASURE", "LENGTHUNIT"],
    ["IFCNONNEGATIVELENGTHMEASURE", "LENGTHUNIT"],
    ["IFCPOSITIVELENGTHMEASURE", "LENGTHUNIT"],
    ["IFCAREAMEASURE", "AREAUNIT"],
    ["IFCVOLUMEMEASURE", "VOLUMEUNIT"],
    ["IFCPLANEANGLEMEASURE", "PLANEANGLEUNIT"],
    ["IFCPOSITIVEPLANEANGLEMEASURE", "PLANEANGLEUNIT"],
    ["IFCMASSMEASURE", "MASSUNIT"],
    ["IFCTIMEMEASURE", "TIMEUNIT"],
    ["IFCTHERMODYNAMICTEMPERATUREMEASURE", "THERMODYNAMICTEMPERATUREUNIT"],
    ["IFCELECTRICCURRENTMEASURE", "ELECTRICCURRENTUNIT"],
    ["IFCELECTRICVOLTAGEMEASURE", "ELECTRICVOLTAGEUNIT"],
    ["IFCPOWERMEASURE", "POWERUNIT"],
    ["IFCPRESSUREMEASURE", "PRESSUREUNIT"],
    ["IFCFREQUENCYMEASURE", "FREQUENCYUNIT"],
    ["IFCLUMINOUSFLUXMEASURE", "LUMINOUSFLUXUNIT"],
    ["IFCILLUMINANCEMEASURE", "ILLUMINANCEUNIT"],
    ["IFCMONETARYMEASURE", "MONETARYUNIT"]
  ]);
  const QUANTITY_UNIT_TYPES = /* @__PURE__ */ new Map([
    ["LENGTH", "LENGTHUNIT"],
    ["AREA", "AREAUNIT"],
    ["VOLUME", "VOLUMEUNIT"],
    ["WEIGHT", "MASSUNIT"],
    ["MASS", "MASSUNIT"],
    ["TIME", "TIMEUNIT"]
  ]);
  const INTEGER_VALUE_TYPES = /* @__PURE__ */ new Set(["IFCINTEGER", "IFCCOUNTMEASURE"]);
  const NUMERIC_VALUE_TYPES = /* @__PURE__ */ new Set([
    "IFCREAL",
    "IFCNUMBER",
    ...MEASURE_UNIT_TYPES.keys()
  ]);
  const canvas = requiredElement("ifx-canvas");
  const statusNode = requiredElement("ifx-status");
  const panel = requiredElement("ifx-panel");
  const panelContent = requiredElement("panel-content");
  const modelPanel = requiredElement("ifx-model-panel");
  const modelSearch = requiredElement("ifx-model-search");
  const modelTree = requiredElement("ifx-model-tree");
  const contextMenu = requiredElement("ifx-context-menu");
  const state = {
    metadata: null,
    batches: /* @__PURE__ */ new Map(),
    elementsById: /* @__PURE__ */ new Map(),
    rangesByBatch: /* @__PURE__ */ new Map(),
    customColors: /* @__PURE__ */ new Map(),
    hidden: /* @__PURE__ */ new Set(),
    defaultHidden: /* @__PURE__ */ new Set(),
    selectedId: null,
    selectionReady: false,
    modelOpenTypes: /* @__PURE__ */ new Set(),
    modelClosedGroups: /* @__PURE__ */ new Set(),
    modelFocusIds: null,
    modelFocusKey: null,
    focusMeshes: /* @__PURE__ */ new Map(),
    gridVisible: true,
    doubleSided: true,
    flatShading: true
  };
  setStatus("Loading model\u2026");
  const scene = new THREE3.Scene();
  scene.background = new THREE3.Color(16251130);
  const camera = new THREE3.PerspectiveCamera(45, 1, 0.01, 1e6);
  camera.up.set(0, 0, 1);
  const renderer = new THREE3.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
    powerPreference: "high-performance",
    preserveDrawingBuffer: false
  });
  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 1.75));
  renderer.outputColorSpace = THREE3.SRGBColorSpace;
  renderer.toneMapping = THREE3.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.localClippingEnabled = true;
  let clippingPlanes = [];
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = false;
  controls.screenSpacePanning = true;
  controls.zoomToCursor = true;
  controls.addEventListener("change", invalidate);
  scene.add(new THREE3.HemisphereLight(16777215, 13620701, 2.2));
  const sun = new THREE3.DirectionalLight(16777215, 1.6);
  sun.position.set(7, -10, 14);
  scene.add(sun);
  const modelGroup = new THREE3.Group();
  modelGroup.name = "IFC model";
  scene.add(modelGroup);
  const selectionGroup = new THREE3.Group();
  selectionGroup.name = "IFC selection";
  scene.add(selectionGroup);
  const focusGroup = new THREE3.Group();
  focusGroup.name = "IFC model focus";
  scene.add(focusGroup);
  let grid = null;
  let renderQueued = false;
  let pointerDown = null;
  const raycaster = new THREE3.Raycaster();
  raycaster.firstHitOnly = true;
  const pointer = new THREE3.Vector2();
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(root2);
  for (const button of root2.querySelectorAll(
    "[data-action]"
  )) {
    button.addEventListener("click", () => runAction(button.dataset.action));
  }
  for (const button of contextMenu.querySelectorAll(
    "[data-context-action]"
  )) {
    button.addEventListener(
      "click",
      () => runContextAction(button.dataset.contextAction)
    );
  }
  let panelDrag = null;
  for (const header of root2.querySelectorAll(".panel-header")) {
    header.addEventListener("pointerdown", startPanelDrag);
    header.addEventListener("pointermove", movePanelDrag);
    header.addEventListener("pointerup", endPanelDrag);
    header.addEventListener("pointercancel", endPanelDrag);
    header.addEventListener("dblclick", resetPanelPosition);
  }
  modelSearch.addEventListener(
    "input",
    () => renderModelTree(modelSearch.value)
  );
  renderer.domElement.addEventListener("pointerdown", (event) => {
    pointerDown = { x: event.clientX, y: event.clientY, button: event.button };
  });
  renderer.domElement.addEventListener("pointerup", (event) => {
    if (event.defaultPrevented) {
      pointerDown = null;
      return;
    }
    if (!pointerDown || pointerDown.button !== 0) return;
    const distance = Math.hypot(
      event.clientX - pointerDown.x,
      event.clientY - pointerDown.y
    );
    pointerDown = null;
    if (distance <= 5) {
      if (state.modelFocusIds) showAll();
      else pick(event.clientX, event.clientY);
    }
  });
  renderer.domElement.addEventListener("contextmenu", openContextMenu);
  globalThis.addEventListener(
    "pointerdown",
    (event) => {
      if (!contextMenu.hidden && !event.composedPath().includes(contextMenu))
        closeContextMenu();
    },
    { signal: lifetime.signal }
  );
  globalThis.addEventListener("blur", closeContextMenu, {
    signal: lifetime.signal
  });
  globalThis.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape") closeContextMenu();
    },
    { signal: lifetime.signal }
  );
  async function loadPrepared(input) {
    if (disposed) throw new Error("The viewer has been disposed.");
    const version = ++loadVersion;
    const source = input?.metadata ? input : parseContainer(await gunzip(input));
    const parsed = {
      metadata: structuredClone(source.metadata),
      sections: {
        ...source.sections,
        opaque_colors: source.sections.opaque_colors.slice(),
        transparent_colors: source.sections.transparent_colors.slice()
      }
    };
    if (disposed || version !== loadVersion)
      throw new Error("Model load was cancelled.");
    clearModel();
    state.metadata = parsed.metadata;
    indexElements(parsed.metadata.elements || []);
    renderModelTree();
    buildBatch("opaque", parsed.sections, false);
    buildBatch("transparent", parsed.sections, true);
    refreshAllColors();
    buildGrid();
    fitModel();
    resize();
    invalidate();
    const model = parsed.metadata.model || {};
    const triangleCount = [...state.batches.values()].reduce(
      (sum, batch) => sum + batch.geometry.index.count / 3,
      0
    );
    setStatus(
      `${formatInteger(model.element_count || state.elementsById.size)} elements \xB7 ${formatInteger(triangleCount)} triangles` + (model.crs_name ? ` \xB7 ${model.crs_name}` : "")
    );
    await buildSelectionIndex(version);
    if (disposed || version !== loadVersion)
      throw new Error("Model load was cancelled.");
    emit("ready", { model: parsed.metadata.model });
    return api;
  }
  async function gunzip(bytes) {
    if (typeof DecompressionStream !== "function") {
      throw new Error(
        "This browser does not support gzip decompression streams."
      );
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Response(stream).arrayBuffer();
  }
  function parseContainer(buffer) {
    const bytes = new Uint8Array(buffer);
    const magic = new TextDecoder().decode(bytes.subarray(0, 8));
    if (magic !== MAGIC)
      throw new Error("The model payload has an unknown format.");
    const view = new DataView(buffer);
    let offset = 8;
    const metadataLength = view.getUint32(offset, true);
    offset += 4;
    const metadataBytes = bytes.subarray(offset, offset + metadataLength);
    const metadata = JSON.parse(new TextDecoder().decode(metadataBytes));
    offset = align4(offset + metadataLength);
    const rawSections = {};
    for (const name of SECTION_NAMES) {
      const length = view.getUint32(offset, true);
      offset += 4;
      rawSections[name] = { offset, length };
      offset = align4(offset + length);
    }
    const sections = {
      opaque_positions: float32View(buffer, rawSections.opaque_positions),
      opaque_normals: float32View(buffer, rawSections.opaque_normals),
      opaque_colors: uint8View(buffer, rawSections.opaque_colors),
      opaque_indices: uint32View(buffer, rawSections.opaque_indices),
      transparent_positions: float32View(
        buffer,
        rawSections.transparent_positions
      ),
      transparent_normals: float32View(buffer, rawSections.transparent_normals),
      transparent_colors: uint8View(buffer, rawSections.transparent_colors),
      transparent_indices: uint32View(buffer, rawSections.transparent_indices)
    };
    return { metadata, sections };
  }
  function buildBatch(name, sections, transparent) {
    const positions = sections[`${name}_positions`];
    const normals = sections[`${name}_normals`];
    const colors = sections[`${name}_colors`];
    const indices = sections[`${name}_indices`];
    if (!positions.length || !indices.length) return;
    const geometry = new THREE3.BufferGeometry();
    geometry.setAttribute("position", new THREE3.BufferAttribute(positions, 3));
    geometry.setAttribute("normal", new THREE3.BufferAttribute(normals, 3));
    geometry.setAttribute("color", new THREE3.BufferAttribute(colors, 4, true));
    geometry.setIndex(new THREE3.BufferAttribute(indices, 1));
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    const material = transparent ? new THREE3.MeshBasicMaterial({
      clippingPlanes,
      vertexColors: true,
      side: state.doubleSided ? THREE3.DoubleSide : THREE3.FrontSide,
      transparent: true,
      depthFunc: THREE3.EqualDepth,
      depthWrite: false,
      alphaHash: false,
      alphaTest: 0.01
    }) : new THREE3.MeshStandardMaterial({
      vertexColors: true,
      flatShading: state.flatShading,
      roughness: 0.78,
      metalness: 0.02,
      side: state.doubleSided ? THREE3.DoubleSide : THREE3.FrontSide,
      depthFunc: THREE3.LessDepth,
      depthWrite: true,
      alphaHash: false,
      alphaTest: 0.01
    });
    material.clippingPlanes = clippingPlanes;
    material.forceSinglePass = transparent;
    const pickMaterial = transparent ? new THREE3.MeshBasicMaterial({ visible: false, side: THREE3.DoubleSide }) : material;
    const mesh = new THREE3.Mesh(geometry, pickMaterial);
    mesh.name = `${name} IFC geometry`;
    mesh.userData.batchName = name;
    modelGroup.add(mesh);
    const transparentRender = transparent ? buildTransparentElementMeshes(
      positions,
      normals,
      colors,
      indices,
      material
    ) : { renderMeshes: /* @__PURE__ */ new Map(), depthMaterial: null };
    const baseColors = colors.slice();
    for (const range of state.rangesByBatch.get(name) || []) {
      for (const source of range.materials ?? [{ ...range, color: range.base_color }]) {
        for (let i = source.vertex_start * 4; i < (source.vertex_start + source.vertex_count) * 4; i += 4) baseColors.set(source.color, i);
      }
    }
    state.batches.set(name, {
      baseColors,
      mesh,
      geometry,
      material,
      transparent,
      renderMeshes: transparentRender.renderMeshes,
      depthMaterial: transparentRender.depthMaterial
    });
  }
  function buildTransparentElementMeshes(positions, normals, colors, indices, material) {
    const renderMeshes = /* @__PURE__ */ new Map();
    const depthMaterial = new THREE3.MeshBasicMaterial({
      clippingPlanes,
      vertexColors: true,
      alphaTest: 0.01,
      colorWrite: false,
      depthWrite: true,
      depthTest: true,
      side: state.doubleSided ? THREE3.DoubleSide : THREE3.FrontSide
    });
    for (const element of state.rangesByBatch.get("transparent") || []) {
      const vertexStart = element.vertex_start;
      const vertexEnd = vertexStart + element.vertex_count;
      const indexStart = element.triangle_start * 3;
      const indexEnd = indexStart + element.triangle_count * 3;
      const elementIndices = indices.slice(indexStart, indexEnd);
      for (let index = 0; index < elementIndices.length; index += 1) {
        elementIndices[index] -= vertexStart;
      }
      const geometry = new THREE3.BufferGeometry();
      geometry.setAttribute(
        "position",
        new THREE3.BufferAttribute(
          positions.subarray(vertexStart * 3, vertexEnd * 3),
          3
        )
      );
      geometry.setAttribute(
        "normal",
        new THREE3.BufferAttribute(
          normals.subarray(vertexStart * 3, vertexEnd * 3),
          3
        )
      );
      geometry.setAttribute(
        "color",
        new THREE3.BufferAttribute(
          colors.subarray(vertexStart * 4, vertexEnd * 4),
          4,
          true
        )
      );
      geometry.setIndex(new THREE3.BufferAttribute(elementIndices, 1));
      geometry.computeBoundingSphere();
      const depthMesh = new THREE3.Mesh(geometry, depthMaterial);
      depthMesh.name = `${element.ifc_type || "IFC"} #${element.id} depth`;
      depthMesh.renderOrder = 1;
      modelGroup.add(depthMesh);
      const colorMesh = new THREE3.Mesh(geometry, material);
      colorMesh.name = `${element.ifc_type || "IFC"} #${element.id}`;
      colorMesh.userData.batchName = "transparent";
      colorMesh.userData.elementId = element.id;
      colorMesh.renderOrder = 2;
      modelGroup.add(colorMesh);
      renderMeshes.set(element.id, colorMesh);
    }
    return { renderMeshes, depthMaterial };
  }
  function indexElements(elements) {
    const ranges = /* @__PURE__ */ new Map();
    for (const element of elements) {
      const id = Number(element.id);
      element.id = id;
      state.elementsById.set(id, element);
      for (const range of elementRanges(element)) {
        if (!ranges.has(range.batch)) ranges.set(range.batch, []);
        ranges.get(range.batch).push({ ...element, ...range });
      }
      if (element.color_override ?? (Array.isArray(element.configured_color) && element.configured_color.some((value, i) => value !== element.base_color?.[i]))) {
        state.customColors.set(id, element.configured_color.slice());
      }
      if (SEMANTIC_HELPER_TYPES.has(element.ifc_type) || Array.isArray(element.display_color) && (element.display_color[3] ?? 255) === 0) {
        state.hidden.add(id);
        state.defaultHidden.add(id);
      }
    }
    for (const [batch, items] of ranges) {
      items.sort((a, b) => a.triangle_start - b.triangle_start);
      state.rangesByBatch.set(batch, items);
    }
  }
  function renderModelTree(query = "") {
    const needle = String(query).trim().toLocaleLowerCase();
    const groups = /* @__PURE__ */ new Map();
    for (const element of state.elementsById.values()) {
      const searchable = `${element.ifc_type || ""} ${element.name || ""} ${element.id}`.toLocaleLowerCase();
      if (needle && !searchable.includes(needle)) continue;
      const type = element.ifc_type || "IfcProduct";
      if (!groups.has(type)) groups.set(type, []);
      groups.get(type).push(element);
    }
    const fragment = document.createDocumentFragment();
    for (const [type, elements] of [...groups].sort(
      ([a], [b]) => a.localeCompare(b)
    )) {
      fragment.append(
        renderElementGroup({
          groupKey: `type:${type}`,
          label: `${formatIfcType(type)} (${elements.length})`,
          focusLabel: formatIfcType(type),
          elements,
          depth: 0,
          defaultOpen: Boolean(needle)
        })
      );
    }
    if (!fragment.childNodes.length)
      fragment.append(node("p", "model-tree-empty", "No elements found."));
    modelTree.replaceChildren(fragment);
  }
  function renderElementGroup({
    groupKey,
    label,
    focusLabel,
    elements,
    depth,
    defaultOpen = false
  }) {
    const details = document.createElement("details");
    details.className = "model-group element-type-group";
    details.open = groupIsOpen(groupKey, defaultOpen);
    details.classList.toggle("focused", state.modelFocusKey === groupKey);
    const summary = document.createElement("summary");
    summary.style.setProperty("--tree-depth", String(depth));
    summary.append(
      node("span", "model-group-label", label),
      focusButton(elements, groupKey, focusLabel)
    );
    details.append(summary);
    const children = node("div", "model-group-items");
    const populate = () => {
      if (children.childElementCount) return;
      for (const element of elements)
        children.append(modelElementRow(element, depth + 1));
    };
    connectGroupToggle({ details, summary, populate, groupKey, elements });
    if (details.open) populate();
    details.append(children);
    return details;
  }
  function connectGroupToggle({
    details,
    summary,
    populate,
    groupKey,
    elements
  }) {
    summary.addEventListener("click", (event) => {
      if (event.target.closest(".visibility-button")) return;
      event.preventDefault();
      details.open = !details.open;
      rememberGroupState(groupKey, details.open);
      if (details.open) populate();
      focusModelElements(elements, groupKey);
    });
    details.addEventListener("toggle", () => {
      rememberGroupState(groupKey, details.open);
      if (details.open) populate();
    });
  }
  function groupIsOpen(groupKey, defaultOpen = false) {
    if (state.modelClosedGroups.has(groupKey)) return false;
    return state.modelOpenTypes.has(groupKey) || defaultOpen;
  }
  function rememberGroupState(groupKey, open) {
    if (open) {
      state.modelOpenTypes.add(groupKey);
      state.modelClosedGroups.delete(groupKey);
    } else {
      state.modelOpenTypes.delete(groupKey);
      state.modelClosedGroups.add(groupKey);
    }
  }
  function modelElementRow(element, depth = 1) {
    const row = node("div", "model-element");
    row.style.setProperty("--tree-depth", String(depth));
    const focusKey = `element:${element.id}`;
    if (state.modelFocusKey === focusKey) row.classList.add("selected");
    if (state.hidden.has(element.id)) row.classList.add("hidden");
    const selectButton = node(
      "button",
      "model-element-select",
      element.name || `${formatIfcType(element.ifc_type)} #${element.id}`
    );
    selectButton.type = "button";
    selectButton.title = selectButton.textContent;
    selectButton.addEventListener("click", () => {
      focusModelElements([element], focusKey);
    });
    row.append(
      selectButton,
      focusButton([element], focusKey, selectButton.textContent)
    );
    return row;
  }
  function focusButton(elements, focusKey, label) {
    const button = node("button", "visibility-button");
    button.type = "button";
    const active = state.modelFocusKey === focusKey;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
    button.setAttribute(
      "aria-label",
      active ? `Show all model after ${label}` : `Focus ${label}`
    );
    button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6Z"/><circle cx="12" cy="12" r="2.5"/></svg>';
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      focusModelElements(elements, focusKey);
    });
    return button;
  }
  function focusModelElements(elements, focusKey) {
    if (state.modelFocusKey === focusKey) {
      showAll();
      return;
    }
    state.hidden = new Set(state.defaultHidden);
    for (const element of elements) state.hidden.delete(element.id);
    state.modelFocusIds = new Set(elements.map((element) => element.id));
    state.modelFocusKey = focusKey;
    setFocusMaterialMode(true);
    updateFocusOverlay();
    state.selectedId = null;
    updateSelectionOverlay();
    panelContent.replaceChildren(
      node("p", "panel-empty", "Click an element in the model to inspect it.")
    );
    refreshAllColors();
    renderModelTree(modelSearch.value);
    invalidate();
  }
  function formatIfcType(type) {
    return String(type || "IfcProduct").replace(/^Ifc/, "").replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  }
  async function buildSelectionIndex(version) {
    if (!state.batches.size) return;
    setStatus("Building fast selection index\u2026");
    await nextFrame();
    try {
      for (const { geometry } of state.batches.values()) {
        if (disposed || version !== loadVersion) return;
        geometry.computeBoundsTree({
          strategy: CENTER,
          indirect: true,
          targetLeafSize: 24
        });
        await nextFrame();
      }
      if (disposed || version !== loadVersion) return;
      state.selectionReady = true;
      const model = state.metadata.model || {};
      setStatus(
        `${formatInteger(model.element_count || state.elementsById.size)} elements \xB7 ready` + (model.crs_name ? ` \xB7 ${model.crs_name}` : "")
      );
    } catch (error) {
      console.warn(
        "BVH construction failed; falling back to standard raycasting.",
        error
      );
      if (disposed || version !== loadVersion) return;
      state.selectionReady = true;
      setStatus("Model ready; fast selection index could not be built.", true);
    }
  }
  function pick(clientX, clientY) {
    if (!state.selectionReady) {
      setStatus("Selection index is still being built.");
      return null;
    }
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = (clientX - rect.left) / rect.width * 2 - 1;
    pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    raycaster.firstHitOnly = state.hidden.size === 0 && clippingPlanes.length === 0;
    const intersections = raycaster.intersectObjects(
      [...state.batches.values()].map((batch) => batch.mesh),
      false
    );
    for (const hit of intersections) {
      const batch = hit.object.userData.batchName;
      const element = elementForTriangle(batch, hit.faceIndex);
      if (element && !state.hidden.has(element.id) && isPointVisible(hit.point)) {
        select(element.id);
        return element;
      }
    }
    select(null);
    return null;
  }
  function elementForTriangle(batch, triangleIndex) {
    if (!Number.isInteger(triangleIndex)) return null;
    const ranges = state.rangesByBatch.get(batch) || [];
    let low = 0;
    let high = ranges.length - 1;
    while (low <= high) {
      const middle = low + high >> 1;
      const item = ranges[middle];
      const start = item.triangle_start;
      const end = start + item.triangle_count;
      if (triangleIndex < start) high = middle - 1;
      else if (triangleIndex >= end) low = middle + 1;
      else return state.elementsById.get(item.id);
    }
    return null;
  }
  function select(expressId, openProperties = CONFIG.openPropertiesOnSelect !== false) {
    const nextId = expressId == null ? null : Number(expressId);
    if (nextId !== null && !state.elementsById.has(nextId)) return false;
    const previous = state.selectedId;
    state.selectedId = nextId;
    refreshElementColors([previous, nextId].filter((value) => value !== null));
    updateSelectionOverlay();
    if (nextId === null) {
      panelContent.replaceChildren(
        node(
          "p",
          "panel-empty",
          "Click an element in the model to inspect it."
        )
      );
      emit("select", null);
    } else {
      const element = state.elementsById.get(nextId);
      renderProperties(element);
      if (openProperties) {
        releasePanelFocus(modelPanel);
        modelPanel.classList.remove("open");
        modelPanel.setAttribute("aria-hidden", "true");
        setActionPressed("toggle-model", false);
        panel.classList.add("open");
        panel.setAttribute("aria-hidden", "false");
        setActionPressed("toggle-panel", true);
      }
      emit("select", structuredClone(element));
    }
    refreshModelTree();
    invalidate();
    return true;
  }
  function renderProperties(element) {
    const fragment = document.createDocumentFragment();
    const identity = node("section", "property-card");
    identity.append(node("h2", null, "Attributes"));
    const table = node("dl", "identity-grid");
    addDefinition(table, "Name", element.name);
    addDefinition(table, "IFC class", formatIfcType(element.ifc_type));
    addDefinition(table, "STEP ID", `#${element.id}`);
    addDefinition(table, "Global ID", element.global_id);
    addDefinition(table, "ObjectType", element.object_type);
    for (const item of element.attributes || []) {
      addDefinition(
        table,
        item.name,
        formatPropertyValue(item.value, item.value_type)
      );
    }
    identity.append(table);
    fragment.append(identity);
    appendReferenceSection(fragment, element);
    appendSetSection(
      fragment,
      "Property sets",
      element.property_sets,
      "properties"
    );
    appendSetSection(
      fragment,
      "Quantity sets",
      element.quantity_sets,
      "quantities"
    );
    if (!element.attributes?.length && !element.property_sets?.length && !element.quantity_sets?.length) {
      fragment.append(
        node(
          "p",
          "panel-empty",
          "No decoded properties are available for this element."
        )
      );
    }
    panelContent.replaceChildren(fragment);
  }
  function appendReferenceSection(parent, element) {
    const index = state.metadata?.references || {};
    const reference = index.elements?.[String(element.id)];
    if (!reference) return;
    const outer = document.createElement("details");
    outer.className = "property-group reference-group";
    outer.open = true;
    outer.append(node("summary", null, "References"));
    const spatialRows = [];
    if (reference.container_id !== void 0) {
      spatialRows.push([
        "Container",
        formatSpatialReference(reference.container_id)
      ]);
    }
    if (reference.storey_id !== void 0 && Number(reference.storey_id) !== Number(reference.container_id)) {
      spatialRows.push(["Storey", formatSpatialReference(reference.storey_id)]);
    }
    if (Array.isArray(reference.referenced_by_structure)) {
      spatialRows.push([
        "Referenced by",
        reference.referenced_by_structure.map(formatSpatialReference).filter(Boolean).join(", ")
      ]);
    }
    appendReferenceSet(outer, "Spatial", spatialRows);
    const relationshipRows = summariseRelationships(
      reference.relationships || []
    );
    appendReferenceSet(outer, "Relationships", relationshipRows);
    for (const assignment of reference.classifications || []) {
      const definitionId = String(assignment.definition_id);
      const classification = index.classification_references?.[definitionId] || index.classification_systems?.[definitionId] || {};
      appendReferenceSet(outer, "Classification", [
        ["System", classification.system_name || classification.name],
        ["Code", classification.identification],
        ["Name", classification.name],
        [
          "Path",
          Array.isArray(classification.path) ? classification.path.join(" > ") : null
        ],
        ["Location", classification.location],
        [
          "Inherited from type",
          assignment.inherited_from_type == null ? null : formatReferenceTarget(assignment.inherited_from_type)
        ]
      ]);
    }
    for (const assignment of reference.documents || []) {
      const documentInfo = index.document_definitions?.[String(assignment.definition_id)] || {};
      appendReferenceSet(outer, "Document", [
        ["Name", documentInfo.name],
        ["Identification", documentInfo.identification],
        ["Description", documentInfo.description],
        ["Location", documentInfo.location],
        ["Purpose", documentInfo.purpose],
        ["Revision", documentInfo.revision],
        ["Status", documentInfo.status],
        [
          "Inherited from type",
          assignment.inherited_from_type == null ? null : formatReferenceTarget(assignment.inherited_from_type)
        ]
      ]);
    }
    for (const membership of reference.groups || []) {
      const group = index.group_definitions?.[String(membership.group_id)] || {};
      appendReferenceSet(outer, formatIfcType(group.ifc_type || "IfcGroup"), [
        ["Name", group.name],
        ["Long name", group.long_name],
        ["Type", group.object_type || group.predefined_type],
        ["Description", group.description],
        ["Assignment factor", membership.factor]
      ]);
    }
    for (const connection of reference.connections || []) {
      const isRelating = Number(connection.relating_element_id) === Number(element.id);
      appendReferenceSet(outer, "Connection", [
        ["Type", formatIfcType(connection.relationship_type)],
        [
          "Connected element",
          formatReferenceTarget(
            isRelating ? connection.related_element_id : connection.relating_element_id
          )
        ],
        [
          "Connection type",
          isRelating ? connection.relating_connection_type : connection.related_connection_type
        ]
      ]);
    }
    for (const portRow of reference.ports || []) {
      const port = index.port_definitions?.[String(portRow.port_id)] || {};
      appendReferenceSet(outer, "Port", [
        ["Name", port.name],
        ["Flow direction", port.flow_direction],
        ["Type", port.predefined_type],
        ["System", port.system_type],
        [
          "Connected ports",
          Array.isArray(portRow.connected_ports) ? portRow.connected_ports.map(formatReferenceTarget).filter(Boolean).join(", ") : null
        ]
      ]);
    }
    for (const boundary of reference.space_boundaries || []) {
      const isSpace = Number(boundary.space_id) === Number(element.id);
      appendReferenceSet(outer, "Space boundary", [
        ["Level", formatIfcType(boundary.relationship_type)],
        ["Space", isSpace ? null : formatReferenceTarget(boundary.space_id)],
        [
          "Element",
          isSpace ? formatReferenceTarget(boundary.element_id) : null
        ],
        ["Boundary", boundary.physical_or_virtual],
        ["Location", boundary.internal_or_external]
      ]);
    }
    for (const assignment of reference.materials || []) {
      const definition = index.material_definitions?.[String(assignment.definition_id)] || {};
      const materialName = definition.name && definition.name !== "<Unnamed>" ? definition.name : "Unnamed material";
      appendReferenceSet(outer, "Material", [
        ["Name", materialName],
        ["Category", definition.category]
      ]);
      appendReferenceSet(outer, "Definition", [
        ["Type", formatIfcType(definition.material_type)],
        [
          "Inherited from type",
          assignment.inherited_from_type == null ? null : formatReferenceTarget(assignment.inherited_from_type)
        ]
      ]);
      appendMaterialPartsSection(outer, "Layers", definition.layers);
      appendMaterialPartsSection(
        outer,
        "Constituents",
        definition.constituents
      );
      appendMaterialPartsSection(outer, "Profiles", definition.profiles);
      appendMaterialPartsSection(outer, "Materials", definition.materials);
    }
    if (outer.children.length > 1) parent.append(outer);
  }
  function appendReferenceSet(parent, title, rows) {
    const available = rows.filter(
      ([, value]) => value !== null && value !== void 0 && value !== ""
    );
    if (!available.length) return;
    const section = document.createElement("details");
    section.className = "property-set reference-set";
    section.open = true;
    section.append(node("summary", null, title));
    const table = node("dl", "property-list");
    for (const [label, value] of available) addDefinition(table, label, value);
    section.append(table);
    parent.append(section);
  }
  function formatSpatialReference(expressId) {
    const numericId = Number(expressId);
    const spatialNode = state.metadata?.references?.spatial_nodes?.[String(numericId)];
    if (!spatialNode) return null;
    const fallback = formatIfcType(spatialNode.ifc_type);
    const name = spatialNode.name && !/^Entity #\d+$/i.test(spatialNode.name) ? spatialNode.name : fallback;
    return name;
  }
  function summariseRelationships(relationships) {
    const groups = /* @__PURE__ */ new Map();
    for (const relationship of relationships) {
      const label = relationshipLabel(relationship);
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(relationship);
    }
    return [...groups.entries()].map(([label, rows]) => {
      const targets = rows.map((row) => formatReferenceTarget(row.target_id)).filter(Boolean);
      if (!targets.length) return null;
      const visible = targets.slice(0, 4).join(", ");
      const remainder = targets.length > 4 ? ` +${targets.length - 4} more` : "";
      return [label, `${visible}${remainder}`];
    }).filter(Boolean);
  }
  function relationshipLabel(relationship) {
    const related = relationship.role === "related";
    switch (relationship.relationship_type) {
      case "IfcRelDefinesByType":
        return related ? "Type definition" : "Typed occurrences";
      case "IfcRelAggregates":
        return related ? "Aggregated by" : "Aggregated parts";
      case "IfcRelNests":
        return related ? "Nested under" : "Nested items";
      case "IfcRelVoidsElement":
        return related ? "Voids element" : "Openings";
      case "IfcRelFillsElement":
        return related ? "Fills opening" : "Filling elements";
      case "IfcRelAssignsToGroup":
        return related ? "Assigned to group" : "Group members";
      case "IfcRelAssignsToGroupByFactor":
        return related ? "Assigned to group" : "Group members";
      case "IfcRelAssignsToProduct":
        return related ? "Assigned to product" : "Assigned objects";
      default:
        return `${formatIfcType(relationship.relationship_type)} ${related ? "from" : "to"}`;
    }
  }
  function formatReferenceTarget(expressId) {
    const numericId = Number(expressId);
    const element = state.elementsById.get(numericId);
    if (element) {
      const name = element.name || formatIfcType(element.ifc_type);
      return name;
    }
    const spatialNode = state.metadata?.references?.spatial_nodes?.[String(numericId)];
    if (spatialNode) return formatSpatialReference(numericId);
    const referenced = state.metadata?.references?.referenced_entities?.[String(numericId)];
    if (referenced) {
      return referenced.name || referenced.object_type || formatIfcType(referenced.ifc_type);
    }
    const port = state.metadata?.references?.port_definitions?.[String(numericId)];
    if (port) return port.name || formatIfcType(port.ifc_type);
    return null;
  }
  function formatMaterialPart(part) {
    const name = part.material_name || part.name || part.profile_name || "Unnamed";
    const category = part.material_category || part.category;
    const thickness = Number(part.thickness);
    const details = [];
    if (category) details.push(category);
    if (Number.isFinite(thickness)) {
      details.push(formatPropertyValue(thickness, "IFCLENGTHMEASURE"));
    }
    return details.length ? `${name} (${details.join(" \xB7 ")})` : name;
  }
  function appendMaterialPartsSection(parent, title, parts) {
    if (!Array.isArray(parts) || !parts.length) return;
    const rows = parts.map((part, index) => [
      parts.length === 1 ? "Name" : `Item ${index + 1}`,
      formatMaterialPart(part)
    ]);
    appendReferenceSet(parent, title, rows);
  }
  function appendSetSection(parent, title, sets, itemKey) {
    if (!Array.isArray(sets) || sets.length === 0) return;
    const outer = document.createElement("details");
    outer.className = "property-group";
    outer.open = true;
    outer.append(node("summary", null, title));
    for (const set of sets) {
      const inner = document.createElement("details");
      inner.className = "property-set";
      inner.open = true;
      inner.append(node("summary", null, set.name || "Unnamed set"));
      const table = node("dl", "property-list");
      for (const item of set[itemKey] || []) {
        addDefinition(
          table,
          item.name,
          formatPropertyValue(item.value, item.value_type, item.kind)
        );
      }
      inner.append(table);
      outer.append(inner);
    }
    parent.append(outer);
  }
  function addDefinition(list, label, value) {
    if (value === null || value === void 0 || value === "") return;
    list.append(node("dt", null, String(label || "Value")));
    list.append(node("dd", null, String(value)));
  }
  function setColor(expressIds, color) {
    const ids = normaliseIds(expressIds);
    const rgba = parseCssColor(color);
    for (const id of ids) {
      if (state.elementsById.has(id)) state.customColors.set(id, rgba.slice());
    }
    refreshElementColors(ids);
    if (state.selectedId !== null && ids.includes(state.selectedId)) {
      renderProperties(state.elementsById.get(state.selectedId));
    }
    invalidate();
  }
  function resetColor(expressIds) {
    const ids = normaliseIds(expressIds);
    for (const id of ids) {
      const element = state.elementsById.get(id);
      if (element) state.customColors.delete(id);
    }
    refreshElementColors(ids);
    if (state.selectedId !== null && ids.includes(state.selectedId)) {
      renderProperties(state.elementsById.get(state.selectedId));
    }
    invalidate();
  }
  function hide(expressIds) {
    const hadModelFocus = Boolean(state.modelFocusIds);
    clearModelFocus();
    const ids = normaliseIds(expressIds);
    ids.forEach((id) => state.hidden.add(id));
    const hidSelection = state.selectedId !== null && ids.includes(state.selectedId);
    if (hidSelection) select(null);
    else if (hadModelFocus) refreshAllColors();
    else refreshElementColors(ids);
    refreshModelTree();
    invalidate();
  }
  function show(expressIds) {
    const ids = normaliseIds(expressIds);
    ids.forEach((id) => state.hidden.delete(id));
    refreshElementColors(ids);
    refreshModelTree();
    invalidate();
  }
  function isolate(expressIds) {
    clearModelFocus();
    const keep = new Set(normaliseIds(expressIds));
    state.hidden.clear();
    for (const id of state.elementsById.keys()) {
      if (!keep.has(id)) state.hidden.add(id);
    }
    refreshAllColors();
    refreshModelTree();
    invalidate();
  }
  function showAll() {
    clearModelFocus();
    state.hidden = new Set(state.defaultHidden);
    refreshAllColors();
    refreshModelTree();
    invalidate();
  }
  function clearModelFocus() {
    if (state.modelFocusIds) setFocusMaterialMode(false);
    state.modelFocusIds = null;
    state.modelFocusKey = null;
    updateFocusOverlay();
  }
  function setFocusMaterialMode(enabled) {
    for (const batch of state.batches.values()) {
      batch.material.transparent = enabled || batch.transparent;
      batch.material.alphaHash = false;
      batch.material.depthWrite = true;
      batch.material.needsUpdate = true;
    }
  }
  function refreshModelTree() {
    if (modelPanel.classList.contains("open"))
      renderModelTree(modelSearch.value);
  }
  function updateFocusOverlay() {
    for (const [batchName, batch] of state.batches) {
      const focus = ensureFocusMesh(batchName, batch);
      const target = focus.geometry.index.array;
      const source = batch.geometry.index.array;
      let cursor = 0;
      if (state.modelFocusIds) {
        for (const element of state.rangesByBatch.get(batchName) || []) {
          if (!state.modelFocusIds.has(element.id)) continue;
          const start = element.triangle_start * 3;
          const end = start + element.triangle_count * 3;
          target.set(source.subarray(start, end), cursor);
          cursor += end - start;
        }
      }
      focus.geometry.setDrawRange(0, cursor);
      focus.mesh.visible = cursor > 0;
      if (cursor > 0) {
        focus.geometry.index.clearUpdateRanges?.();
        focus.geometry.index.addUpdateRange?.(0, cursor);
        focus.geometry.index.needsUpdate = true;
      }
    }
  }
  function ensureFocusMesh(batchName, batch) {
    const existing = state.focusMeshes.get(batchName);
    if (existing) return existing;
    const geometry = new THREE3.BufferGeometry();
    geometry.setAttribute("position", batch.geometry.getAttribute("position"));
    const index = new THREE3.BufferAttribute(
      new Uint32Array(batch.geometry.index.count),
      1
    );
    index.setUsage(THREE3.DynamicDrawUsage);
    geometry.setIndex(index);
    geometry.setDrawRange(0, 0);
    const material = new THREE3.MeshBasicMaterial({
      clippingPlanes,
      color: CONFIG.selectionColor ?? 16758784,
      depthTest: false,
      depthWrite: false,
      side: state.doubleSided ? THREE3.DoubleSide : THREE3.FrontSide,
      toneMapped: false
    });
    const mesh = new THREE3.Mesh(geometry, material);
    mesh.name = `${batchName} IFC focus`;
    mesh.renderOrder = 9;
    mesh.visible = false;
    focusGroup.add(mesh);
    const focus = { geometry, material, mesh };
    state.focusMeshes.set(batchName, focus);
    return focus;
  }
  function updateSelectionOverlay() {
    for (const child of [...selectionGroup.children]) {
      selectionGroup.remove(child);
      child.geometry?.dispose();
      child.material?.dispose();
    }
    if (state.selectedId === null) return;
    const geometry = getElementGeometry(state.selectedId);
    if (!geometry) return;
    const fill = new THREE3.Mesh(
      geometry,
      new THREE3.MeshBasicMaterial({
        clippingPlanes,
        color: CONFIG.selectionColor ?? 16765774,
        transparent: true,
        opacity: 0.16,
        depthTest: true,
        depthFunc: THREE3.LessEqualDepth,
        depthWrite: false,
        side: THREE3.FrontSide
      })
    );
    fill.renderOrder = 10;
    selectionGroup.add(fill);
    const outline = new THREE3.LineSegments(
      new THREE3.EdgesGeometry(geometry, 35),
      new THREE3.LineBasicMaterial({
        clippingPlanes,
        color: CONFIG.selectionColor ?? 16758528,
        depthTest: false,
        depthWrite: false,
        linewidth: 2,
        toneMapped: false
      })
    );
    outline.renderOrder = 11;
    selectionGroup.add(outline);
  }
  function refreshAllColors() {
    refreshElementColors([...state.elementsById.keys()]);
  }
  function refreshElementColors(expressIds) {
    const dirty = /* @__PURE__ */ new Map();
    for (const id of new Set(expressIds.map(Number))) {
      const element = state.elementsById.get(id);
      if (!element) continue;
      for (const range of elementRanges(element)) {
        const batch = state.batches.get(range.batch);
        if (!batch) continue;
        const attribute = batch.geometry.getAttribute("color");
        const array = attribute.array;
        const custom = state.customColors.get(id);
        const componentStart = range.vertex_start * 4;
        const componentEnd = componentStart + range.vertex_count * 4;
        for (let index = componentStart; index < componentEnd; index += 4) {
          for (let channel = 0; channel < 4; channel++) array[index + channel] = custom?.[channel] ?? batch.baseColors[index + channel];
          if (state.hidden.has(id) || state.modelFocusIds?.has(id)) array[index + 3] = 0;
          else if (state.modelFocusIds) array[index + 3] = Math.min(array[index + 3], 18);
        }
        const changed = dirty.get(range.batch) || { start: componentStart, end: componentEnd };
        changed.start = Math.min(changed.start, componentStart);
        changed.end = Math.max(changed.end, componentEnd);
        dirty.set(range.batch, changed);
        const renderMesh = batch.renderMeshes?.get(id);
        if (renderMesh) renderMesh.geometry.getAttribute("color").needsUpdate = true;
      }
    }
    for (const [batchName, range] of dirty) {
      const attribute = state.batches.get(batchName).geometry.getAttribute("color");
      attribute.addUpdateRange?.(range.start, range.end - range.start);
      attribute.needsUpdate = true;
    }
  }
  function fitModel() {
    const bbox = state.metadata?.model?.local_bbox;
    if (!Array.isArray(bbox) || bbox.length !== 6) return;
    fitBox(
      new THREE3.Box3(
        new THREE3.Vector3(bbox[0], bbox[1], bbox[2]),
        new THREE3.Vector3(bbox[3], bbox[4], bbox[5])
      )
    );
  }
  function fitSelection() {
    if (state.selectedId === null) {
      fitModel();
      return;
    }
    const element = state.elementsById.get(state.selectedId);
    if (!element?.bbox || element.bbox.length !== 6) return;
    fitBox(
      new THREE3.Box3(
        new THREE3.Vector3(element.bbox[0], element.bbox[1], element.bbox[2]),
        new THREE3.Vector3(element.bbox[3], element.bbox[4], element.bbox[5])
      ),
      1.8
    );
  }
  function fitBox(box, padding = 1.35) {
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE3.Vector3());
    const center = box.getCenter(new THREE3.Vector3());
    const radius = Math.max(size.length() * 0.5, 0.1);
    const vertical = THREE3.MathUtils.degToRad(camera.fov);
    const fov = Math.min(
      vertical,
      2 * Math.atan(Math.tan(vertical / 2) * camera.aspect)
    );
    const distance = radius / Math.sin(fov * 0.5) * padding;
    const direction = new THREE3.Vector3(1, -1.25, 0.85).normalize();
    camera.position.copy(center).addScaledVector(direction, distance);
    controls.target.copy(center);
    controls.update();
    updateCameraClipping();
    invalidate();
  }
  function buildGrid() {
    const bbox = state.metadata?.model?.local_bbox;
    if (!Array.isArray(bbox) || bbox.length !== 6) return;
    const width = Math.max(bbox[3] - bbox[0], bbox[4] - bbox[1], 1);
    const gridSize = niceGridSize(width * 1.5);
    grid = new THREE3.GridHelper(gridSize, 40, 6122363, 3160390);
    grid.rotation.x = Math.PI / 2;
    grid.position.set(
      (bbox[0] + bbox[3]) / 2,
      (bbox[1] + bbox[4]) / 2,
      bbox[2] - gridSize * 1e-3
    );
    grid.material.transparent = true;
    grid.material.opacity = 0.28;
    grid.material.depthWrite = false;
    scene.add(grid);
  }
  function toggleGrid() {
    state.gridVisible = !state.gridVisible;
    if (grid) grid.visible = state.gridVisible;
    setActionPressed("toggle-grid", state.gridVisible);
    invalidate();
  }
  function setDoubleSided(enabled) {
    state.doubleSided = Boolean(enabled);
    for (const { material, depthMaterial } of state.batches.values()) {
      material.side = state.doubleSided ? THREE3.DoubleSide : THREE3.FrontSide;
      material.needsUpdate = true;
      if (depthMaterial) {
        depthMaterial.side = material.side;
        depthMaterial.needsUpdate = true;
      }
    }
    for (const { material } of state.focusMeshes.values()) {
      material.side = state.doubleSided ? THREE3.DoubleSide : THREE3.FrontSide;
      material.needsUpdate = true;
    }
    setActionPressed("toggle-double-side", state.doubleSided);
    invalidate();
  }
  function toggleDoubleSided() {
    setDoubleSided(!state.doubleSided);
  }
  function togglePanel() {
    const open = panel.classList.toggle("open");
    if (!open) releasePanelFocus(panel);
    panel.setAttribute("aria-hidden", String(!open));
    if (open) {
      releasePanelFocus(modelPanel);
      modelPanel.classList.remove("open");
      modelPanel.setAttribute("aria-hidden", "true");
      setActionPressed("toggle-model", false);
    }
    setActionPressed("toggle-panel", open);
  }
  function toggleModelPanel() {
    const open = modelPanel.classList.toggle("open");
    if (!open) releasePanelFocus(modelPanel);
    modelPanel.setAttribute("aria-hidden", String(!open));
    if (open) {
      releasePanelFocus(panel);
      panel.classList.remove("open");
      panel.setAttribute("aria-hidden", "true");
      setActionPressed("toggle-panel", false);
      renderModelTree(modelSearch.value);
      modelSearch.focus();
    } else {
      showAll();
    }
    setActionPressed("toggle-model", open);
  }
  function releasePanelFocus(activePanel) {
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && activePanel.contains(focused))
      focused.blur();
  }
  function openContextMenu(event) {
    if (event.defaultPrevented) return;
    event.preventDefault();
    const selected = pick(event.clientX, event.clientY);
    for (const button of contextMenu.querySelectorAll(
      "[data-context-action]"
    )) {
      button.disabled = !selected && button.dataset.contextAction !== "show-all";
    }
    contextMenu.hidden = false;
    const rootBounds = root2.getBoundingClientRect();
    const inset = 8;
    const left = event.clientX - rootBounds.left;
    const top = event.clientY - rootBounds.top;
    const maxLeft = root2.clientWidth - contextMenu.offsetWidth - inset;
    const maxTop = root2.clientHeight - contextMenu.offsetHeight - inset;
    contextMenu.style.left = `${Math.max(inset, Math.min(maxLeft, left))}px`;
    contextMenu.style.top = `${Math.max(inset, Math.min(maxTop, top))}px`;
  }
  function closeContextMenu() {
    contextMenu.hidden = true;
  }
  function runContextAction(action) {
    const selectedId = state.selectedId;
    closeContextMenu();
    switch (action) {
      case "show-properties":
        if (selectedId !== null) {
          modelPanel.classList.remove("open");
          modelPanel.setAttribute("aria-hidden", "true");
          setActionPressed("toggle-model", false);
          panel.classList.add("open");
          panel.setAttribute("aria-hidden", "false");
          setActionPressed("toggle-panel", true);
        }
        break;
      case "isolate":
        if (selectedId !== null) isolate(selectedId);
        break;
      case "hide-selected":
        if (selectedId !== null) hide(selectedId);
        break;
      case "show-all":
        showAll();
        break;
      default:
        break;
    }
  }
  function setActionPressed(action, pressed) {
    root2.querySelector(`[data-action="${action}"]`)?.setAttribute("aria-pressed", String(pressed));
  }
  function runAction(action) {
    switch (action) {
      case "fit":
        fitModel();
        break;
      case "fit-selection":
        fitSelection();
        break;
      case "toggle-grid":
        toggleGrid();
        break;
      case "show-all":
        showAll();
        break;
      case "toggle-panel":
        togglePanel();
        break;
      case "toggle-model":
        toggleModelPanel();
        break;
      case "toggle-double-side":
        toggleDoubleSided();
        break;
      default:
        break;
    }
  }
  function createPublicApi() {
    const find = (query = {}) => {
      if (typeof query === "string") query = { text: query };
      const types = query.ifcType ? new Set(
        (Array.isArray(query.ifcType) ? query.ifcType : [query.ifcType]).map((value) => String(value).toLocaleLowerCase())
      ) : null;
      const text = String(query.text || "").trim().toLocaleLowerCase();
      const visibleOnly = Boolean(query.visibleOnly);
      const result = [];
      for (const element of state.elementsById.values()) {
        if (types && !types.has(String(element.ifc_type || "").toLocaleLowerCase()))
          continue;
        if (visibleOnly && state.hidden.has(element.id)) continue;
        if (text) {
          const haystack = [
            element.id,
            element.ifc_type,
            element.name,
            element.global_id,
            element.object_type,
            element.description
          ].filter((value) => value !== null && value !== void 0).join(" ").toLocaleLowerCase();
          if (!haystack.includes(text)) continue;
        }
        result.push(element.id);
      }
      return result;
    };
    const setColorByType = (ifcType, color) => {
      const ids = find({ ifcType });
      setColor(ids, color);
      return ids;
    };
    return Object.freeze({
      scene,
      camera,
      renderer,
      controls,
      modelGroup,
      overlays,
      invalidate,
      events,
      on: (type, listener) => {
        const handler = (event) => listener(event.detail);
        events.addEventListener(type, handler);
        return () => events.removeEventListener(type, handler);
      },
      loadPrepared,
      clear: () => {
        ++loadVersion;
        clearModel();
        emit("clear", null);
      },
      dispose,
      fitBounds: fitBox,
      hitTest,
      setClippingPlanes,
      isPointVisible,
      getElementGeometry,
      setGrid: (visible, level = null) => {
        state.gridVisible = visible;
        if (grid) {
          grid.visible = visible;
          if (level !== null) grid.position.z = level;
        }
        invalidate();
      },
      setShading: (flat) => {
        state.flatShading = flat;
        for (const { material } of state.batches.values()) {
          material.flatShading = flat;
          material.needsUpdate = true;
        }
        invalidate();
      },
      select,
      setColor,
      setColorByType,
      resetColor,
      hide,
      show,
      isolate,
      showAll,
      fit: fitModel,
      fitSelection,
      setDoubleSided,
      getSelected: () => state.selectedId,
      getElement: (id) => structuredClone(state.elementsById.get(Number(id)) || null),
      getModelData: () => structuredClone(state.metadata),
      getReferences: (id) => structuredClone(
        state.metadata?.references?.elements?.[String(Number(id))] || null
      ),
      find,
      getModelInfo: () => structuredClone(state.metadata?.model || {}),
      getElementIds: () => [...state.elementsById.keys()],
      isVisible: (id) => state.elementsById.has(Number(id)) && !state.hidden.has(Number(id))
    });
  }
  function startPanelDrag(event) {
    if (event.button !== 0 || event.target.closest("button") || matchMedia("(max-width: 720px)").matches)
      return;
    const activePanel = event.currentTarget.closest(".viewer-panel");
    const bounds = activePanel.getBoundingClientRect();
    activePanel.style.left = `${bounds.left}px`;
    activePanel.style.top = `${bounds.top}px`;
    activePanel.style.right = "auto";
    activePanel.style.bottom = "auto";
    panelDrag = {
      panel: activePanel,
      header: event.currentTarget,
      pointerId: event.pointerId,
      offsetX: event.clientX - bounds.left,
      offsetY: event.clientY - bounds.top
    };
    panelDrag.header.setPointerCapture(event.pointerId);
    activePanel.classList.add("dragging");
    event.preventDefault();
  }
  function movePanelDrag(event) {
    if (!panelDrag || event.pointerId !== panelDrag.pointerId) return;
    positionPanel(
      panelDrag.panel,
      event.clientX - panelDrag.offsetX,
      event.clientY - panelDrag.offsetY
    );
  }
  function endPanelDrag(event) {
    if (!panelDrag || event.pointerId !== panelDrag.pointerId) return;
    const { panel: activePanel, header, pointerId } = panelDrag;
    panelDrag = null;
    activePanel.classList.remove("dragging");
    if (header.hasPointerCapture(pointerId))
      header.releasePointerCapture(pointerId);
  }
  function positionPanel(activePanel, left, top) {
    const inset = 10;
    const maxLeft = Math.max(
      inset,
      root2.clientWidth - activePanel.offsetWidth - inset
    );
    const maxTop = Math.max(
      inset,
      root2.clientHeight - activePanel.offsetHeight - inset
    );
    activePanel.style.left = `${Math.min(maxLeft, Math.max(inset, left))}px`;
    activePanel.style.top = `${Math.min(maxTop, Math.max(inset, top))}px`;
  }
  function resetPanelPosition(event) {
    if (matchMedia("(max-width: 720px)").matches) return;
    const activePanel = event.currentTarget.closest(".viewer-panel");
    activePanel.style.removeProperty("left");
    activePanel.style.removeProperty("top");
    activePanel.style.removeProperty("right");
    activePanel.style.removeProperty("bottom");
  }
  function keepPanelsInViewport() {
    if (matchMedia("(max-width: 720px)").matches) return;
    for (const activePanel of root2.querySelectorAll(
      ".viewer-panel"
    )) {
      if (activePanel.style.left) {
        positionPanel(
          activePanel,
          Number.parseFloat(activePanel.style.left),
          Number.parseFloat(activePanel.style.top)
        );
      }
    }
  }
  function resize() {
    const width = Math.max(root2.clientWidth, 1);
    const height = Math.max(root2.clientHeight, 1);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    keepPanelsInViewport();
    invalidate();
  }
  function invalidate() {
    if (renderQueued || disposed) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      updateCameraClipping();
      if (!disposed) {
        renderer.render(scene, camera);
        emit("render", null);
      }
    });
  }
  function updateCameraClipping() {
    let bbox = state.metadata?.model?.local_bbox;
    if (!Array.isArray(bbox) || bbox.length !== 6) return;
    const bounds = new THREE3.Box3(
      new THREE3.Vector3(...bbox.slice(0, 3)),
      new THREE3.Vector3(...bbox.slice(3, 6))
    );
    for (const child of scene.children)
      if (child.visible && child instanceof THREE3.Group && child !== modelGroup && child !== selectionGroup && child !== focusGroup)
        bounds.expandByObject(child);
    bbox = [...bounds.min.toArray(), ...bounds.max.toArray()];
    const { near, far } = modelClipping(camera.position.toArray(), controls.target.toArray(), bbox);
    if (Math.abs(camera.near - near) < near * 0.01 && Math.abs(camera.far - far) < far * 0.01) {
      return;
    }
    camera.near = near;
    camera.far = far;
    camera.updateProjectionMatrix();
  }
  function setStatus(text, warning = false) {
    statusNode.textContent = text;
    statusNode.classList.toggle("warning", warning);
    statusNode.classList.add("visible");
    clearTimeout(statusTimer);
    statusTimer = setTimeout(
      () => statusNode.classList.remove("visible"),
      warning ? 8e3 : 3500
    );
  }
  function base64ToBytes(text) {
    const chunkLength = 32768;
    const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
    const bytes = new Uint8Array(text.length * 3 / 4 - padding);
    let outputOffset = 0;
    for (let start = 0; start < text.length; start += chunkLength) {
      const binary = atob(text.slice(start, start + chunkLength));
      for (let index = 0; index < binary.length; index += 1) {
        bytes[outputOffset++] = binary.charCodeAt(index);
      }
    }
    return bytes;
  }
  function parseCssColor(value) {
    if (Array.isArray(value) || ArrayBuffer.isView(value)) {
      const result = Array.from(value).slice(0, 4).map(Number);
      if (result.length !== 3 && result.length !== 4) {
        throw new Error("A color array must contain three or four channels.");
      }
      if (!result.every(Number.isFinite)) {
        throw new Error("Color channels must be finite numbers.");
      }
      const normalized = result.slice(0, 3).every((channel) => channel >= 0 && channel <= 1);
      const alphaNormalized = result.length === 4 && result[3] >= 0 && result[3] <= 1;
      for (let index = 0; index < 3; index += 1) {
        if (normalized) result[index] *= 255;
      }
      if (result.length === 3) result.push(255);
      else if (alphaNormalized) result[3] *= 255;
      return result.map(
        (channel) => Math.max(0, Math.min(255, Math.round(channel)))
      );
    }
    const text = String(value).trim();
    if (/^#[0-9a-f]{3,8}$/i.test(text)) {
      let hex = text.slice(1);
      if (hex.length === 3 || hex.length === 4)
        hex = [...hex].map((part) => part + part).join("");
      if (hex.length === 6) hex += "ff";
      if (hex.length === 8)
        return [0, 2, 4, 6].map(
          (start) => parseInt(hex.slice(start, start + 2), 16)
        );
    }
    const color = new THREE3.Color(text);
    return [
      Math.round(color.r * 255),
      Math.round(color.g * 255),
      Math.round(color.b * 255),
      255
    ];
  }
  function normaliseIds(value) {
    if (value == null) return [];
    if (typeof value === "number" || typeof value === "string")
      return [Number(value)];
    return [...value].map(Number).filter(Number.isFinite);
  }
  function requiredElement(id) {
    const element = root2.querySelector(`[id="${id}"]`);
    if (!element) throw new Error(`Missing viewer element #${id}.`);
    return element;
  }
  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== void 0 && text !== null) element.textContent = String(text);
    return element;
  }
  function formatPropertyValue(value, valueType = null, quantityKind = null) {
    if (value === null || value === void 0) return "\u2014";
    const normalizedType = String(valueType || "").toUpperCase();
    const normalizedKind = String(quantityKind || "").toUpperCase();
    const isNumeric = typeof value === "number" || NUMERIC_VALUE_TYPES.has(normalizedType) || INTEGER_VALUE_TYPES.has(normalizedType) || QUANTITY_UNIT_TYPES.has(normalizedKind) || normalizedKind === "COUNT";
    if (!isNumeric) return String(value);
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return String(value);
    const integer = INTEGER_VALUE_TYPES.has(normalizedType) || normalizedKind === "COUNT";
    const formatted = integer ? formatInteger(numeric) : formatNumber(numeric);
    const unitType = MEASURE_UNIT_TYPES.get(normalizedType) || QUANTITY_UNIT_TYPES.get(normalizedKind);
    const symbol = unitType ? state.metadata?.model?.display_units?.[unitType] : null;
    if (!symbol) return formatted;
    const separator = symbol === "\xB0" || symbol === "%" ? "" : " ";
    return `${formatted}${separator}${symbol}`;
  }
  function formatNumber(value) {
    const numeric = Number(value);
    if (numeric !== 0 && Math.abs(numeric) < 1e-3) {
      return new Intl.NumberFormat(void 0, {
        maximumSignificantDigits: 3
      }).format(numeric);
    }
    return new Intl.NumberFormat(void 0, {
      maximumFractionDigits: 3
    }).format(numeric);
  }
  function formatInteger(value) {
    return new Intl.NumberFormat(void 0, {
      maximumFractionDigits: 0
    }).format(Number(value) || 0);
  }
  function niceGridSize(value) {
    const exponent = Math.floor(Math.log10(value));
    const fraction = value / 10 ** exponent;
    const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
    return nice * 10 ** exponent;
  }
  function float32View(buffer, section) {
    return section.length ? new Float32Array(buffer, section.offset, section.length / 4) : new Float32Array();
  }
  function uint32View(buffer, section) {
    return section.length ? new Uint32Array(buffer, section.offset, section.length / 4) : new Uint32Array();
  }
  function uint8View(buffer, section) {
    return section.length ? new Uint8Array(buffer, section.offset, section.length) : new Uint8Array();
  }
  function align4(value) {
    return value + 3 & ~3;
  }
  function nextFrame() {
    return new Promise((resolve) => requestAnimationFrame(resolve));
  }
  function getElementGeometry(id) {
    const element = state.elementsById.get(Number(id));
    if (!element) return null;
    const ranges = elementRanges(element);
    const positions = new Float32Array(ranges.reduce((sum, range) => sum + range.vertex_count * 3, 0));
    const indices = new Uint32Array(ranges.reduce((sum, range) => sum + range.triangle_count * 3, 0));
    let vertex = 0, triangle = 0;
    for (const range of ranges) {
      const batch = state.batches.get(range.batch);
      if (!batch) return null;
      positions.set(batch.geometry.getAttribute("position").array.subarray(range.vertex_start * 3, (range.vertex_start + range.vertex_count) * 3), vertex * 3);
      const source = batch.geometry.index.array.subarray(range.triangle_start * 3, (range.triangle_start + range.triangle_count) * 3);
      for (const index of source) indices[triangle++] = index - range.vertex_start + vertex;
      vertex += range.vertex_count;
    }
    const geometry = new THREE3.BufferGeometry();
    geometry.setAttribute("position", new THREE3.BufferAttribute(positions, 3));
    geometry.setIndex(new THREE3.BufferAttribute(indices, 1));
    return geometry;
  }
  function isPointVisible(point) {
    return clippingPlanes.every((plane) => plane.distanceToPoint(point) >= -1e-7);
  }
  function setClippingPlanes(planes) {
    if (planes.some((plane) => ![...plane.normal, plane.constant].every(Number.isFinite) || plane.normal.lengthSq() < 1e-12))
      throw new Error("Use finite clipping planes with nonzero normals.");
    clippingPlanes = planes.map((plane) => plane.clone().normalize());
    const materials = /* @__PURE__ */ new Set();
    for (const group of [modelGroup, selectionGroup, focusGroup]) group.traverse((object) => {
      const material = object.material;
      for (const item of Array.isArray(material) ? material : material ? [material] : []) materials.add(item);
    });
    for (const material of materials) {
      const previousCount = material.clippingPlanes?.length ?? 0;
      material.clippingPlanes = clippingPlanes;
      if (previousCount !== clippingPlanes.length) material.needsUpdate = true;
    }
    invalidate();
  }
  function hitTest(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    pointer.set(
      (clientX - rect.left) / rect.width * 2 - 1,
      -(clientY - rect.top) / rect.height * 2 + 1
    );
    raycaster.setFromCamera(pointer, camera);
    raycaster.firstHitOnly = false;
    for (const hit of raycaster.intersectObjects(
      [...state.batches.values()].map((batch) => batch.mesh),
      false
    )) {
      const element = elementForTriangle(
        hit.object.userData.batchName,
        hit.faceIndex
      );
      if (element && !state.hidden.has(element.id) && isPointVisible(hit.point))
        return {
          element: structuredClone(element),
          point: hit.point,
          distance: hit.distance,
          vertices: hit.face ? [hit.face.a, hit.face.b, hit.face.c].map((index) => new THREE3.Vector3().fromBufferAttribute(hit.object.geometry.getAttribute("position"), index).applyMatrix4(hit.object.matrixWorld)) : []
        };
    }
    return null;
  }
  function clearModel() {
    clippingPlanes = [];
    for (const group of [modelGroup, selectionGroup, focusGroup]) {
      for (const child of [...group.children]) {
        group.remove(child);
        disposeObject(child);
      }
    }
    for (const batch of state.batches.values()) {
      batch.material.dispose();
      batch.depthMaterial?.dispose();
    }
    if (grid) {
      scene.remove(grid);
      disposeObject(grid);
      grid = null;
    }
    state.metadata = null;
    state.selectedId = null;
    state.selectionReady = false;
    for (const map of [
      state.batches,
      state.elementsById,
      state.rangesByBatch,
      state.customColors,
      state.focusMeshes
    ])
      map.clear();
    for (const set of [
      state.hidden,
      state.defaultHidden,
      state.modelOpenTypes,
      state.modelClosedGroups
    ])
      set.clear();
    state.modelFocusIds = null;
    state.modelFocusKey = null;
    panelContent.replaceChildren(
      node("p", "panel-empty", "Click an element in the model to inspect it.")
    );
    renderModelTree();
    invalidate();
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    ++loadVersion;
    lifetime.abort();
    stopNavigation();
    resizeObserver.disconnect();
    clearTimeout(statusTimer);
    clearModel();
    overlays.dispose();
    controls.dispose();
    renderer.dispose();
    emit("dispose", null);
    root2.remove();
  }
  const overlays = new OverlayScenes(scene, invalidate);
  const api = createPublicApi();
  const stopNavigation = attachCursorNavigation(api);
  resize();
  return api;
}

// ../src/ifx/static/viewer.ts
var config = globalThis.__IFX_VIEWER_CONFIG__;
if (!config?.payload) throw new Error("IFX viewer configuration is missing.");
var root = document.getElementById("ifx-root");
var viewer = createRuntime(root, config);
globalThis.IFXViewer = viewer;
viewer.on(
  "select",
  (detail) => globalThis.dispatchEvent(new CustomEvent("ifx:select", { detail }))
);
var spec = config.payload;
var compressed = spec.mode === "url" ? new Uint8Array(await (await fetch(spec.url)).arrayBuffer()) : Uint8Array.from(
  atob(document.getElementById(spec.elementId).textContent.trim()),
  (char) => char.charCodeAt(0)
);
try {
  await viewer.loadPrepared(compressed);
  globalThis.dispatchEvent(
    new CustomEvent("ifx:ready", { detail: { viewer } })
  );
} catch (error) {
  root.querySelector('[role="status"]').textContent = String(error);
  throw error;
}
