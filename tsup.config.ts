import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "cli/index": "src/cli/index.ts",
    index: "src/index.ts",
  },
  format: ["esm"],
  target: "node20",
  platform: "node",
  splitting: true,
  sourcemap: true,
  clean: true,
  dts: { entry: { index: "src/index.ts" } },
  banner: ({ format }) => (format === "esm" ? { js: "" } : {}),
});
