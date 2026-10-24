import type { ExtractedIfc } from "./core.js";

export function buildReferences(data: ExtractedIfc, ids: Iterable<number>) {
  const model = data.model;
  const spatialNodes: Record<string, any> = {};
  const visit = (nodes: any[]) => {
    for (const node of nodes) {
      spatialNodes[node.express_id] = { ...node, id: node.express_id };
      visit(node.children ?? []);
    }
  };
  visit(model.spatial.roots ?? []);
  const elements: Record<string, any> = {};
  const relationIndex = new Map<number, any[]>();
  const excluded = new Set([
    "IfcRelAssociatesMaterial",
    "IfcRelAssociatesClassification",
    "IfcRelAssociatesDocument",
    "IfcRelContainedInSpatialStructure",
  ]);
  for (const edge of model.relationships.edges ?? []) {
    if (excluded.has(edge.relationship_type)) continue;
    for (const [source, target, role] of [
      [edge.relating_id, edge.related_id, "relating"],
      [edge.related_id, edge.relating_id, "related"],
    ]) {
      const list = relationIndex.get(source) ?? [];
      list.push({
        relationship_id: edge.relationship_id,
        relationship_type: edge.relationship_type,
        target_id: target,
        role,
      });
      relationIndex.set(source, list);
    }
  }
  const connections = new Map(
    (model.connections.element_connections ?? []).map((row) => [
      row.relationship_id,
      row,
    ]),
  );
  const boundaries = new Map(
    (model.connections.space_boundaries ?? []).map((row) => [
      row.relationship_id,
      row,
    ]),
  );
  for (const id of ids)
    elements[id] = {
      container_id: model.spatial.element_to_container?.[id],
      storey_id: model.spatial.element_to_storey?.[id],
      referenced_by_structure: Object.entries(
        model.spatial.referenced_by_structure ?? {},
      )
        .filter(([, members]: [string, number[]]) => members.includes(id))
        .map(([key]) => Number(key)),
      relationships: relationIndex.get(id) ?? [],
      classifications: (
        model.classifications.element_classifications?.[id] ?? []
      ).map((item) => ({ ...item, definition_id: item.classification_id })),
      documents: model.documents.element_documents?.[id] ?? [],
      materials: model.materials.element_materials?.[id] ?? [],
      groups: model.groups.groups_by_object?.[id] ?? [],
      connections: (model.connections.connections_by_element?.[id] ?? [])
        .map((key) => connections.get(key))
        .filter(Boolean),
      space_boundaries: [
        ...(model.connections.boundaries_by_element?.[id] ?? []),
        ...(model.connections.boundaries_by_space?.[id] ?? []),
      ]
        .map((key) => boundaries.get(key))
        .filter(Boolean),
      ports: (model.connections.ports_by_element?.[id] ?? []).map((port) => ({
        port_id: port,
        connected_ports: model.connections.connected_ports?.[port] ?? [],
      })),
    };
  return {
    elements,
    spatial_nodes: spatialNodes,
    referenced_entities: Object.fromEntries(
      data.entities.entities.map((row) => [
        row.express_id,
        { ...row, id: row.express_id },
      ]),
    ),
    material_definitions: model.materials.definitions ?? {},
    classification_references: model.classifications.references ?? {},
    classification_systems: model.classifications.systems ?? {},
    document_definitions: model.documents.definitions ?? {},
    group_definitions: model.groups.definitions ?? {},
    port_definitions: model.connections.ports ?? {},
  };
}
