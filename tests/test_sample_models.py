from urllib.parse import quote
from urllib.request import urlopen

import pytest

from ifx import IFCViewer

RAW_MODEL_ROOT = (
    "https://raw.githubusercontent.com/viktor-platform/ifc-sample-models/main/sample-models"
)
MODEL_NAMES = (
    "BuildingBIMModel.ifc",
    "SampleBimModelWebinar.ifc",
    "SampleBuilding.ifc",
    "SampleStructuralModel.ifc",
    "Structure Walls.ifc",
)


@pytest.mark.integration
@pytest.mark.parametrize("model_name", MODEL_NAMES)
def test_viktor_sample_model_builds_viewer_payload(model_name: str):
    model_url = f"{RAW_MODEL_ROOT}/{quote(model_name)}"
    with urlopen(model_url, timeout=60) as response:
        model_bytes = response.read()

    viewer = IFCViewer.from_bytes(model_bytes, filename=model_name, quality="medium")

    assert viewer.element_count > 0
    assert viewer.vertex_count > 0
    assert viewer.triangle_count > 0
    assert viewer.compressed_payload_size > 0
    assert viewer.model_info["world_bbox"]
    assert viewer.units["by_type"]["LENGTHUNIT"]["symbol"]

    if model_name == "BuildingBIMModel.ifc":
        assert len(viewer.openings["voids"]) > 0
        assert len(viewer.openings["fills"]) > 0
