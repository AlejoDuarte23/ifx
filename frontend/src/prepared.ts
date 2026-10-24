import * as THREE from "three";
import type { ExtractedIfc } from "./core.js";
import { buildReferences } from "./references.js";
import type { SerializedBVH } from "three-mesh-bvh";

export type PreparedModel = {
  metadata: Record<string, any>;
  sections: Record<string, Float32Array | Uint32Array | Uint8Array>;
  selectionIndices?: Partial<Record<"opaque" | "transparent", SerializedBVH>>;
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
  const byId = new Map<number, any>();
  const sections: PreparedModel["sections"] = {};
  const parts = entries.flatMap(([id, mesh]) => {
    const groups = mesh.material_groups ?? [{ triangle_start: 0, triangle_count: mesh.faces.length, color: mesh.color }];
    let covered = 0;
    const parts = groups.map(group => {
      if (group.triangle_start !== covered || !Number.isInteger(group.triangle_count) || group.triangle_count < 0 || covered + group.triangle_count > mesh.faces.length)
        throw new Error(`Invalid material range in element ${id}.`);
      covered += group.triangle_count;
      const vertices: number[] = [];
      const remap = new Map<number, number>();
      const indices = new Uint32Array(group.triangle_count * 3);
      let cursor = 0;
      for (let i = group.triangle_start; i < covered; i++) {
        for (const index of mesh.faces[i]) {
          if (!Number.isInteger(index) || index < 0 || index >= mesh.vertices.length)
            throw new Error(`Invalid triangle in element ${id}.`);
          if (!remap.has(index)) { remap.set(index, vertices.length); vertices.push(index); }
          indices[cursor++] = remap.get(index)!;
        }
      }
      return { id: Number(id), mesh, vertices, indices, color: group.color.map(value => Math.round(Math.fround(Math.max(0, Math.min(1, value))) * 255)) };
    });
    if (covered !== mesh.faces.length) throw new Error(`Incomplete material ranges in element ${id}.`);
    return parts;
  });
  for (const batch of ["opaque", "transparent"]) {
    const sources = parts.filter(part => (part.color[3] < 250 ? "transparent" : "opaque") === batch);
    const vertexCount = sources.reduce((sum, part) => sum + part.vertices.length, 0);
    const indexCount = sources.reduce((sum, part) => sum + part.indices.length, 0);
    const positions = new Float32Array(vertexCount * 3), indices = new Uint32Array(indexCount), colors = new Uint8Array(vertexCount * 4);
    let vertex = 0, triangle = 0;
    for (const part of sources) {
      const { id, mesh, color } = part;
      const start = vertex, triangleStart = triangle;
      const box = new THREE.Box3();
      for (const index of part.vertices) {
        const local = new THREE.Vector3(...mesh.vertices[index]).sub(origin);
        box.expandByPoint(local);
        positions.set(local.toArray(), vertex * 3);
        colors.set(color, vertex * 4);
        ++vertex;
      }
      indices.set(part.indices.map(index => index + start), triangle * 3);
      triangle += part.indices.length / 3;
      let element = byId.get(id);
      if (!element) {
        const row = rows.get(id);
        element = {
          ...row, id, ifc_type: mesh.ifc_type, name: row?.name ?? mesh.name,
          global_id: row?.global_id ?? mesh.global_id, placement: row?.placement?.matrix ?? null,
          base_color: color, configured_color: color, display_color: color,
          geometry_ranges: [], bbox: [...box.min.toArray(), ...box.max.toArray()],
        };
        byId.set(id, element); elements.push(element);
      } else {
        box.expandByPoint(new THREE.Vector3().fromArray(element.bbox));
        box.expandByPoint(new THREE.Vector3().fromArray(element.bbox, 3));
        element.bbox = [...box.min.toArray(), ...box.max.toArray()];
      }
      const last = element.geometry_ranges.at(-1);
      if (last?.batch === batch) {
        last.vertex_count += vertex - start;
        last.triangle_count += triangle - triangleStart;
      } else element.geometry_ranges.push({ batch, vertex_start: start, vertex_count: vertex - start, triangle_start: triangleStart, triangle_count: triangle - triangleStart, materials: [] });
      element.geometry_ranges.at(-1).materials.push({ vertex_start: start, vertex_count: vertex - start, color });
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.computeVertexNormals();
    sections[`${batch}_positions`] = positions;
    sections[`${batch}_normals`] = geometry.getAttribute("normal").array as Float32Array;
    sections[`${batch}_colors`] = colors;
    sections[`${batch}_indices`] = indices;
    geometry.dispose();
  }
  for (const element of elements) Object.assign(element, element.geometry_ranges[0]);
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
