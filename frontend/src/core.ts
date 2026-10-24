export type TessellationQuality =
  | "lowest"
  | "low"
  | "medium"
  | "high"
  | "highest";
export type PropertyAtom = { value: string; value_type: string };
export type PropertyDetails =
  | { kind: "enumerated"; values: PropertyAtom[]; enumeration_id: number | null }
  | { kind: "list"; values: PropertyAtom[] }
  | { kind: "bounded"; lower: PropertyAtom | null; upper: PropertyAtom | null; set_point: PropertyAtom | null }
  | { kind: "table"; defining: PropertyAtom[]; defined: PropertyAtom[]; expression: string | null; defining_unit_id: number | null; defined_unit_id: number | null; interpolation: string | null }
  | { kind: "reference"; express_id: number; ifc_type: string | null; name: string | null }
  | { kind: "complex"; usage_name: string | null; properties: IfcValue[] };
export type IfcValue = { name: string; value: string; value_type: string; unit_id?: number; details?: PropertyDetails; issue?: string };
export type ResourcePropertySet = {
  express_id: number; ifc_type: string; resource_kind: "material" | "profile";
  resource_id: number | null; name: string; description: string | null; properties: IfcValue[];
};
export type IdExamples = { count: number; sample_ids: number[]; truncated: boolean };
export type CoverageReport = {
  scan_complete: boolean; total_records: number; distinct_entity_ids: number;
  duplicate_entity_ids: number[]; unknown_records: number;
  classes: Record<string, { declared: boolean; is_root: boolean; is_product: boolean; scanned: number; decoded_for_model_data: number; exported_rows: number; mesh_elements: number }>;
  extraction: null | {
    source_products: number; exported_rows: number; mesh_elements: number; represented_products: number;
    products_without_metadata: IdExamples; unmeshed_represented_products: IdExamples; meshes_without_metadata: IdExamples;
    property_issue_occurrences: Record<string, number>;
  };
};
export type IfcEntity = {
  express_id: number;
  ifc_type: string;
  global_id: string | null;
  name: string | null;
  description: string | null;
  object_type: string | null;
  has_geometry: boolean;
  placement: { matrix: number[] } | null;
  attributes: IfcValue[];
  property_sets: { name: string; properties: IfcValue[] }[];
  quantity_sets: {
    name: string;
    quantities: { name: string; value: number; kind: string }[];
  }[];
};
export type IfcObjectType = {
  express_id: number;
  ifc_type: string;
  global_id: string | null;
  name: string | null;
  description: string | null;
  attributes: IfcValue[];
};
export type CoreGeometry = {
  up_axis: "Z";
  units: "m";
  rtc_offset: number[];
  element_count: number;
  elements: Record<
    string,
    {
      ifc_type: string;
      global_id?: string;
      name?: string;
      vertices: number[][];
      faces: number[][];
      color: number[];
      material_groups?: { triangle_start: number; triangle_count: number; color: number[] }[];
    }
  >;
};
export type CoreModel = {
  schema: string;
  object_types?: {
    definitions: Record<string, IfcObjectType>;
    types_by_element: Record<string, number[]>;
  };
  coverage?: CoverageReport;
  length_unit_scale: number;
  entity_count: number;
  units: Record<string, any>;
  spatial: Record<string, any>;
  relationships: Record<string, any>;
  openings: Record<string, any>;
  classifications: Record<string, any>;
  documents: Record<string, any>;
  groups: Record<string, any>;
  connections: Record<string, any>;
  georeferencing: Record<string, any>;
  materials: Record<string, any>;
};
export type ExtractedIfc = {
  geometry: CoreGeometry;
  entities: {
    entities: IfcEntity[];
    units: {
      length_unit_scale: number;
      plane_angle_to_radians: number;
      project_id: number | null;
    };
  };
  model: CoreModel;
};
export type CoreOptions = {
  wasmUrl?: string | URL;
  useWorker?: boolean;
  signal?: AbortSignal;
};

export type IfcGeometryBatch = {
  geometry: CoreGeometry;
  processed: number;
  total: number;
};

// Run in a worker. Callbacks run before the complete extraction returns.
export async function extractIfcStreaming(
  bytes: Uint8Array,
  quality: TessellationQuality,
  onBatch: (batch: IfcGeometryBatch) => void,
  options: Pick<CoreOptions, "wasmUrl"> = {},
): Promise<ExtractedIfc> {
  const core = await import("./wasm/ifx_core.js");
  await core.default(options.wasmUrl ? { module_or_path: options.wasmUrl } : undefined);
  return JSON.parse(core.extractIfcStreamingJson(bytes, quality, (json: string) => {
    onBatch(JSON.parse(json));
  }));
}

export async function extractIfc(
  bytes: Uint8Array,
  quality: TessellationQuality = "medium",
  options: CoreOptions = {},
): Promise<ExtractedIfc> {
  if (options.signal?.aborted) throw new Error("IFC extraction was cancelled.");
  if (options.useWorker !== false && typeof Worker === "function") {
    const worker = new Worker(new URL("./core.worker.js", import.meta.url), {
      type: "module",
    });
    const copy = bytes.slice();
    return new Promise((resolve, reject) => {
      const stop = () => {
        worker.terminate();
        options.signal?.removeEventListener("abort", cancel);
      };
      const cancel = () => {
        stop();
        reject(new Error("IFC extraction was cancelled."));
      };
      options.signal?.addEventListener("abort", cancel, { once: true });
      worker.onmessage = ({ data }) => {
        stop();
        data.error ? reject(new Error(data.error)) : resolve(data.result);
      };
      worker.onerror = (event) => {
        stop();
        reject(new Error(event.message));
      };
      worker.postMessage(
        { bytes: copy, quality, wasmUrl: options.wasmUrl?.toString() },
        [copy.buffer],
      );
    });
  }
  const core = await import("./wasm/ifx_core.js");
  await core.default(
    options.wasmUrl ? { module_or_path: options.wasmUrl } : undefined,
  );
  return JSON.parse(core.extractIfcJson(bytes, quality));
}
