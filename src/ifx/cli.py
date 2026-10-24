import argparse
from pathlib import Path

from .viewer import IFCViewer


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Open an IFC model in the Three.js viewer")
    parser.add_argument("ifc", type=Path, help="Path to an IFC file")
    parser.add_argument(
        "--quality",
        choices=("lowest", "low", "medium", "high", "highest"),
        default="medium",
    )
    parser.add_argument("--port", type=int, default=0, help="Local port; 0 chooses a free port")
    parser.add_argument(
        "--no-browser", action="store_true", help="Print the URL without opening it"
    )
    parser.add_argument("--cdn", action="store_true", help="Use CDN frontend assets")
    parser.add_argument("--html", type=Path, help="Write a self-contained HTML file instead")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    viewer = IFCViewer(args.ifc, quality=args.quality)
    asset_mode = "cdn" if args.cdn else "auto"
    if args.html:
        output = viewer.write_html(args.html, asset_mode=asset_mode)
        print(output)
        return 0
    handle = viewer.view(
        port=args.port,
        open_browser=not args.no_browser,
        asset_mode=asset_mode,
    )
    print(handle.url)
    handle.wait()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
