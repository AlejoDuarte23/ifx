# IFX viewer TypeScript API

The npm package is named `ifx-viewer`. The source is in [AlejoDuarte23/ifx](https://github.com/AlejoDuarte23/ifx), under `frontend/`.

IFX uses its own Three.js renderer. `ifx-core` supplies geometry and IFC data through WASM. Raw IFC loading runs in a Web Worker by default. Python-prepared payloads use the same renderer and do not need WASM in the page.

```ts
import {createViewer} from "ifx-viewer";
import * as THREE from "three";

const viewer = createViewer(document.getElementById("viewer")!, {
  tessellationQuality: "high",
  ui: false,
});
const data = await viewer.load(file);
console.log(data.model.units, data.model.materials);

const marker = new THREE.Mesh(
  new THREE.SphereGeometry(1),
  new THREE.MeshBasicMaterial({color: "red"}),
);
viewer.overlays.addMesh(marker, "markers");
const stop = viewer.on("select", element => {
  myPanel.textContent = element?.name ?? "";
});
```

Give the container a width and height. The standard UI is inside a shadow root. Put app panels beside or over the container. Use one compatible Three.js package for app and viewer geometry.

## Public API

| API | Use |
| --- | --- |
| `load(file)` | Read a Blob, Uint8Array, or ArrayBuffer with WASM |
| `loadPrepared(payload)` | Load a Python gzip payload or `prepareModel(data)` result |
| `scene`, `camera`, `renderer`, `controls`, `modelGroup` | Use the Three.js objects |
| `invalidate()` | Request a frame after a direct scene change |
| `overlays.addScene(name)` | Get or create a named Three.js group |
| `overlays.addMesh(mesh, name)`, `addObject(object, name)` | Add custom geometry |
| `overlays.hasScene(name)`, `setVisible(name, visible)` | Check or show a layer |
| `overlays.removeMesh(object, name, dispose?)` | Detach an object |
| `overlays.clearScene(name, dispose?)`, `removeScene(name, dispose?)` | Clear or remove a layer |
| `getElement(id)`, `getElementIds()`, `getReferences(id)` | Read model data |
| `getModelInfo()`, `getModelData()`, `data` | Read metadata; `data` contains the last WASM result |
| `getElementGeometry(id)` | Get a new local-coordinate BufferGeometry; caller disposes it |
| `select(id)`, `getSelected()`, `find(query)` | Select and search elements |
| `setColor(ids, color)`, `setColorByType(type, color)`, `resetColor(ids)` | Set display colors |
| `hide(ids)`, `show(ids)`, `isolate(ids)`, `showAll()` | Set visibility |
| `fit()`, `fitSelection()`, `fitBounds(box)` | Set the view |
| `hitTest(clientX, clientY)` | Get the visible IFC element under a pointer |
| `toLocal(vector)`, `toWorld(vector)` | Convert viewer and IFC world coordinates |
| `on("select"/"ready"/"dispose", callback)` | Subscribe; returns an unsubscribe function |
| `clear()`, `dispose()` | Clear IFC or release the viewer |

Overlay removal preserves app resources unless `dispose=true`. Viewer disposal releases all remaining overlay geometry and materials. Remove an overlay first if another viewer still uses those resources. `clear()` leaves overlays in place.

Worker callers can supply `PreparedModel.selectionIndices` for the opaque and
transparent batches. Build each tree from the matching position and index
buffers with `indirect: true`, then use `MeshBVH.serialize`. The viewer restores
these trees without rebuilding them. Loads without prepared trees retain the
existing selection setup.

Set `copyPreparedMetadata: false` only when the caller gives the viewer ownership
of prepared metadata, such as a result already copied from a worker. The default
keeps a separate copy for callers that share prepared data.

IFC and LandXML world coordinates must be in the same frame. Core geometry is already in world metres with Z up. Viewer meshes subtract `getModelInfo().world_origin` once to preserve Float32 precision. Use `toLocal` for world-space custom objects. Colors do not change IFC properties.

`extractIfc(bytes)` is also available without a viewer. The result separates `geometry`, `entities`, and semantic `model` data. Property and quantity values keep their source units. IFC2X3, IFC4 and IFC4X3 STEP files are supported. IFCZIP is not supported in this path.

## Build

Build `../ifx-core/pkg` with the core's `scripts/build-wasm.sh`, then run `npm ci` and `npm run build` here. `IFX_CORE_SOURCE` can select a different source folder. Serve the `dist/` folder with its `core.worker.js` and `wasm/` assets. A custom WASM URL can be passed as `wasmUrl`. For an environment without Worker support, set `useWorker: false`.

`examples/viewer.html` is a local API demo. Serve the repository over HTTP, select an IFC file, and click **Add sphere**. `npm pack` includes the WASM license, notices, and the matching source archive.
## Connected volumes

`ConnectedVolumes` is an optional scene component. It joins elements by triangle
contact or closed-solid containment, including contact chains. Bounds only reduce
the search. `tolerance` uses the prepared model's geometry units (metres for IFC).

```ts
import { ConnectedVolumes } from "ifx-viewer";

const connected = new ConnectedVolumes(viewer);
const volumes = connected.find({ elementIds: foundationIds, tolerance: 0.001 });
connected.show(volumes);             // One color for each connected volume.
connected.setVisible(false);         // Keep the original model materials.
const ids = connected.connectedTo(selectedId);
connected.dispose();
```

Call `find` after loading a model. A new model clears the component. The component
uses the viewer's public geometry and overlay APIs and releases its overlay on
disposal. Open meshes can establish surface contact, but they cannot prove solid
containment. Excavation rules and quantities belong to the application.


## World axes and measurements

These optional controls use the public viewer API and work with `ui: false`.
Use an 88 px square for the axes host. The measurements host is the positioned
viewer container; the control adds its own full-size, passive SVG layer.

```ts
import { WorldAxes, Measurements } from "ifx-viewer";

const axes = new WorldAxes(viewer, axesHost);
const dimensions = new Measurements(viewer, viewerContainer);
const stop = dimensions.subscribe(state => updateMeasurementPanel(state));
dimensions.setActive(true);
dimensions.setReference("length"); // length, x, y, z
dimensions.setPlane("auto");       // view plane, xy, xz, yz
dimensions.setMode("single");      // single or chain
// Pick two points, then click to place the dimension. Drag to orbit.
const record = dimensions.add([1000, 2000, 0], [1003, 2004, 0]);
stop();
dimensions.dispose();
axes.dispose();
```

The axes follow the camera. X is muted red, Y is green and Z is blue. Z is IFC
elevation. There is no cube. Drafting dimensions have inward arrows, separated
extension lines, an upright value and a gap in the dimension line. Marks keep
the same pixel size at each zoom level.

Corner snapping searches the nearby element geometry within 14 CSS pixels,
including corners outside the current hit triangle and near the silhouette.
It rejects hidden and occluded vertices. A ring shows a corner snap. Without
a corner, it uses the visible surface point. Vertex data is cached for at most
32 nearby elements and is released on clear, replacement and disposal.

Stored points and values use world metres. The renderer applies the local
origin once. X/Y/Z references show an absolute axis difference. Placement planes
control the offset, not the chosen points. The offset stays in that plane and
perpendicular to the selected distance or axis. Chain mode adds bays and an overall
first-to-last dimension. Escape or `cancelPending()` starts a new chain.
`list()`, `remove(id)`, `clear()` and `setVisible(false)` manage the records.
Turning drawing mode off keeps completed dimensions. Clear, replacement and
disposal release the records, SVG nodes, caches and listeners.

## Mesh rendering and navigation

The shared runtime uses the Sacyr fixes. Flat shading keeps planar faces flat
and prevents false rounded corners from averaged vertex normals. It uses a light
hemisphere ground and a softer directional light. Geometry, picking and model
quantities are unchanged. `setShading(false)` can enable smooth shading; this
setting also applies to later model loads.

Wheel and trackpad zoom use the visible surface under the pointer. Empty space
uses the current view plane. The orbit target moves with the camera, so zoom does
not stop at the old target. Near clipping adapts to close views. Far clipping
includes the whole model and visible overlay groups. Double-click keeps the view;
use Fit to frame it. `isVisible(id)` reads the same state as show/hide and picking.

The exported pure `cursorZoom`, `wheelZoomScale` and `modelClipping` helpers have
regression tests for close views and off-centre targets.

## Section planes

`SectionPlanes` is an optional component. It works with the standard viewer or
with `ui: false`. Use its state subscription to connect your own controls.

```ts
import { SectionPlanes } from "ifx-viewer";

const sections = new SectionPlanes(viewer);
const stop = sections.subscribe(state => updateSectionPanel(state));
sections.setAxis("x");           // Cut through the center of the model.
sections.setPosition(0.65);       // Position within the projected model bounds, 0–1.
sections.rotate("z", 5);          // Rotate the normal by 5 degrees about local Z.
sections.setNormal([1, 1, 0]);    // Set a finite, nonzero local normal.
sections.setActive(false);       // Turn the cut off; keep its settings.
sections.setActive(true);        // Restore the same cut.
sections.setVisible(false);      // Hide the plane and handles; keep the cut.
sections.clear();                // Remove the cut.
stop();
sections.dispose();
```

X, Y, and Z refer to the IFC axes. Z is elevation. The component uses local
model bounds, so large IFC world origins do not reduce precision. Drag the
normal arrow to move the plane. Drag either colored arc to rotate it. Pointer
capture blocks orbit and selection during a drag. Canceling a drag restores
the prior navigation state. An application can also use the methods above for
keyboard and touch controls.

The component owns the viewer's clipping planes. Use one section component per
viewer. Model replacement and Clear remove the cut. Disposal releases the
plane, handles, pointer listeners, and viewer subscriptions. The runtime APIs
`setClippingPlanes(planes)` and `isPointVisible(localPoint)` also support custom
clipping tools. Model fills, transparency depth passes, selection outlines,
picking, cursor zoom, and corner snapping use the same clipping planes. App
overlays and grids remain outside the cut.

### Pick a plane from points

```ts
sections.beginPick("three");    // Pick three model points; corners snap.
sections.beginPick("vertical"); // Pick two points for a vertical plane.
sections.cancelPick();          // Restore the prior plane, or press Escape.
sections.setFromPoints([a, b, c], "three"); // World coordinates in metres.
```

Three distinct, noncollinear points define a general plane. Two points define
one plane only with an extra direction: `vertical` fixes IFC Z as the vertical
direction. The two points must have different X or Y coordinates. Invalid
points leave the previous plane unchanged and let the user choose again.

Rotation holds the grabbed axis and pivot for the whole drag. The full handle
orientation is retained. Short curved controls pass through the grab point.
The screen tangent is fixed at the start of each drag. This keeps the angle
continuous when an arc is seen edge-on. Escape or pointer
cancellation restores the pose from before the drag. The point-pick state is
available through `active`, `picking`, `picked`, and `notice` in the subscription.

### Structured properties and load reports

`flattenProperties()` makes nested names such as `Dimensions.Height` available
for display. `propertySearchValues()` returns both the display value and the
individual values in lists, enumerations, bounds, and tables.
`inspectMaterialProperties()` follows resolved material assignments, layers,
constituents, material lists, and material profiles. It returns material and
profile property sets once per element. IFC2X3 typed resource properties retain
their original field names and source units.

`inspectCoverage()` returns record/class counts and extraction checks. Unknown
classes, duplicate IDs, unread property values, objects without metadata, and
represented objects without meshes remain visible. Some representations contain
only 2D or reference geometry. The report does not certify complete surface
accuracy. New nested reads have explicit depth, node, and value limits; an `issue`
field identifies an incomplete value.
