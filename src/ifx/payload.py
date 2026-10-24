import gzip
import json
import math
import struct
from dataclasses import dataclass
from typing import Any, Iterable, Literal, Mapping, Sequence, cast

import numpy as np

MAGIC = b"IFCVIEW1"
SECTION_ORDER = (
    "opaque_positions",
    "opaque_normals",
    "opaque_colors",
    "opaque_indices",
    "transparent_positions",
    "transparent_normals",
    "transparent_colors",
    "transparent_indices",
)
VALID_QUALITIES = {"lowest", "low", "medium", "high", "highest"}
Quality = Literal["lowest", "low", "medium", "high", "highest"]


class ViewerBuildError(RuntimeError):
    """Raised when an IFC file cannot be converted into viewer data."""


@dataclass(frozen=True, slots=True)
class PreparedPayload:
    """Compressed viewer payload and summary information."""

    compressed: bytes
    raw_size: int
    metadata: dict[str, Any]

    @property
    def compressed_size(self) -> int:
        return len(self.compressed)


@dataclass(slots=True)
class _ElementGeometry:
    express_id: int
    ifc_type: str
    global_id: str | None
    name: str | None
    vertices: np.ndarray
    faces: np.ndarray
    base_color: tuple[int, int, int, int]
    batch: str
    world_min: np.ndarray
    world_max: np.ndarray


@dataclass(slots=True)
class _BatchArrays:
    positions: np.ndarray
    normals: np.ndarray
    colors: np.ndarray
    indices: np.ndarray
    vertex_cursor: int = 0
    index_cursor: int = 0


def build_payload(
    ifc_bytes: bytes,
    *,
    quality: str = "medium",
    include_properties: bool = True,
    inherit_type_properties: bool = True,
    include_attributes: bool = True,
    include_placements: bool = False,
    initial_colors: Mapping[int, str | Sequence[int | float]] | None = None,
    hidden_ids: Iterable[int] = (),
    compression_level: int = 6,
) -> PreparedPayload:
    """Build a browser-ready payload from raw IFC bytes.

    Heavy parsing and tessellation happen in the native ``ifx_core``
    extension. The returned geometry is merged into one opaque mesh and one
    transparent mesh to keep browser draw calls low.
    """

    if not isinstance(ifc_bytes, bytes):
        raise TypeError("ifc_bytes must be bytes")
    if not ifc_bytes:
        raise ValueError("ifc_bytes is empty")
    if quality not in VALID_QUALITIES:
        allowed = ", ".join(sorted(VALID_QUALITIES))
        raise ValueError(f"quality must be one of: {allowed}")
    if not 0 <= compression_level <= 9:
        raise ValueError("compression_level must be between 0 and 9")

    try:
        import ifx_core  # type: ignore[import-not-found]
    except ImportError as exc:  # pragma: no cover - depends on installation
        raise ViewerBuildError(
            "The IFC native dependencies are not installed. Install this package with its "
            "runtime dependencies: pip install ifx"
        ) from exc

    try:
        checked_quality = cast(Quality, quality)
        geometry_doc = ifx_core.geometry_data_buffers(ifc_bytes, checked_quality)
        need_entities = include_properties or include_attributes or include_placements
        if need_entities:
            entity_doc = ifx_core.entity_data(
                ifc_bytes,
                include_placements,
                inherit_type_properties,
                include_attributes,
            )
            if not include_properties:
                rows = entity_doc.get("entities", {})
                if isinstance(rows, Mapping):
                    for row in rows.values():
                        if isinstance(row, dict):
                            row["property_sets"] = []
                            row["quantity_sets"] = []
        else:
            entity_doc = {"entities": {}, "entity_count": 0}
        core_doc = ifx_core.model_data(ifc_bytes)
    except Exception as exc:  # native module exceptions vary by failure type
        raise ViewerBuildError(f"The IFC native parsers could not process the file: {exc}") from exc

    geometry_doc = dict(geometry_doc, schema=core_doc.get("schema"))
    return build_payload_from_documents(
        geometry_doc,
        entity_doc,
        spatial_doc=core_doc.get("spatial"),
        relationships_doc=core_doc.get("relationships"),
        openings_doc=core_doc.get("openings"),
        classifications_doc=core_doc.get("classifications"),
        documents_doc=core_doc.get("documents"),
        groups_doc=core_doc.get("groups"),
        connections_doc=core_doc.get("connections"),
        georeferencing_doc=core_doc.get("georeferencing"),
        materials_doc=core_doc.get("materials"),
        units_doc=core_doc.get("units"),
        quality=quality,
        initial_colors=initial_colors,
        hidden_ids=hidden_ids,
        compression_level=compression_level,
    )


