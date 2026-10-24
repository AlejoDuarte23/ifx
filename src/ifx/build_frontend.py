import shutil
import subprocess
from pathlib import Path


def main() -> int:
    project_root = Path(__file__).resolve().parents[2]
    frontend = project_root / "frontend"
    npm = shutil.which("npm")
    if npm is None:
        raise RuntimeError("npm is required to build the frontend bundle")
    subprocess.run([npm, "install", "--no-audit", "--no-fund"], cwd=frontend, check=True)
    subprocess.run([npm, "run", "build"], cwd=frontend, check=True)
    bundle = project_root / "src" / "ifx" / "static" / "viewer.bundle.js"
    if not bundle.is_file():
        raise RuntimeError(f"frontend build completed without creating {bundle}")
    print(bundle)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
