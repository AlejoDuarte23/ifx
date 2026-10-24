import urllib.request

from ifx.html import render_html
from ifx.server import start_viewer_server


def test_inline_html_uses_pinned_cdn_modules():
    page = render_html(
        title="Model <A>",
        payload=b"compressed-data",
        asset_mode="cdn",
    )
    assert "Model &lt;A&gt;" in page
    assert "three@0.185.1" in page
    assert "three-mesh-bvh@0.9.14" in page
    assert "ifx-payload" in page
    assert "Y29tcHJlc3NlZC1kYXRh" in page
    assert 'data-action="toggle-double-side"' not in page
    assert "__IFX_VIEWER_CONFIG__" in page
    assert 'data-context-action="hide-selected"' in page
    assert 'data-action="toggle-model"' in page
    assert 'id="ifx-model-tree"' in page
    assert 'id="ifx-panel" class="viewer-panel"' in page
    assert 'aria-label="IFC properties" aria-hidden="true"' in page


def test_local_server_serves_html_and_payload():
    token = "test-token"
    page = render_html(
        title="Test",
        payload_url=f"/{token}/model.ifcv.gz",
        asset_mode="cdn",
    )
    handle = start_viewer_server(
        html=page,
        payload=b"abc123",
        token=token,
        open_browser=False,
    )
    try:
        with urllib.request.urlopen(handle.url, timeout=3) as response:
            assert response.status == 200
            assert b"IFC model viewer" in response.read()
        with urllib.request.urlopen(f"{handle.url}model.ifcv.gz", timeout=3) as response:
            assert response.read() == b"abc123"
    finally:
        handle.close()


def test_inline_config_escapes_uploaded_filename_script_content():
    page = render_html(
        title="model</script><script>alert(1)</script>.ifc",
        payload=b"data",
        asset_mode="cdn",
    )
    assert "model&lt;/script&gt;" in page
    assert "model\\u003c/script\\u003e" in page
    assert "<script>alert(1)</script>.ifc" not in page
