import gzip
import json
import struct

import numpy as np

from ifx.payload import (
    MAGIC,
    SECTION_ORDER,
    build_payload_from_documents,
    restyle_payload,
)


def fake_documents():
    vertices = np.array(
        [
            [0.0, 0.0, 0.0],
            [2.0, 0.0, 0.0],
            [2.0, 1.0, 0.0],
            [0.0, 1.0, 0.0],
        ],
        dtype="<f8",
    )
    faces = np.array([[0, 1, 2], [0, 2, 3]], dtype="<u4")
    geometry = {
        "up_axis": "Z",
        "units": "m",
        "elements": {
            42: {
                "ifc_type": "IfcSlab",
                "global_id": "abc",
                "name": "Floor",
                "color": [0.2, 0.4, 0.8, 1.0],
                "vertices": vertices.tobytes(),
                "faces": faces.tobytes(),
            }
        },
    }
    entities = {
        "entity_count": 1,
        "length_unit_scale": 1.0,
        "plane_angle_to_radians": 1.0,
        "entities": {
            42: {
                "description": "Test slab",
                "object_type": None,
                "attributes": [
                    {"name": "PredefinedType", "value": "FLOOR", "value_type": "IFCENUM"}
                ],
                "property_sets": [
                    {
                        "name": "Pset_SlabCommon",
                        "properties": [
                            {"name": "IsExternal", "value": "False", "value_type": "IFCBOOLEAN"}
                        ],
                    }
                ],
                "quantity_sets": [],
                "placement": None,
            },
            99: {
                "ifc_type": "IfcSlabType",
                "name": "Standard floor type",
                "object_type": None,
            },
        },
    }
    return geometry, entities


def unpack_container(compressed: bytes):
    raw = gzip.decompress(compressed)
    assert raw[:8] == MAGIC
    metadata_length = struct.unpack_from("<I", raw, 8)[0]
    offset = 12
    metadata = json.loads(raw[offset : offset + metadata_length])
    offset = (offset + metadata_length + 3) & ~3
    sections = {}
    for name in SECTION_ORDER:
        length = struct.unpack_from("<I", raw, offset)[0]
        offset += 4
        sections[name] = raw[offset : offset + length]
        offset = (offset + length + 3) & ~3
    return raw, metadata, sections