def build_payload_from_documents(
    geometry_doc: Mapping[str, Any],
    entity_doc: Mapping[str, Any],
    *,
    spatial_doc: Mapping[str, Any] | None = None,
    relationships_doc: Mapping[str, Any] | None = None,
    openings_doc: Mapping[str, Any] | None = None,
    classifications_doc: Mapping[str, Any] | None = None,
    documents_doc: Mapping[str, Any] | None = None,
    groups_doc: Mapping[str, Any] | None = None,
    connections_doc: Mapping[str, Any] | None = None,
    georeferencing_doc: Mapping[str, Any] | None = None,
    materials_doc: Mapping[str, Any] | None = None,
    units_doc: Mapping[str, Any] | None = None,
    display_units: Mapping[str, str] | None = None,
    quality: str = "medium",
    initial_colors: Mapping[int, str | Sequence[int | float]] | None = None,
    hidden_ids: Iterable[int] = (),
    compression_level: int = 6,
) -> PreparedPayload:
    """Build a payload from already-extracted IFX documents.

    This public helper is useful for tests, caching layers, and applications
    that already call ``ifx_core`` themselves.
    """

    if quality not in VALID_QUALITIES:
        allowed = ", ".join(sorted(VALID_QUALITIES))
        raise ValueError(f"quality must be one of: {allowed}")
    if not 0 <= compression_level <= 9:
        raise ValueError("compression_level must be between 0 and 9")

    elements_map = geometry_doc.get("elements")
    if not isinstance(elements_map, Mapping):
        raise ViewerBuildError("geometry document does not contain an elements mapping")

    entity_rows_raw = entity_doc.get("entities", {})
    entity_rows: Mapping[Any, Any]
    if isinstance(entity_rows_raw, Mapping):
        entity_rows = entity_rows_raw
    else:
        entity_rows = {}

    hidden = {int(value) for value in hidden_ids}
    overrides = {
        int(express_id): _parse_color(color) for express_id, color in (initial_colors or {}).items()
    }

    geometries: list[_ElementGeometry] = []
    world_min = np.array([math.inf, math.inf, math.inf], dtype=np.float64)
    world_max = np.array([-math.inf, -math.inf, -math.inf], dtype=np.float64)

    for raw_id, raw_element in sorted(elements_map.items(), key=lambda item: int(item[0])):
        if not isinstance(raw_element, Mapping):
            continue
        express_id = int(raw_id)
        vertices = _decode_vertices(raw_element.get("vertices"), express_id)
        faces = _decode_faces(raw_element.get("faces"), express_id)
        if vertices.size == 0 or faces.size == 0:
            continue
        if int(faces.max(initial=0)) >= len(vertices):
            raise ViewerBuildError(
                f"element #{express_id} contains a face index outside its vertex array"
            )

        element_min = vertices.min(axis=0).astype(np.float64)
        element_max = vertices.max(axis=0).astype(np.float64)
        world_min = np.minimum(world_min, element_min)
        world_max = np.maximum(world_max, element_max)

        base_color = _parse_color(raw_element.get("color", (0.72, 0.74, 0.78, 1.0)))
        configured_color = overrides.get(express_id, base_color)
        batch = "transparent" if configured_color[3] < 250 else "opaque"
        geometries.append(
            _ElementGeometry(
                express_id=express_id,
                ifc_type=str(raw_element.get("ifc_type") or "IfcProduct"),
                global_id=_optional_string(raw_element.get("global_id")),
                name=_optional_string(raw_element.get("name")),
                vertices=vertices,
                faces=faces,
                base_color=base_color,
                batch=batch,
                world_min=element_min,
                world_max=element_max,
            )
        )

    if not geometries:
        raise ViewerBuildError("the IFC file produced no tessellated geometry")

    origin = (world_min + world_max) * 0.5

    batch_counts = {
        "opaque": {"vertices": 0, "indices": 0},
        "transparent": {"vertices": 0, "indices": 0},
    }
    for element in geometries:
        batch_counts[element.batch]["vertices"] += len(element.vertices)
        batch_counts[element.batch]["indices"] += element.faces.size

    batches = {
        name: _allocate_batch(counts["vertices"], counts["indices"])
        for name, counts in batch_counts.items()
    }

    metadata_elements: list[dict[str, Any]] = []
    for element in geometries:
        batch = batches[element.batch]
        vertex_start = batch.vertex_cursor
        vertex_end = vertex_start + len(element.vertices)
        index_start = batch.index_cursor
        index_end = index_start + element.faces.size

        local_vertices = (element.vertices.astype(np.float64) - origin).astype(np.float32)
        normals = _compute_vertex_normals(local_vertices, element.faces)
        configured_color = overrides.get(element.express_id, element.base_color)
        display_color = configured_color
        if element.express_id in hidden:
            display_color = (*display_color[:3], 0)

        batch.positions[vertex_start:vertex_end] = local_vertices
        batch.normals[vertex_start:vertex_end] = normals
        batch.colors[vertex_start:vertex_end] = np.asarray(display_color, dtype=np.uint8)
        batch.indices[index_start:index_end] = (
            element.faces.reshape(-1).astype(np.uint32, copy=False) + vertex_start
        )
        batch.vertex_cursor = vertex_end
        batch.index_cursor = index_end

        row = entity_rows.get(element.express_id)
        if row is None:
            row = entity_rows.get(str(element.express_id))
        row = row if isinstance(row, Mapping) else {}

        metadata_elements.append(
            {
                "id": element.express_id,
                "ifc_type": element.ifc_type,
                "global_id": element.global_id,
                "name": element.name,
                "description": _optional_string(row.get("description")),
                "object_type": _optional_string(row.get("object_type")),
                "batch": element.batch,
                "vertex_start": vertex_start,
                "vertex_count": len(element.vertices),
                "triangle_start": index_start // 3,
                "triangle_count": element.faces.size // 3,
                "bbox": [
                    *(_finite_list(element.world_min - origin)),
                    *(_finite_list(element.world_max - origin)),
                ],
                "base_color": list(element.base_color),
                "configured_color": list(configured_color),
                "display_color": list(display_color),
                "attributes": _jsonable(row.get("attributes", [])),
                "property_sets": _jsonable(row.get("property_sets", [])),
                "quantity_sets": _jsonable(row.get("quantity_sets", [])),
                "placement": _jsonable(row.get("placement")),
            }
        )

    metadata_elements.sort(key=lambda item: (item["batch"], item["triangle_start"]))
    batch_meta = {
        name: {
            "vertex_count": int(arrays.positions.shape[0]),
            "triangle_count": int(arrays.indices.size // 3),
        }
        for name, arrays in batches.items()
    }

    native_display_units = _display_units(units_doc or {})
    selected_display_units = display_units if display_units is not None else native_display_units
    model_meta = {
        "schema": _optional_string(geometry_doc.get("schema"))
        or _optional_string(entity_doc.get("schema")),
        "quality": quality,
        "element_count": len(metadata_elements),
        "entity_count": int(entity_doc.get("entity_count", len(entity_rows))),
        "world_origin": _finite_list(origin),
        "world_bbox": [*_finite_list(world_min), *_finite_list(world_max)],
        "local_bbox": [
            *_finite_list(world_min - origin),
            *_finite_list(world_max - origin),
        ],
        "units": str(geometry_doc.get("units") or "m"),
        "display_units": {
            str(unit_type).upper(): str(symbol)
            for unit_type, symbol in selected_display_units.items()
        },
        "up_axis": str(geometry_doc.get("up_axis") or "Z"),
        "length_unit_scale": _finite_number(entity_doc.get("length_unit_scale")),
        "plane_angle_to_radians": _finite_number(entity_doc.get("plane_angle_to_radians")),
        "project_id": entity_doc.get("project_id"),
        "has_georeference": bool((georeferencing_doc or {}).get("has_georeference", False)),
        "crs_name": _optional_string(
            ((georeferencing_doc or {}).get("projected_crs") or {}).get("name")
            if isinstance((georeferencing_doc or {}).get("projected_crs"), Mapping)
            else None
        ),
    }
    metadata = {
        "format": "ifx",
        "version": 1,
        "model": model_meta,
        "batches": batch_meta,
        "elements": metadata_elements,
        "spatial": _jsonable(spatial_doc or {}),
        "openings": _jsonable(openings_doc or {}),
        "classifications": _jsonable(classifications_doc or {}),
        "documents": _jsonable(documents_doc or {}),
        "groups": _jsonable(groups_doc or {}),
        "connections": _jsonable(connections_doc or {}),
        "georeferencing": _jsonable(georeferencing_doc or {}),
        "units": _jsonable(units_doc or {}),
        "references": _build_reference_index(
            spatial_doc or {},
            relationships_doc or {},
            classifications_doc or {},
            documents_doc or {},
            groups_doc or {},
            connections_doc or {},
            materials_doc or {},
            entity_rows,
            {int(element["id"]) for element in metadata_elements},
        ),
    }

    sections = {
        "opaque_positions": batches["opaque"].positions,
        "opaque_normals": batches["opaque"].normals,
        "opaque_colors": batches["opaque"].colors,
        "opaque_indices": batches["opaque"].indices,
        "transparent_positions": batches["transparent"].positions,
        "transparent_normals": batches["transparent"].normals,
        "transparent_colors": batches["transparent"].colors,
        "transparent_indices": batches["transparent"].indices,
    }
    raw = pack_container(metadata, sections)
    compressed = gzip.compress(raw, compresslevel=compression_level, mtime=0)
    return PreparedPayload(compressed=compressed, raw_size=len(raw), metadata=metadata)


def _display_units(units_doc: Mapping[str, Any]) -> dict[str, str]:
    by_type = units_doc.get("by_type", {})
    if not isinstance(by_type, Mapping):
        return {}
    result: dict[str, str] = {}
    for raw_unit_type, raw_unit in by_type.items():
        if not isinstance(raw_unit, Mapping):
            continue
        symbol = _optional_string(raw_unit.get("symbol"))
        if symbol:
            result[str(raw_unit_type).upper()] = symbol
    return result


def restyle_payload(
    prepared: PreparedPayload,
    *,
    initial_colors: Mapping[int, str | Sequence[int | float]] | None = None,
    hidden_ids: Iterable[int] = (),
    compression_level: int = 6,
) -> PreparedPayload:
    """Apply colors and visibility without rerunning IFC tessellation.

    The base payload keeps each occurrence in the opaque or transparent batch
    selected from its IFC appearance. User colors are written directly into the
    existing vertex-color buffers. Semi-transparent colors on an opaque
    occurrence are rendered through Three.js alpha hashing, which avoids a full
    geometry rebuild while retaining two draw calls for the complete model.
    """

    if not isinstance(prepared, PreparedPayload):
        raise TypeError("prepared must be a PreparedPayload")
    if not 0 <= compression_level <= 9:
        raise ValueError("compression_level must be between 0 and 9")

    try:
        raw = gzip.decompress(prepared.compressed)
    except (OSError, EOFError) as exc:
        raise ViewerBuildError("the prepared viewer payload is not valid gzip data") from exc

    metadata, packed_sections = _unpack_container(raw)
    sections: dict[str, bytes | bytearray] = dict(packed_sections)
    elements = metadata.get("elements")
    if not isinstance(elements, list):
        raise ViewerBuildError("viewer metadata does not contain an element list")

    hidden = {int(value) for value in hidden_ids}
    overrides = {
        int(express_id): _parse_color(color) for express_id, color in (initial_colors or {}).items()
    }

    color_arrays: dict[str, np.ndarray] = {}
    for batch in ("opaque", "transparent"):
        name = f"{batch}_colors"
        writable = bytearray(sections[name])
        sections[name] = writable
        color_arrays[batch] = np.frombuffer(writable, dtype=np.uint8).reshape((-1, 4))

    for element in elements:
        if not isinstance(element, dict):
            continue
        express_id = int(element.get("id"))
        base_color = _parse_color(element.get("base_color", (184, 188, 199, 255)))
        configured_color = overrides.get(express_id, base_color)
        display_color = (*configured_color[:3], 0) if express_id in hidden else configured_color

        batch_name = str(element.get("batch") or "opaque")
        colors = color_arrays.get(batch_name)
        if colors is None:
            raise ViewerBuildError(f"element #{express_id} references unknown batch {batch_name!r}")
        vertex_start = int(element.get("vertex_start", 0))
        vertex_count = int(element.get("vertex_count", 0))
        vertex_end = vertex_start + vertex_count
        if vertex_start < 0 or vertex_count < 0 or vertex_end > len(colors):
            raise ViewerBuildError(f"element #{express_id} has an invalid vertex-color range")
        colors[vertex_start:vertex_end] = np.asarray(display_color, dtype=np.uint8)
        element["configured_color"] = list(configured_color)
        element["display_color"] = list(display_color)

    immutable_sections = {name: bytes(value) for name, value in sections.items()}
    styled_raw = pack_container(metadata, immutable_sections)
    compressed = gzip.compress(styled_raw, compresslevel=compression_level, mtime=0)
    return PreparedPayload(
        compressed=compressed,
        raw_size=len(styled_raw),
        metadata=metadata,
    )


def _unpack_container(raw: bytes) -> tuple[dict[str, Any], dict[str, bytes]]:
    """Decode an IFCVIEW1 container into JSON metadata and raw sections."""

    if len(raw) < 12 or raw[:8] != MAGIC:
        raise ViewerBuildError("the prepared viewer payload has an unknown format")
    metadata_length = struct.unpack_from("<I", raw, 8)[0]
    offset = 12
    metadata_end = offset + metadata_length
    if metadata_end > len(raw):
        raise ViewerBuildError("the prepared viewer payload has truncated metadata")
    try:
        metadata = json.loads(raw[offset:metadata_end].decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ViewerBuildError("the prepared viewer metadata is invalid") from exc
    if not isinstance(metadata, dict):
        raise ViewerBuildError("the prepared viewer metadata must be an object")

    offset = (metadata_end + 3) & ~3
    sections: dict[str, bytes] = {}
    for name in SECTION_ORDER:
        if offset + 4 > len(raw):
            raise ViewerBuildError(f"viewer section {name!r} is missing")
        length = struct.unpack_from("<I", raw, offset)[0]
        offset += 4
        end = offset + length
        if end > len(raw):
            raise ViewerBuildError(f"viewer section {name!r} is truncated")
        sections[name] = raw[offset:end]
        offset = (end + 3) & ~3
    return metadata, sections


def pack_container(
    metadata: Mapping[str, Any], sections: Mapping[str, np.ndarray | bytes]
) -> bytes:
    """Pack metadata and typed-array sections into the IFCVIEW1 container."""

    metadata_bytes = json.dumps(
        _jsonable(metadata),
        ensure_ascii=False,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")
    if len(metadata_bytes) > 0xFFFFFFFF:
        raise ViewerBuildError("viewer metadata exceeds the 4 GiB container limit")

    out = bytearray(MAGIC)
    out.extend(struct.pack("<I", len(metadata_bytes)))
    out.extend(metadata_bytes)
    _pad4(out)

    for name in SECTION_ORDER:
        value = sections.get(name, b"")
        if isinstance(value, np.ndarray):
            payload = value.tobytes(order="C")
        elif isinstance(value, bytes):
            payload = value
        else:
            raise TypeError(f"section {name!r} must be a NumPy array or bytes")
        if len(payload) > 0xFFFFFFFF:
            raise ViewerBuildError(f"section {name!r} exceeds the 4 GiB container limit")
        out.extend(struct.pack("<I", len(payload)))
        out.extend(payload)
        _pad4(out)
    return bytes(out)


def _allocate_batch(vertex_count: int, index_count: int) -> _BatchArrays:
    return _BatchArrays(
        positions=np.empty((vertex_count, 3), dtype="<f4"),
        normals=np.empty((vertex_count, 3), dtype="<f4"),
        colors=np.empty((vertex_count, 4), dtype=np.uint8),
        indices=np.empty(index_count, dtype="<u4"),
    )


def _decode_vertices(raw: Any, express_id: int) -> np.ndarray:
    if not isinstance(raw, (bytes, bytearray, memoryview)):
        raise ViewerBuildError(f"element #{express_id} has no binary vertex buffer")
    values = np.frombuffer(raw, dtype="<f8")
    if values.size % 3:
        raise ViewerBuildError(f"element #{express_id} has a malformed vertex buffer")
    if not np.all(np.isfinite(values)):
        raise ViewerBuildError(f"element #{express_id} contains non-finite vertices")
    return values.reshape((-1, 3))


def _decode_faces(raw: Any, express_id: int) -> np.ndarray:
    if not isinstance(raw, (bytes, bytearray, memoryview)):
        raise ViewerBuildError(f"element #{express_id} has no binary face buffer")
    values = np.frombuffer(raw, dtype="<u4")
    if values.size % 3:
        raise ViewerBuildError(f"element #{express_id} has a malformed face buffer")
    return values.reshape((-1, 3))


def _compute_vertex_normals(vertices: np.ndarray, faces: np.ndarray) -> np.ndarray:
    """Compute smooth vertex normals in bounded-memory triangle chunks."""

    normals = np.zeros(vertices.shape, dtype=np.float32)
    chunk_size = 250_000
    for start in range(0, len(faces), chunk_size):
        tri = faces[start : start + chunk_size]
        p0 = vertices[tri[:, 0]]
        p1 = vertices[tri[:, 1]]
        p2 = vertices[tri[:, 2]]
        face_normals = np.cross(p1 - p0, p2 - p0)
        np.add.at(normals, tri[:, 0], face_normals)
        np.add.at(normals, tri[:, 1], face_normals)
        np.add.at(normals, tri[:, 2], face_normals)

    lengths = np.linalg.norm(normals, axis=1)
    valid = lengths > 1e-20
    normals[valid] /= lengths[valid, None]
    normals[~valid] = (0.0, 0.0, 1.0)
    return normals


def _parse_color(value: Any) -> tuple[int, int, int, int]:
    if isinstance(value, str):
        text = value.strip()
        if not text.startswith("#"):
            raise ValueError(f"unsupported color {value!r}; use a hex color")
        hex_value = text[1:]
        if len(hex_value) in {3, 4}:
            hex_value = "".join(ch * 2 for ch in hex_value)
        if len(hex_value) == 6:
            hex_value += "ff"
        if len(hex_value) != 8:
            raise ValueError(f"unsupported color {value!r}; use #RGB, #RRGGBB, or #RRGGBBAA")
        try:
            red, green, blue, alpha = (int(hex_value[i : i + 2], 16) for i in range(0, 8, 2))
            return red, green, blue, alpha
        except ValueError as exc:
            raise ValueError(f"invalid hex color {value!r}") from exc

    if isinstance(value, np.ndarray):
        values = value.tolist()
    elif isinstance(value, Sequence) and not isinstance(value, (bytes, bytearray)):
        values = list(value)
    else:
        raise ValueError(f"unsupported color value: {value!r}")

    if len(values) not in {3, 4}:
        raise ValueError("a color sequence must contain three or four channels")
    if len(values) == 3:
        values.append(1.0 if any(isinstance(v, float) for v in values) else 255)

    numeric = [float(channel) for channel in values]
    if not all(math.isfinite(channel) for channel in numeric):
        raise ValueError("color channels must be finite numbers")

    # Accept both normalized RGBA and byte-style RGBA. For a mixed value such
    # as ``(255, 0, 0, 0.5)``, RGB stays byte-scaled while alpha is interpreted
    # as normalized. This matches common Python plotting APIs.
    if all(0.0 <= channel <= 1.0 for channel in numeric):
        numeric = [channel * 255.0 for channel in numeric]
    elif len(numeric) == 4 and 0.0 <= numeric[3] <= 1.0:
        numeric[3] *= 255.0

    channels = [int(round(min(255.0, max(0.0, channel)))) for channel in numeric]
    return channels[0], channels[1], channels[2], channels[3]


def _build_reference_index(
    spatial_doc: Mapping[str, Any],
    relationships_doc: Mapping[str, Any],
    classifications_doc: Mapping[str, Any],
    documents_doc: Mapping[str, Any],
    groups_doc: Mapping[str, Any],
    connections_doc: Mapping[str, Any],
    materials_doc: Mapping[str, Any],
    entity_rows: Mapping[Any, Any],
    element_ids: set[int],
) -> dict[str, Any]:
    """Compact ifx-core references for fast per-element browser lookup."""

    elements: dict[str, dict[str, Any]] = {}

    def element_reference(express_id: int) -> dict[str, Any]:
        return elements.setdefault(str(express_id), {})

    spatial_nodes: dict[str, dict[str, Any]] = {}
    stack = list(spatial_doc.get("roots", []))
    while stack:
        raw_node = stack.pop()
        if not isinstance(raw_node, Mapping):
            continue
        express_id = _int_or_none(raw_node.get("express_id"))
        if express_id is not None:
            spatial_nodes[str(express_id)] = {
                "id": express_id,
                "ifc_type": _optional_string(raw_node.get("ifc_type")),
                "name": _optional_string(raw_node.get("name")),
            }
        children = raw_node.get("children", [])
        if isinstance(children, Sequence) and not isinstance(children, (str, bytes)):
            stack.extend(children)

    for output_key, source_key in (
        ("container_id", "element_to_container"),
        ("storey_id", "element_to_storey"),
    ):
        source = spatial_doc.get(source_key, {})
        if not isinstance(source, Mapping):
            continue
        for raw_element_id, raw_spatial_id in source.items():
            element_id = _int_or_none(raw_element_id)
            spatial_id = _int_or_none(raw_spatial_id)
            if element_id in element_ids and spatial_id is not None:
                element_reference(element_id)[output_key] = spatial_id

    referenced = spatial_doc.get("referenced_by_structure", {})
    if isinstance(referenced, Mapping):
        for raw_structure_id, raw_element_ids in referenced.items():
            structure_id = _int_or_none(raw_structure_id)
            if structure_id is None or not isinstance(raw_element_ids, Sequence):
                continue
            for raw_element_id in raw_element_ids:
                element_id = _int_or_none(raw_element_id)
                if element_id in element_ids:
                    element_reference(element_id).setdefault("referenced_by_structure", []).append(
                        structure_id
                    )

    relationship_target_ids: set[int] = set()
    edges = relationships_doc.get("edges", [])
    if isinstance(edges, Sequence) and not isinstance(edges, (str, bytes)):
        for raw_edge in edges:
            if not isinstance(raw_edge, Mapping):
                continue
            related_id = _int_or_none(raw_edge.get("related_id"))
            relating_id = _int_or_none(raw_edge.get("relating_id"))
            relationship_id = _int_or_none(raw_edge.get("relationship_id"))
            relationship_type = _optional_string(raw_edge.get("relationship_type"))
            if relationship_type in {
                "IfcRelAssociatesMaterial",
                "IfcRelAssociatesClassification",
                "IfcRelAssociatesDocument",
                "IfcRelContainedInSpatialStructure",
            }:
                continue
            if related_id in element_ids:
                if relating_id is not None:
                    relationship_target_ids.add(relating_id)
                element_reference(related_id).setdefault("relationships", []).append(
                    {
                        "relationship_id": relationship_id,
                        "relationship_type": relationship_type,
                        "role": "related",
                        "target_id": relating_id,
                    }
                )
            if relating_id in element_ids:
                if related_id is not None:
                    relationship_target_ids.add(related_id)
                element_reference(relating_id).setdefault("relationships", []).append(
                    {
                        "relationship_id": relationship_id,
                        "relationship_type": relationship_type,
                        "role": "relating",
                        "target_id": related_id,
                    }
                )

    referenced_entities: dict[str, Any] = {}
    for target_id in relationship_target_ids - element_ids:
        row = entity_rows.get(target_id)
        if row is None:
            row = entity_rows.get(str(target_id))
        if not isinstance(row, Mapping):
            continue
        referenced_entities[str(target_id)] = {
            "id": target_id,
            "ifc_type": _optional_string(row.get("ifc_type")),
            "name": _optional_string(row.get("name")),
            "object_type": _optional_string(row.get("object_type")),
        }

    used_classification_ids = _attach_assignments(
        classifications_doc.get("element_classifications", {}),
        "classifications",
        elements,
        element_ids,
        include_embedded=False,
    )
    classification_references = _select_definitions(
        classifications_doc.get("references", {}), used_classification_ids
    )
    classification_systems = _select_definitions(
        classifications_doc.get("systems", {}), used_classification_ids
    )

    used_document_ids = _attach_assignments(
        documents_doc.get("element_documents", {}),
        "documents",
        elements,
        element_ids,
        include_embedded=False,
    )
    document_definitions = _select_definitions(
        documents_doc.get("definitions", {}), used_document_ids
    )

    used_group_ids: set[int] = set()
    raw_groups_by_object = groups_doc.get("groups_by_object", {})
    if isinstance(raw_groups_by_object, Mapping):
        for raw_element_id, raw_memberships in raw_groups_by_object.items():
            element_id = _int_or_none(raw_element_id)
            if element_id not in element_ids or not isinstance(raw_memberships, Sequence):
                continue
            memberships = []
            for raw_membership in raw_memberships:
                if not isinstance(raw_membership, Mapping):
                    continue
                group_id = _int_or_none(raw_membership.get("group_id"))
                if group_id is None:
                    continue
                used_group_ids.add(group_id)
                memberships.append(
                    {
                        "relationship_id": _int_or_none(raw_membership.get("relationship_id")),
                        "group_id": group_id,
                        "factor": _finite_number(raw_membership.get("factor")),
                    }
                )
            if memberships:
                element_reference(element_id)["groups"] = memberships
    group_definitions = _select_definitions(groups_doc.get("definitions", {}), used_group_ids)

    element_connections_by_id = _rows_by_id(
        connections_doc.get("element_connections", []), "relationship_id"
    )
    _attach_indexed_rows(
        connections_doc.get("connections_by_element", {}),
        "connections",
        element_connections_by_id,
        elements,
        element_ids,
    )
    space_boundaries_by_id = _rows_by_id(
        connections_doc.get("space_boundaries", []), "relationship_id"
    )
    _attach_indexed_rows(
        connections_doc.get("boundaries_by_element", {}),
        "space_boundaries",
        space_boundaries_by_id,
        elements,
        element_ids,
    )
    _attach_indexed_rows(
        connections_doc.get("boundaries_by_space", {}),
        "space_boundaries",
        space_boundaries_by_id,
        elements,
        element_ids,
    )
    used_port_ids: set[int] = set()
    raw_ports_by_element = connections_doc.get("ports_by_element", {})
    connected_ports = connections_doc.get("connected_ports", {})
    if isinstance(raw_ports_by_element, Mapping):
        for raw_element_id, raw_port_ids in raw_ports_by_element.items():
            element_id = _int_or_none(raw_element_id)
            if element_id not in element_ids or not isinstance(raw_port_ids, Sequence):
                continue
            port_rows = []
            for raw_port_id in raw_port_ids:
                port_id = _int_or_none(raw_port_id)
                if port_id is None:
                    continue
                used_port_ids.add(port_id)
                linked = []
                if isinstance(connected_ports, Mapping):
                    linked = connected_ports.get(port_id, connected_ports.get(str(port_id), []))
                linked_ids = (
                    [
                        value
                        for raw_value in linked
                        if (value := _int_or_none(raw_value)) is not None
                    ]
                    if isinstance(linked, Sequence)
                    else []
                )
                used_port_ids.update(linked_ids)
                port_rows.append({"port_id": port_id, "connected_ports": linked_ids})
            if port_rows:
                element_reference(element_id)["ports"] = port_rows
    port_definitions = _select_definitions(connections_doc.get("ports", {}), used_port_ids)

    used_material_ids: set[int] = set()
    element_materials = materials_doc.get("element_materials", {})
    if isinstance(element_materials, Mapping):
        for raw_element_id, raw_assignments in element_materials.items():
            element_id = _int_or_none(raw_element_id)
            if element_id not in element_ids or not isinstance(raw_assignments, Sequence):
                continue
            assignments = []
            for raw_assignment in raw_assignments:
                if not isinstance(raw_assignment, Mapping):
                    continue
                definition_id = _int_or_none(raw_assignment.get("definition_id"))
                if definition_id is None:
                    continue
                used_material_ids.add(definition_id)
                assignments.append(
                    {
                        "definition_id": definition_id,
                        "inherited_from_type": _int_or_none(
                            raw_assignment.get("inherited_from_type")
                        ),
                    }
                )
            if assignments:
                element_reference(element_id)["materials"] = assignments

    definitions: dict[str, Any] = {}
    raw_definitions = materials_doc.get("definitions", {})
    if isinstance(raw_definitions, Mapping):
        for definition_id in used_material_ids:
            definition = raw_definitions.get(definition_id)
            if definition is None:
                definition = raw_definitions.get(str(definition_id))
            if isinstance(definition, Mapping):
                definitions[str(definition_id)] = _jsonable(definition)

    return {
        "elements": elements,
        "spatial_nodes": spatial_nodes,
        "referenced_entities": referenced_entities,
        "material_definitions": definitions,
        "classification_references": classification_references,
        "classification_systems": classification_systems,
        "document_definitions": document_definitions,
        "group_definitions": group_definitions,
        "port_definitions": port_definitions,
    }


def _attach_assignments(
    raw_by_element: Any,
    output_key: str,
    elements: dict[str, dict[str, Any]],
    element_ids: set[int],
    *,
    include_embedded: bool,
) -> set[int]:
    used_ids: set[int] = set()
    if not isinstance(raw_by_element, Mapping):
        return used_ids
    for raw_element_id, raw_assignments in raw_by_element.items():
        element_id = _int_or_none(raw_element_id)
        if element_id not in element_ids or not isinstance(raw_assignments, Sequence):
            continue
        assignments = []
        for raw_assignment in raw_assignments:
            if not isinstance(raw_assignment, Mapping):
                continue
            definition_id = _int_or_none(
                raw_assignment.get("classification_id", raw_assignment.get("definition_id"))
            )
            if definition_id is None:
                continue
            used_ids.add(definition_id)
            assignment = {
                "definition_id": definition_id,
                "inherited_from_type": _int_or_none(raw_assignment.get("inherited_from_type")),
            }
            if include_embedded and isinstance(raw_assignment.get("document"), Mapping):
                assignment["document"] = _jsonable(raw_assignment["document"])
            assignments.append(assignment)
        if assignments:
            elements.setdefault(str(element_id), {})[output_key] = assignments
    return used_ids


def _select_definitions(raw_definitions: Any, used_ids: set[int]) -> dict[str, Any]:
    selected: dict[str, Any] = {}
    if not isinstance(raw_definitions, Mapping):
        return selected
    for definition_id in used_ids:
        definition = raw_definitions.get(definition_id)
        if definition is None:
            definition = raw_definitions.get(str(definition_id))
        if isinstance(definition, Mapping):
            selected[str(definition_id)] = _jsonable(definition)
    return selected


def _rows_by_id(raw_rows: Any, key: str) -> dict[int, Mapping[str, Any]]:
    output: dict[int, Mapping[str, Any]] = {}
    if not isinstance(raw_rows, Sequence) or isinstance(raw_rows, (str, bytes)):
        return output
    for row in raw_rows:
        if not isinstance(row, Mapping):
            continue
        row_id = _int_or_none(row.get(key))
        if row_id is not None:
            output[row_id] = row
    return output


def _attach_indexed_rows(
    raw_index: Any,
    output_key: str,
    rows_by_id: Mapping[int, Mapping[str, Any]],
    elements: dict[str, dict[str, Any]],
    element_ids: set[int],
) -> None:
    if not isinstance(raw_index, Mapping):
        return
    for raw_element_id, raw_row_ids in raw_index.items():
        element_id = _int_or_none(raw_element_id)
        if element_id not in element_ids or not isinstance(raw_row_ids, Sequence):
            continue
        rows = []
        existing_ids: set[int] = set()
        current = elements.setdefault(str(element_id), {}).get(output_key, [])
        if isinstance(current, list):
            rows.extend(current)
            existing_ids.update(
                row_id
                for row in current
                if isinstance(row, Mapping)
                and (row_id := _int_or_none(row.get("relationship_id"))) is not None
            )
        for raw_row_id in raw_row_ids:
            row_id = _int_or_none(raw_row_id)
            if row_id is None:
                continue
            row = rows_by_id.get(row_id)
            if row is not None and row_id not in existing_ids:
                rows.append(_jsonable(row))
                existing_ids.add(row_id)
        if rows:
            elements[str(element_id)][output_key] = rows


def _int_or_none(value: Any) -> int | None:
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _optional_string(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value)
    return text if text else None


def _finite_list(value: Any) -> list[float]:
    array = np.asarray(value, dtype=np.float64).reshape(-1)
    if not np.all(np.isfinite(array)):
        raise ViewerBuildError("model bounds contain non-finite numbers")
    return [float(item) for item in array]


def _finite_number(value: Any) -> float | None:
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _jsonable(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, bool)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, np.generic):
        return _jsonable(value.item())
    if isinstance(value, np.ndarray):
        return _jsonable(value.tolist())
    if isinstance(value, Mapping):
        return {str(key): _jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_jsonable(item) for item in value]
    return str(value)


def _pad4(buffer: bytearray) -> None:
    remainder = len(buffer) % 4
    if remainder:
        buffer.extend(b"\0" * (4 - remainder))
