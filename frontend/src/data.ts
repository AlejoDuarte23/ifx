import type { ExtractedIfc, IfcEntity, IfcObjectType, ResourcePropertySet } from "./core.js";
import { buildReferences } from "./references.js";
export type IfcElementData = IfcEntity & {
  references: Record<string, unknown>;
};
export function inspectElement(
  store: ExtractedIfc,
  expressId: number,
): IfcElementData | null {
  const row = store.entities.entities.find(
    (entity) => entity.express_id === expressId,
  );
  if (!row) return null;
  return {
    ...row,
    references: buildReferences(store, [expressId]).elements[expressId],
  };
}
export function inspectGroup(store: ExtractedIfc, expressId: number) {
  return {
    definition: store.model.groups.definitions?.[expressId] ?? null,
    members: store.model.groups.members_by_group?.[expressId] ?? [],
  };
}
export function inspectGeoreferencing(store: ExtractedIfc) {
  return store.model.georeferencing;
}
export function inspectProjectUnits(store: ExtractedIfc) {
  return store.model.units;
}

export function inspectLinkedTypes(store: ExtractedIfc, expressId: number): IfcObjectType[] {
  const types = store.model.object_types;
  if (!types) return [];
  return [...new Set(types.types_by_element[expressId] ?? [])]
    .map(id => types.definitions[id])
    .filter((type): type is IfcObjectType => Boolean(type));
}


export function inspectCoverage(store: ExtractedIfc) {
  return store.model.coverage ?? null;
}

export function inspectMaterialProperties(store: ExtractedIfc, expressId: number): ResourcePropertySet[] {
  const data = store.model.materials;
  const materials = new Set<number>();
  const profiles = new Set<number>();
  for (const assignment of data.element_materials?.[expressId] ?? []) {
    const material = assignment.material;
    if (material.material_type === "Material") materials.add(material.resolved_definition_id);
    for (const layer of material.layers ?? []) if (layer.material_id != null) materials.add(layer.material_id);
    for (const constituent of material.constituents ?? []) if (constituent.material_id != null) materials.add(constituent.material_id);
    for (const profile of material.profiles ?? []) {
      if (profile.material_id != null) materials.add(profile.material_id);
      if (profile.profile_id != null) profiles.add(profile.profile_id);
    }
    for (const leaf of material.materials ?? []) materials.add(leaf.express_id);
  }
  const sets = new Set<number>();
  for (const id of materials) for (const set of data.properties_by_material?.[id] ?? []) sets.add(set);
  for (const id of profiles) for (const set of data.properties_by_profile?.[id] ?? []) sets.add(set);
  return [...sets].map(id => data.property_sets?.[id]).filter((set): set is ResourcePropertySet => Boolean(set));
}
