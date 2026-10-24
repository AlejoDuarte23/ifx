import type { IfcEntity } from "./core.js";
export type ElementIds = number | Iterable<number>;
export type ColorValue = string | readonly number[];
export type Bounds = [number, number, number, number, number, number];
export type GeometryRange = {
  batch: "opaque" | "transparent";
  vertex_start: number;
  vertex_count: number;
  triangle_start: number;
  triangle_count: number;
  materials?: { vertex_start: number; vertex_count: number; color: number[] }[];
};
export type ViewerElement = Omit<IfcEntity, "express_id" | "placement"> & {
  id: number;
  placement: number[] | null;
  bbox: Bounds;
  batch: "opaque" | "transparent";
  vertex_start: number;
  vertex_count: number;
  triangle_start: number;
  triangle_count: number;
  base_color: number[];
  configured_color: number[];
  display_color: number[];
  /** All render ranges for one IFC identity. Legacy fields describe the first range. */
  geometry_ranges?: GeometryRange[];
};

export function elementRanges(element: GeometryRange & { geometry_ranges?: GeometryRange[] }): GeometryRange[] {
  return element.geometry_ranges ?? [element];
}
export type ModelInfo = {
  schema?: string;
  element_count?: number;
  entity_count?: number;
  world_origin?: number[];
  world_bbox?: Bounds;
  local_bbox?: Bounds;
  units?: string;
  up_axis?: string;
  length_unit_scale?: number;
  plane_angle_to_radians?: number;
  crs_name?: string;
  display_units?: Record<string, string>;
  has_georeference?: boolean;
};
export type ViewerEvents = {
  render: null;
  clear: null;
  select: ViewerElement | null;
  ready: { model: ModelInfo };
  dispose: null;
};