def test_payload_contains_geometry_and_properties():
    geometry, entities = fake_documents()
    spatial = {
        "project_id": 1,
        "element_to_container": {42: 2},
        "element_to_storey": {42: 2},
        "roots": [
            {
                "express_id": 1,
                "ifc_type": "IfcProject",
                "name": "Test project",
                "children": [
                    {
                        "express_id": 2,
                        "ifc_type": "IfcBuildingStorey",
                        "name": "Ground floor",
                        "children": [],
                        "elements": [42],
                        "referenced_elements": [],
                    }
                ],
                "elements": [],
                "referenced_elements": [],
            }
        ],
    }
    relationships = {
        "edges": [
            {
                "relationship_id": 100,
                "relationship_type": "IfcRelDefinesByType",
                "relating_id": 99,
                "related_id": 42,
            }
        ]
    }
    materials = {
        "definitions": {
            77: {
                "source_definition_id": 77,
                "resolved_definition_id": 77,
                "material_type": "Material",
                "name": "Concrete",
                "category": "Concrete",
            }
        },
        "element_materials": {42: [{"definition_id": 77, "inherited_from_type": 99}]},
    }
    classifications = {
        "systems": {88: {"express_id": 88, "name": "Uniclass 2015", "location": "system.json"}},
        "references": {
            89: {
                "express_id": 89,
                "identification": "Pr_20_93",
                "name": "Unit structure products",
                "system_name": "Uniclass 2015",
                "path": ["Pr_20", "Pr_20_93"],
            }
        },
        "element_classifications": {42: [{"classification_id": 89, "inherited_from_type": 99}]},
    }
    documents = {
        "definitions": {
            90: {
                "express_id": 90,
                "document_type": "DocumentReference",
                "identification": "DOC-001",
                "name": "Installation manual",
                "location": "manual.pdf",
            }
        },
        "element_documents": {
            42: [
                {
                    "definition_id": 90,
                    "inherited_from_type": None,
                    "document": {"name": "ignored duplicate"},
                }
            ]
        },
    }
    groups = {
        "definitions": {
            91: {
                "express_id": 91,
                "ifc_type": "IfcZone",
                "name": "Fire zone",
                "long_name": "Compartment A",
            }
        },
        "groups_by_object": {
            42: [
                {
                    "relationship_id": 102,
                    "group_id": 91,
                    "object_id": 42,
                    "factor": 0.5,
                }
            ]
        },
    }
    connections = {
        "element_connections": [
            {
                "relationship_id": 103,
                "relationship_type": "IfcRelConnectsElements",
                "relating_element_id": 42,
                "related_element_id": 43,
            }
        ],
        "connections_by_element": {42: [103]},
        "ports": {
            92: {
                "express_id": 92,
                "ifc_type": "IfcDistributionPort",
                "name": "Supply port",
                "flow_direction": "SOURCE",
            },
            93: {
                "express_id": 93,
                "ifc_type": "IfcDistributionPort",
                "name": "Sink port",
                "flow_direction": "SINK",
            },
        },
        "ports_by_element": {42: [92]},
        "connected_ports": {92: [93], 93: [92]},
        "space_boundaries": [
            {
                "relationship_id": 104,
                "relationship_type": "IfcRelSpaceBoundary",
                "space_id": 44,
                "element_id": 42,
                "physical_or_virtual": "PHYSICAL",
                "internal_or_external": "INTERNAL",
            }
        ],
        "boundaries_by_element": {42: [104]},
        "boundaries_by_space": {44: [104]},
    }
    georeferencing = {
        "has_georeference": True,
        "source": "mapConversion",
        "projected_crs": {"express_id": 94, "name": "EPSG:28992"},
        "map_conversion": {"eastings": 155000.0, "northings": 463000.0},
    }
    payload = build_payload_from_documents(
        geometry,
        entities,
        spatial_doc=spatial,
        relationships_doc=relationships,
        classifications_doc=classifications,
        documents_doc=documents,
        groups_doc=groups,
        connections_doc=connections,
        georeferencing_doc=georeferencing,
        materials_doc=materials,
        display_units={"LENGTHUNIT": "mm", "AREAUNIT": "m²"},
    )
    raw, metadata, sections = unpack_container(payload.compressed)

    assert payload.raw_size == len(raw)
    assert metadata["model"]["element_count"] == 1
    assert metadata["model"]["display_units"] == {"AREAUNIT": "m²", "LENGTHUNIT": "mm"}
    assert metadata["model"]["world_origin"] == [1.0, 0.5, 0.0]
    assert metadata["spatial"]["roots"][0]["children"][0]["elements"] == [42]
    references = metadata["references"]
    assert references["elements"]["42"]["container_id"] == 2
    assert references["elements"]["42"]["storey_id"] == 2
    assert references["elements"]["42"]["relationships"][0]["target_id"] == 99
    assert references["referenced_entities"]["99"]["name"] == "Standard floor type"
    assert references["elements"]["42"]["materials"][0]["definition_id"] == 77
    assert references["material_definitions"]["77"]["name"] == "Concrete"
    assert references["elements"]["42"]["classifications"] == [
        {"definition_id": 89, "inherited_from_type": 99}
    ]
    assert references["classification_references"]["89"]["system_name"] == "Uniclass 2015"
    assert references["elements"]["42"]["documents"] == [
        {"definition_id": 90, "inherited_from_type": None}
    ]
    assert references["document_definitions"]["90"]["name"] == "Installation manual"
    assert metadata["classifications"] == {
        "systems": {"88": classifications["systems"][88]},
        "references": {"89": classifications["references"][89]},
        "element_classifications": {"42": [{"classification_id": 89, "inherited_from_type": 99}]},
    }
    assert metadata["documents"]["definitions"]["90"]["identification"] == "DOC-001"
    assert references["elements"]["42"]["groups"] == [
        {"relationship_id": 102, "group_id": 91, "factor": 0.5}
    ]
    assert references["group_definitions"]["91"]["ifc_type"] == "IfcZone"
    assert metadata["groups"]["definitions"]["91"]["name"] == "Fire zone"
    assert references["elements"]["42"]["connections"][0]["relationship_id"] == 103
    assert references["elements"]["42"]["ports"] == [{"port_id": 92, "connected_ports": [93]}]
    assert references["port_definitions"]["92"]["name"] == "Supply port"
    assert references["port_definitions"]["93"]["name"] == "Sink port"
    assert references["elements"]["42"]["space_boundaries"][0]["relationship_id"] == 104
    assert metadata["connections"]["ports_by_element"] == {"42": [92]}
    assert metadata["model"]["has_georeference"] is True
    assert metadata["model"]["crs_name"] == "EPSG:28992"
    assert metadata["georeferencing"] == georeferencing
    element = metadata["elements"][0]
    assert element["id"] == 42
    assert element["ifc_type"] == "IfcSlab"
    assert element["property_sets"][0]["name"] == "Pset_SlabCommon"
    assert len(sections["opaque_positions"]) == 4 * 3 * 4
    assert len(sections["opaque_indices"]) == 2 * 3 * 4
    assert sections["transparent_positions"] == b""


