import secrets
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Sequence

from .html import AssetMode, render_html
from .payload import PreparedPayload, build_payload, build_payload_from_documents, restyle_payload
from .server import ViewerHandle, start_viewer_server

ColorValue = str | Sequence[int | float]
SourceValue = str | Path | bytes | bytearray | memoryview


class IFCViewer:
    """Prepare an IFC model and expose it as HTML or a local browser viewer.

    Parameters
    ----------
    source:
        IFC path or raw IFC bytes.
    quality:
        IFX tessellation quality: ``lowest``, ``low``, ``medium``, ``high``,
        or ``highest``.
    title:
        Browser page title and viewer label.
    include_properties:
        Include property and quantity sets in the browser panel.
    inherit_type_properties:
        Include property and quantity sets inherited from IFC type objects.
    include_attributes:
        Include schema-declared entity attributes.
    include_placements:
        Include resolved 4×4 object placements in the property payload.
    """

    def __init__(
        self,
        source: SourceValue,
        *,
        quality: str = "medium",
        title: str | None = None,
        include_properties: bool = True,
        inherit_type_properties: bool = True,
        include_attributes: bool = True,
        include_placements: bool = False,
        compression_level: int = 6,
    ) -> None:
        self._source = source
        self.quality = quality
        self.title = title or self._default_title(source)
        self.include_properties = bool(include_properties)
        self.inherit_type_properties = bool(inherit_type_properties)
        self.include_attributes = bool(include_attributes)
        self.include_placements = bool(include_placements)
        self.compression_level = int(compression_level)
        if not 0 <= self.compression_level <= 9:
            raise ValueError("compression_level must be between 0 and 9")
        self._ifc_bytes: bytes | None = None
        self._base_prepared: PreparedPayload | None = None
        self._prepared: PreparedPayload | None = None
        self._initial_colors: dict[int, ColorValue] = {}
        self._hidden_ids: set[int] = set()

    @classmethod
    def from_bytes(
        cls,
        ifc_bytes: bytes | bytearray | memoryview,
        *,
        filename: str = "model.ifc",
        **kwargs: Any,
    ) -> "IFCViewer":
        """Create a viewer from uploaded bytes while keeping a useful title."""

        kwargs.setdefault("title", filename)
        return cls(bytes(ifc_bytes), **kwargs)

    @classmethod
    def from_extraction(
        cls, extraction: Mapping[str, Any], *, title: str = "IFC model", quality: str = "medium"
    ) -> "IFCViewer":
        viewer = cls(b"", title=title, quality=quality)
        model = extraction["model"]
        names = (
            "spatial",
            "relationships",
            "openings",
            "classifications",
            "documents",
            "groups",
            "connections",
            "georeferencing",
            "materials",
            "units",
        )
        viewer._base_prepared = build_payload_from_documents(
            dict(extraction["geometry"], schema=model.get("schema")),
            extraction["entities"],
            quality=quality,
            **{f"{name}_doc": model.get(name) for name in names},
        )
        return viewer

    @property
    def model_info(self) -> Mapping[str, Any]:
        """Summary metadata; preparing the model on first access."""

        return self._prepare_base().metadata["model"]

    @property
    def spatial(self) -> Mapping[str, Any]:
        """IFC project, site, building, storey, and containment relationships."""

        return self._prepare_base().metadata.get("spatial", {})

    @property
    def references(self) -> Mapping[str, Any]:
        """Compact spatial, type, aggregate, nesting, and material references."""

        return self._prepare_base().metadata.get("references", {})

    @property
    def openings(self) -> Mapping[str, Any]:
        """Host/opening/filling relationships and reverse indexes."""

        return self._prepare_base().metadata.get("openings", {})

    @property
    def classifications(self) -> Mapping[str, Any]:
        """Classification systems, references, and occurrence/type assignments."""

        return self._prepare_base().metadata.get("classifications", {})

    @property
    def documents(self) -> Mapping[str, Any]:
        """IFC document definitions and occurrence/type assignments."""

        return self._prepare_base().metadata.get("documents", {})

    @property
    def groups(self) -> Mapping[str, Any]:
        """IFC groups, zones, systems, memberships, and product assignments."""

        return self._prepare_base().metadata.get("groups", {})

    @property
    def connections(self) -> Mapping[str, Any]:
        """Element, port, and space-boundary connection data."""

        return self._prepare_base().metadata.get("connections", {})

    @property
    def georeferencing(self) -> Mapping[str, Any]:
        """Projected CRS, map conversion, and local-to-world transform metadata."""

        return self._prepare_base().metadata.get("georeferencing", {})

    @property
    def units(self) -> Mapping[str, Any]:
        """Resolved IFC project units keyed by IFC unit type."""

        return self._prepare_base().metadata.get("units", {})

    def element_references(self, express_id: int) -> Mapping[str, Any]:
        """Return the decoded ifx-core references for one rendered element."""

        target = str(int(express_id))
        references = self.references.get("elements", {})
        if isinstance(references, Mapping) and target in references:
            value = references[target]
            return value if isinstance(value, Mapping) else {}
        raise KeyError(f"no references for STEP id: {express_id}")

    @property
    def element_count(self) -> int:
        return len(self._prepare_base().metadata["elements"])

    @property
    def vertex_count(self) -> int:
        return sum(
            int(batch.get("vertex_count", 0))
            for batch in self._prepare_base().metadata.get("batches", {}).values()
        )

    @property
    def triangle_count(self) -> int:
        return sum(
            int(batch.get("triangle_count", 0))
            for batch in self._prepare_base().metadata.get("batches", {}).values()
        )

    @property
    def step_ids(self) -> tuple[int, ...]:
        return tuple(int(element["id"]) for element in self._prepare_base().metadata["elements"])

    @property
    def compressed_payload_size(self) -> int:
        return self._prepare().compressed_size

    def element(self, express_id: int) -> Mapping[str, Any]:
        """Return one decoded occurrence record by IFC STEP id."""

        target = int(express_id)
        for element in self._prepare_base().metadata["elements"]:
            if int(element["id"]) == target:
                return element
        raise KeyError(f"unknown STEP id: {express_id}")

    def find(
        self,
        *,
        ifc_type: str | Sequence[str] | None = None,
        name_contains: str | None = None,
        predicate: Callable[[Mapping[str, Any]], bool] | None = None,
    ) -> list[int]:
        """Return STEP ids matching type, text, or an application predicate."""

        if ifc_type is None:
            allowed_types: set[str] | None = None
        elif isinstance(ifc_type, str):
            allowed_types = {ifc_type.casefold()}
        else:
            allowed_types = {value.casefold() for value in ifc_type}
        needle = name_contains.casefold() if name_contains else None

        matches: list[int] = []
        for element in self._prepare_base().metadata["elements"]:
            if (
                allowed_types is not None
                and str(element.get("ifc_type", "")).casefold() not in allowed_types
            ):
                continue
            if needle is not None:
                searchable = " ".join(
                    str(element.get(key) or "")
                    for key in ("name", "global_id", "ifc_type", "id", "object_type")
                ).casefold()
                if needle not in searchable:
                    continue
            if predicate is not None and not predicate(element):
                continue
            matches.append(int(element["id"]))
        return matches

    def set_color(self, express_ids: int | Iterable[int], color: ColorValue) -> "IFCViewer":
        """Set initial element colors before generating HTML."""

        for express_id in _normalise_ids(express_ids):
            self._initial_colors[express_id] = color
        self._invalidate()
        return self

    def color_by_type(self, ifc_type: str | Sequence[str], color: ColorValue) -> "IFCViewer":
        return self.set_color(self.find(ifc_type=ifc_type), color)

    def reset_colors(self, express_ids: int | Iterable[int] | None = None) -> "IFCViewer":
        if express_ids is None:
            self._initial_colors.clear()
        else:
            for express_id in _normalise_ids(express_ids):
                self._initial_colors.pop(express_id, None)
        self._invalidate()
        return self

    reset_color = reset_colors

    def hide(self, express_ids: int | Iterable[int]) -> "IFCViewer":
        self._hidden_ids.update(_normalise_ids(express_ids))
        self._invalidate()
        return self

    def show(self, express_ids: int | Iterable[int]) -> "IFCViewer":
        self._hidden_ids.difference_update(_normalise_ids(express_ids))
        self._invalidate()
        return self

    def isolate(self, express_ids: int | Iterable[int]) -> "IFCViewer":
        keep = set(_normalise_ids(express_ids))
        self._hidden_ids = set(self.step_ids) - keep
        self._invalidate()
        return self

    def show_all(self) -> "IFCViewer":
        self._hidden_ids.clear()
        self._invalidate()
        return self

    def to_html(self, *, asset_mode: AssetMode = "auto", module_script: str | None = None) -> str:
        """Return one HTML string with the compressed model embedded."""

        prepared = self._prepare()
        return render_html(
            title=self.title,
            payload=prepared.compressed,
            asset_mode=asset_mode,
            module_script=module_script,
        )

    def write_html(
        self,
        path: str | Path,
        *,
        asset_mode: AssetMode = "auto",
    ) -> Path:
        """Write a single-file viewer and return its absolute path."""

        output = Path(path).expanduser().resolve()
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(self.to_html(asset_mode=asset_mode), encoding="utf-8")
        return output

    save = write_html

    def view(
        self,
        *,
        port: int = 0,
        browser: str | None = None,
        open_browser: bool = True,
        block: bool = False,
        asset_mode: AssetMode = "auto",
    ) -> ViewerHandle:
        """Open the viewer with :mod:`webbrowser` and return a closeable handle.

        A localhost server is used instead of a ``file://`` URL. The compressed
        binary model is sent separately, avoiding the base64 overhead of
        :meth:`to_html` and making this the preferred local path for large files.
        """

        prepared = self._prepare()
        token = secrets.token_urlsafe(18)
        payload_url = f"/{token}/model.ifcv.gz"
        page = render_html(
            title=self.title,
            payload_url=payload_url,
            asset_mode=asset_mode,
        )
        handle = start_viewer_server(
            html=page,
            payload=prepared.compressed,
            token=token,
            port=port,
            browser=browser,
            open_browser=open_browser,
        )
        if block:
            handle.wait()
        return handle

    def viktor_result(self, *, asset_mode: AssetMode = "auto") -> Any:
        """Return ``viktor.WebResult`` without making VIKTOR a hard dependency."""

        try:
            import viktor as vkt  # ty: ignore[unresolved-import]
        except ImportError as exc:  # pragma: no cover - optional dependency
            raise ImportError(
                "VIKTOR support is optional. Install it in the application environment."
            ) from exc
        return vkt.WebResult(html=self.to_html(asset_mode=asset_mode))

    def _prepare_base(self) -> PreparedPayload:
        if self._base_prepared is None:
            self._base_prepared = build_payload(
                self._read_source(),
                quality=self.quality,
                include_properties=self.include_properties,
                inherit_type_properties=self.inherit_type_properties,
                include_attributes=self.include_attributes,
                include_placements=self.include_placements,
                compression_level=self.compression_level,
            )
        return self._base_prepared

    def _prepare(self) -> PreparedPayload:
        if self._prepared is None:
            base = self._prepare_base()
            if self._initial_colors or self._hidden_ids:
                self._prepared = restyle_payload(
                    base,
                    initial_colors=self._initial_colors,
                    hidden_ids=self._hidden_ids,
                    compression_level=self.compression_level,
                )
            else:
                self._prepared = base
        return self._prepared

    def _read_source(self) -> bytes:
        if self._ifc_bytes is not None:
            return self._ifc_bytes
        source = self._source
        if isinstance(source, bytes):
            data = source
        elif isinstance(source, (bytearray, memoryview)):
            data = bytes(source)
        else:
            path = Path(source).expanduser()
            if not path.is_file():
                raise FileNotFoundError(path)
            data = path.read_bytes()
        if not data:
            raise ValueError("the IFC source is empty")
        self._ifc_bytes = data
        return data

    def _invalidate(self) -> None:
        self._prepared = None

    @staticmethod
    def _default_title(source: object) -> str:
        if isinstance(source, (str, Path)):
            return Path(source).name
        return "IFC model"


def _normalise_ids(express_ids: int | Iterable[int]) -> tuple[int, ...]:
    if isinstance(express_ids, int):
        return (express_ids,)
    return tuple(int(value) for value in express_ids)
