import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  cpSync,
  mkdirSync,
  rmSync,
  copyFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");
const coreRoot = resolve(
  process.env.IFX_CORE_SOURCE || resolve(projectRoot, "../ifx-core"),
);
const wasmRoot = resolve(coreRoot, "pkg");
const htmlSource = readFileSync(
  resolve(projectRoot, "src/ifx/html.py"),
  "utf8",
);
const markup = htmlSource.match(/<main[\s\S]*?<\/main>/)?.[0];
if (!markup) throw new Error("The standard viewer markup is missing.");
const styles = readFileSync(
  resolve(projectRoot, "src/ifx/static/viewer.css"),
  "utf8",
)
  .replace(":root {", ":host {")
  .replace(
    "html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; }",
    "",
  );
writeFileSync(
  resolve(here, "src/ui.ts"),
  `// Generated from the standard viewer HTML and CSS.\nexport const viewerMarkup = ${JSON.stringify(markup)};\nexport const viewerStyles = ${JSON.stringify(styles)};\n`,
);
if (!existsSync(resolve(wasmRoot, "ifx_core_bg.wasm")))
  throw new Error("Build ifx-core WASM first. See the core README.");
rmSync(resolve(here, "dist"), { recursive: true, force: true });
mkdirSync(resolve(here, "src/wasm"), { recursive: true });
cpSync(wasmRoot, resolve(here, "src/wasm"), { recursive: true });
mkdirSync(resolve(here, "dist/wasm"), { recursive: true });
for (const file of [
  "ifx_core.js",
  "ifx_core.d.ts",
  "ifx_core_bg.wasm",
  "ifx_core_bg.wasm.d.ts",
])
  copyFileSync(resolve(wasmRoot, file), resolve(here, "dist/wasm", file));
copyFileSync(resolve(coreRoot, "LICENSE"), resolve(here, "dist/wasm/LICENSE"));
copyFileSync(
  resolve(coreRoot, "ACKNOWLEDGEMENTS.md"),
  resolve(here, "dist/wasm/ACKNOWLEDGEMENTS.md"),
);
execFileSync("tar", [
  "--exclude=__pycache__", "--exclude=*.pyc",
  "-czf",
  resolve(here, "dist/wasm/source.tar.gz"),
  "-C",
  coreRoot,
  "Cargo.toml",
  "Cargo.lock",
  "rust-toolchain.toml",
  "README.md",
  "scripts",
  "src",
  "crates",
  "LICENSE",
  "ACKNOWLEDGEMENTS.md",
  "UPSTREAM_SOURCE.json",
]);
copyFileSync(resolve(projectRoot, "LICENSE"), resolve(here, "LICENSE"));
execFileSync("tar", [
  "--exclude=__pycache__", "--exclude=*.pyc",
  "-czf", resolve(here, "dist/ifx-source.tar.gz"), "-C", projectRoot,
  "LICENSE", "THIRD_PARTY_NOTICES.md", "frontend/README.md",
  "frontend/build.mjs", "frontend/examples", "frontend/package-lock.json",
  "frontend/package.json", "frontend/src", "frontend/tests", "frontend/tsconfig.json",
  "frontend/tsconfig.build.json", "src/ifx/html.py", "src/ifx/static/viewer.css",
  "src/ifx/static/viewer.ts",
]);
copyFileSync(
  resolve(projectRoot, "THIRD_PARTY_NOTICES.md"),
  resolve(here, "THIRD_PARTY_NOTICES.md"),
);
const entryPoint = resolve(projectRoot, "src/ifx/static/viewer.ts");
const shared = {
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  legalComments: "inline",
  logLevel: "info",
  nodePaths: [resolve(here, "node_modules")],
};
await Promise.all([
  build({
    ...shared,
    entryPoints: [entryPoint],
    outfile: resolve(projectRoot, "src/ifx/static/viewer.bundle.js"),
    bundle: true,
    minify: true,
    sourcemap: true,
  }),
  build({
    ...shared,
    entryPoints: [entryPoint],
    outfile: resolve(projectRoot, "src/ifx/static/viewer.js"),
    bundle: true,
    packages: "external",
    external: ["three", "three/*", "three-mesh-bvh"],
  }),
  build({
    ...shared,
    entryPoints: [resolve(here, "src/index.ts")],
    outfile: resolve(here, "dist/index.js"),
    bundle: true,
    packages: "external",
    external: ["three", "three/*", "three-mesh-bvh", "./wasm/ifx_core.js"],
    sourcemap: true,
  }),
  build({
    ...shared,
    entryPoints: [resolve(here, "src/core.worker.ts")],
    outfile: resolve(here, "dist/core.worker.js"),
    bundle: true,
    external: ["three", "three/*", "three-mesh-bvh", "./wasm/ifx_core.js"],
  }),
]);
execFileSync(
  resolve(here, "node_modules/.bin/tsc"),
  ["--project", resolve(here, "tsconfig.build.json")],
  { stdio: "inherit" },
);