def test_payload_exposes_native_units_and_opening_relationships():
    geometry, entities = fake_documents()
    entities["entities"].update(
        {
            43: {
                "ifc_type": "IfcOpeningElement",
                "name": "Door opening",
                "object_type": None,
            },
            44: {"ifc_type": "IfcDoor", "name": "Door", "object_type": None},
        }
    )
    relationships = {
        "edges": [
            {
                "relationship_id": 100,
                "relationship_type": "IfcRelVoidsElement",
                "relating_id": 42,
                "related_id": 43,
            },
            {
                "relationship_id": 101,
                "relationship_type": "IfcRelFillsElement",
                "relating_id": 43,
                "related_id": 44,
            },
        ]
    }
    openings = {
        "voids": [{"relationship_id": 100, "element_id": 42, "opening_id": 43}],
        "fills": [{"relationship_id": 101, "opening_id": 43, "filling_id": 44}],
        "openings_by_element": {42: [43]},
        "elements_by_opening": {43: [42]},
        "fillings_by_opening": {43: [44]},
        "openings_by_filling": {44: [43]},
    }
    units = {
        "assignment_id": 5,
        "by_type": {
            "LENGTHUNIT": {
                "express_id": 6,
                "ifc_type": "IfcSIUnit",
                "unit_type": "LENGTHUNIT",
                "name": "METRE",
                "symbol": "mm",
                "si_scale": 0.001,
                "conversion_offset": None,
                "elements": [],
            },
            "PLANEANGLEUNIT": {
                "express_id": 7,
                "ifc_type": "IfcConversionBasedUnit",
                "unit_type": "PLANEANGLEUNIT",
                "name": "DEGREE",
                "symbol": "°",
                "si_scale": 0.0174532925199433,
                "conversion_offset": None,
                "elements": [],
            },
        },
    }

    payload = build_payload_from_documents(
        geometry,
        entities,
        relationships_doc=relationships,
        openings_doc=openings,
        units_doc=units,
    )
    _, metadata, _ = unpack_container(payload.compressed)

    assert metadata["model"]["display_units"] == {
        "LENGTHUNIT": "mm",
        "PLANEANGLEUNIT": "°",
    }
    assert metadata["units"] == units
    assert metadata["openings"]["openings_by_element"] == {"42": [43]}
    assert metadata["references"]["elements"]["42"]["relationships"] == [
        {
            "relationship_id": 100,
            "relationship_type": "IfcRelVoidsElement",
            "role": "relating",
            "target_id": 43,
        }
    ]
    assert metadata["references"]["referenced_entities"]["43"]["ifc_type"] == ("IfcOpeningElement")


def test_initial_color_and_hidden_state_are_separate():
    geometry, entities = fake_documents()
    payload = build_payload_from_documents(
        geometry,
        entities,
        initial_colors={42: "#ff0000"},
        hidden_ids=[42],
    )
    _, metadata, _ = unpack_container(payload.compressed)
    element = metadata["elements"][0]
    assert element["configured_color"] == [255, 0, 0, 255]
    assert element["display_color"] == [255, 0, 0, 0]


def test_color_channels_accept_normalized_and_mixed_alpha():
    geometry, entities = fake_documents()
    normalized = build_payload_from_documents(
        geometry,
        entities,
        initial_colors={42: (1.0, 0.5, 0.0, 0.25)},
    )
    _, metadata, _ = unpack_container(normalized.compressed)
    assert metadata["elements"][0]["configured_color"] == [255, 128, 0, 64]

    mixed = build_payload_from_documents(
        geometry,
        entities,
        initial_colors={42: (255, 0, 0, 0.5)},
    )
    _, metadata, _ = unpack_container(mixed.compressed)
    assert metadata["elements"][0]["configured_color"] == [255, 0, 0, 128]


def test_transparent_initial_override_uses_transparent_batch():
    geometry, entities = fake_documents()
    payload = build_payload_from_documents(
        geometry,
        entities,
        initial_colors={42: "#4f8cff66"},
    )
    _, metadata, sections = unpack_container(payload.compressed)
    assert metadata["elements"][0]["batch"] == "transparent"
    assert sections["opaque_positions"] == b""
    assert len(sections["transparent_positions"]) == 4 * 3 * 4


def test_restyle_patches_colors_without_moving_geometry_batches():
    geometry, entities = fake_documents()
    base = build_payload_from_documents(geometry, entities)
    styled = restyle_payload(
        base,
        initial_colors={42: "#4f8cff66"},
        hidden_ids=[42],
    )
    _, metadata, sections = unpack_container(styled.compressed)
    element = metadata["elements"][0]
    assert element["batch"] == "opaque"
    assert element["configured_color"] == [79, 140, 255, 102]
    assert element["display_color"] == [79, 140, 255, 0]
    colors = np.frombuffer(sections["opaque_colors"], dtype=np.uint8).reshape(-1, 4)
    assert np.all(colors == [79, 140, 255, 0])
    assert sections["transparent_colors"] == b""
