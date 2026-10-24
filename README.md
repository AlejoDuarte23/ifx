# IFX

The public source repositories are [ifx](https://github.com/AlejoDuarte23/ifx) and [ifx-core](https://github.com/AlejoDuarte23/ifx-core). The Python packages are `ifx` and `ifx-core`. The JavaScript ES module package is `ifx-viewer`.

A Three.js IFC viewer for Python and TypeScript. The native Python loader and browser WASM loader use the same `ifx-core` Rust engine. There are no external IFClite package dependencies.

```python
from ifx import IFCViewer

viewer = IFCViewer("building.ifc")
viewer.color_by_type("IfcWall", "#b8c4cc")
viewer.view(block=True)
```

```ts
import {createViewer} from "ifx-viewer";
import * as THREE from "three";

const viewer = createViewer(document.getElementById("viewer")!);
await viewer.load(file);
viewer.overlays.addMesh(
  new THREE.Mesh(new THREE.SphereGeometry(1), new THREE.MeshBasicMaterial({color: "red"})),
  "custom",
);
viewer.on("select", element => console.log(element?.property_sets));
```

Use `viewer.scene`, `camera`, `renderer`, `controls`, and `invalidate()` for custom geometry and behavior. App HTML panels are separate from the viewer. Named overlays manage app geometry. Selection, colors, visibility, element geometry, and data are public methods. See the [TypeScript API guide](frontend/README.md).

The Python viewer stays small: load IFC, read data, set colors, hide elements, and produce HTML. Python can also prepare data with `ifx_core.extract_ifc` and pass it to `IFCViewer.from_extraction`. This avoids a second geometry extraction in calculation apps.

## Local setup

Keep the source folders next to each other as `ifx/` and `ifx-core/`.

```sh
cd ../ifx-core
uv sync --group dev --no-install-project
uv run --no-sync maturin develop --uv --release
./scripts/build-wasm.sh
cd ../ifx
uv sync --extra dev
npm ci --prefix frontend
npm run test --prefix frontend
.venv/bin/python -m pytest -m 'not integration'
```

The frontend build creates the npm ES module with declarations and WASM assets. It also builds the standard renderer bundle for the Python wheel. Both outputs use `frontend/src/runtime.ts`.

CI checks out the exact core revision recorded in `.github/workflows/ci.yml` and
builds both native and WASM artifacts from it before testing the viewer.

The viewer is MIT licensed. The adapted Rust source in `ifx-core` is MPL-2.0. The npm package includes the core license, source notice, and corresponding source archive with its WASM assets. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
