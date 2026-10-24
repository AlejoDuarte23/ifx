# Third-party notices

## IFX core and IFC-Lite

IFX uses `ifx-core` for native Python and WebAssembly extraction. It has no external IFClite package dependency.

IFX core includes adapted source from IFC-Lite, maintained by LTplus AG and its contributors. The imported STEP parser, geometry kernel, processing pipeline, entity model, and Python buffer binding remain under the Mozilla Public License 2.0. This is a source port, not only inspiration.

Original source: [IFC-Lite](https://github.com/LTplus-AG/ifc-lite), tag `ifclite-geom-v4.4.0`, commit `9c17d7db44ff603f02ce7952d67ded05daabd120`.

The core repository contains the full MPL license, retained source headers, `ACKNOWLEDGEMENTS.md`, and `UPSTREAM_SOURCE.json`. The npm package includes the license, notice, and corresponding core source in `dist/wasm/`. The native core is a separate MPL package. Keep these notices and make the corresponding core source available when you distribute its native or WASM build. The IFX viewer remains MIT licensed.

## Three.js

The bundled viewer includes Three.js. The npm module uses the host's compatible Three.js package. The HTML CDN mode loads the pinned version.

- Project: https://github.com/mrdoob/three.js
- Version: 0.185.1
- License: MIT
- Full license: `src/ifx/static/licenses/THREE_LICENSE.txt`

## three-mesh-bvh

The viewer uses three-mesh-bvh for selection.

- Project: https://github.com/gkjohnson/three-mesh-bvh
- Version: 0.9.14
- License: MIT
- Full license: `src/ifx/static/licenses/THREE_MESH_BVH_LICENSE.txt`
