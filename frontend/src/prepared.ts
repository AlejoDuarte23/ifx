import * as THREE from "three";
import type { ExtractedIfc } from "./core.js";
import { buildReferences } from "./references.js";

export type PreparedModel = {
  metadata: Record<string, any>;
  sections: Record<string, Float32Array | Uint32Array | Uint8Array>;
};

export function prepareModel(data: ExtractedIfc, worldOrigin?: number[]): PreparedModel {
  const rows = new Map(
    data.entities.entities.map((row) => [row.express_id, row]),
  );
  const entries = Object.entries(data.geometry.elements).sort(
    ([a], [b]) => Number(a) - Number(b),
  );
  const world = new THREE.Box3();
  for (const [, mesh] of entries)
    for (const point of mesh.vertices)
      world.expandByPoint(new THREE.Vector3(...point));
  if (world.isEmpty()) throw new Error("The IFC file produced no geometry.");
  const origin = worldOrigin ? new THREE.Vector3().fromArray(worldOrigin) : world.getCenter(new THREE.Vector3());
  const elements = [];
  const sections: PreparedModel["sections"] = {};
  for (const batch of ["opaque", "transparent"]) {
    const sources = entries.filter(
      ([, mesh]) =>
        (mesh.color[3] < 250 / 255 ? "transparent" : "opaque") === batch,
    );
    const vertexCount = sources.reduce(
      (sum, [, mesh]) => sum + mesh.vertices.length,
      0,
    );
    const indexCount = sources.reduce(
      (sum, [, mesh]) => sum + mesh.faces.length * 3,
      0,
    );
    const positions = new Float32Array(vertexCount * 3),
      indices = new Uint32Array(indexCount),
      colors = new Uint8Array(vertexCount * 4);
    let vertex = 0,
      triangle = 0;
    for (const [id, mesh] of sources) {
      const start = vertex,
        triangleStart = triangle;
      const box = new THREE.Box3();
      const color = mesh.color.map((value) =>
        Math.round(Math.max(0, Math.min(1, value)) * 255),
      );
      for (const point of mesh.vertices) {
        const local = new THREE.Vector3(...point).sub(origin);
        box.expandByPoint(local);
        positions.set(local.toArray(), vertex * 3);
        colors.set(color, vertex * 4);
        ++vertex;
      }
      for (const face of mesh.faces) {
        if (
          face.some(
            (index) =>
              !Number.isInteger(index) ||
              index < 0 ||
              index >= mesh.vertices.length,
          )
        )
          throw new Error(`Invalid triangle in element ${id}.`);
        indices.set(
          face.map((index) => index + start),
          triangle++ * 3,
        );
      }
      const row = rows.get(Number(id));
      elements.push({
        ...row,
        id: Number(id),
        ifc_type: mesh.ifc_type,
        name: row?.name ?? mesh.name,
        global_id: row?.global_id ?? mesh.global_id,
        placement: row?.placement?.matrix ?? null,
        batch,
        vertex_start: start,
        vertex_count: vertex - start,
        triangle_start: triangleStart,
        triangle_count: triangle - triangleStart,
        bbox: [...box.min.toArray(), ...box.max.toArray()],
        base_color: color,
        configured_color: color,
        display_color: color,
      });
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.computeVertexNormals();
    sections[`${batch}_positions`] = positions;
    sections[`${batch}_normals`] = geometry.getAttribute("normal")
      .array as Float32Array;
    sections[`${batch}_colors`] = colors;
    sections[`${batch}_indices`] = indices;
    geometry.dispose();
  }
  const model = data.model;
  const references = buildReferences(
    data,
    elements.map((element) => element.id),
  );
  const local = world.clone().translate(origin.clone().negate());
  return {
    metadata: {
      format: "ifx",
      version: 1,
      ...model,
      references,
      elements,
      model: {
        schema: model.schema,
        element_count: elements.length,
        entity_count: model.entity_count,
        world_origin: origin.toArray(),
        world_bbox: [...world.min.toArray(), ...world.max.toArray()],
        local_bbox: [...local.min.toArray(), ...local.max.toArray()],
        units: "m",
        up_axis: "Z",
        ...data.entities.units,
        display_units: Object.fromEntries(
          Object.entries(model.units.by_type ?? {}).map(
            ([key, value]: [string, any]) => [key, value.symbol],
          ),
        ),
        has_georeference: model.georeferencing.has_georeference,
        crs_name: model.georeferencing.projected_crs?.name,
      },
    },
    sections,
  };
}
