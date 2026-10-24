import base64
import html
import json
from importlib import resources
from typing import Literal

AssetMode = Literal["auto", "bundle", "cdn"]

THREE_VERSION = "0.185.1"
BVH_VERSION = "0.9.14"


def render_html(
    *,
    title: str,
    payload: bytes | None = None,
    payload_url: str | None = None,
    asset_mode: AssetMode = "auto",
    module_script: str | None = None,
) -> str:
    """Render the complete viewer page.

    Exactly one of ``payload`` and ``payload_url`` must be supplied. Inline
    payloads make a single-file HTML document. URL payloads avoid base64 and
    are used by :meth:`IFCViewer.view`.
    """

    if (payload is None) == (payload_url is None):
        raise ValueError("provide exactly one of payload or payload_url")
    if asset_mode not in {"auto", "bundle", "cdn"}:
        raise ValueError("asset_mode must be 'auto', 'bundle', or 'cdn'")
    static_root = resources.files("ifx").joinpath("static")
    css = static_root.joinpath("viewer.css").read_text(encoding="utf-8")
    source_js = static_root.joinpath("viewer.js").read_text(encoding="utf-8")
    bundle_path = static_root.joinpath("viewer.bundle.js")
    has_bundle = bundle_path.is_file()

    resolved_mode: AssetMode
    if asset_mode == "auto":
        resolved_mode = "bundle" if has_bundle else "cdn"
    else:
        resolved_mode = asset_mode
    if resolved_mode == "bundle" and not has_bundle:
        raise RuntimeError(
            "the bundled frontend is missing; run `ifx-build-frontend` "
            "before building your wheel, or use asset_mode='cdn'"
        )

    if payload is not None:
        encoded = base64.b64encode(payload).decode("ascii")
        payload_markup = (
            f'<script id="ifx-payload" type="application/octet-stream">{encoded}</script>'
        )
        payload_config = {
            "mode": "inline",
            "elementId": "ifx-payload",
            "encoding": "gzip-base64",
        }
    else:
        payload_markup = ""
        payload_config = {"mode": "url", "url": payload_url, "encoding": "gzip"}

    config_json = json.dumps(
        {
            "title": title,
            "payload": payload_config,
            "assetMode": resolved_mode,
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )
    # The title can originate from an uploaded filename. Escape characters that
    # have special meaning inside an HTML script element before embedding JSON.
    config_json = (
        config_json.replace("&", "\\u0026")
        .replace("<", "\\u003c")
        .replace(">", "\\u003e")
        .replace("\u2028", "\\u2028")
        .replace("\u2029", "\\u2029")
    )

    if resolved_mode == "bundle":
        module_js = bundle_path.read_text(encoding="utf-8")
        import_map = ""
    else:
        module_js = source_js
        import_map = f"""
<script type="importmap">
{{
  "imports": {{
    "three": "https://cdn.jsdelivr.net/npm/three@{THREE_VERSION}/build/three.module.min.js",
    "three/addons/": "https://cdn.jsdelivr.net/npm/three@{THREE_VERSION}/examples/jsm/",
    "three-mesh-bvh": "https://cdn.jsdelivr.net/npm/three-mesh-bvh@{BVH_VERSION}/build/index.module.js"
  }}
}}
</script>"""

    # Avoid accidentally closing the inline module if a future dependency or
    # source comment contains that byte sequence.
    if module_script is not None:
        module_js = module_script
    safe_module_js = module_js.replace("</script", "<\\/script")
    safe_css = css.replace("</style", "<\\/style")
    page_title = html.escape(title, quote=True)

    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
  <meta name="color-scheme" content="light">
  <title>{page_title}</title>
  <style>{safe_css}</style>
  {import_map}
</head>
<body>
  <main id="ifx-root" aria-label="IFC model viewer">
    <canvas id="ifx-canvas"></canvas>
    <div class="viewer-toolbar" role="toolbar" aria-label="Viewer controls">
      <button type="button" data-action="fit" aria-label="Fit model" data-tooltip="Fit model">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H4a1 1 0 0 0-1 1v4M16 3h4a1 1 0 0 1 1 1v4M21 16v4a1 1 0 0 1-1 1h-4M8 21H4a1 1 0 0 1-1-1v-4"/></svg>
      </button>
      <button type="button" data-action="toggle-panel" aria-label="Toggle properties" data-tooltip="Properties" aria-pressed="false">
        <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="3" width="16" height="18" rx="1"/><path d="M8 8h8M8 12h2M13 12h3M8 16h2M13 16h3"/></svg>
      </button>
      <button type="button" data-action="toggle-model" aria-label="Toggle model tree" data-tooltip="Model" aria-pressed="false">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 4.5 4.5"/></svg>
      </button>
    </div>
    <div id="ifx-status" class="viewer-status" role="status">Preparing viewer…</div>
    <aside id="ifx-panel" class="viewer-panel" aria-label="IFC properties" aria-hidden="true">
      <header class="panel-header">
        <h1>Properties</h1>
        <button type="button" class="panel-close" data-action="toggle-panel" aria-label="Close properties">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>
        </button>
      </header>
      <div id="panel-content" class="panel-content">
        <p class="panel-empty">Click an element in the model to inspect it.</p>
      </div>
    </aside>
    <aside id="ifx-model-panel" class="viewer-panel model-panel" aria-label="IFC model hierarchy" aria-hidden="true">
      <header class="panel-header">
        <h1>Model</h1>
        <button type="button" class="panel-close" data-action="toggle-model" aria-label="Close model hierarchy">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>
        </button>
      </header>
      <label class="model-search">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m16 16 5 5"/></svg>
        <input id="ifx-model-search" type="search" placeholder="Search elements" autocomplete="off">
      </label>
      <div id="ifx-model-tree" class="model-tree"></div>
    </aside>
    <div id="ifx-context-menu" class="viewer-context-menu" role="menu" hidden>
      <button type="button" role="menuitem" data-context-action="show-properties">Show properties</button>
      <button type="button" role="menuitem" data-context-action="isolate">Isolate</button>
      <button type="button" role="menuitem" data-context-action="hide-selected">Hide selected</button>
      <button type="button" role="menuitem" data-context-action="show-all">Show all objects</button>
    </div>
  </main>
  {payload_markup}
  <script>globalThis.__IFX_VIEWER_CONFIG__={config_json};</script>
  <script type="module">{safe_module_js}</script>
</body>
</html>"""
