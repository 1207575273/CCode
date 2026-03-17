import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["bin/zcli.ts"],
  outDir: "dist/bin",
  format: ["esm"],
  target: "node20",
  splitting: false,
  sourcemap: process.env.NODE_ENV !== "production",
  clean: true,
  minify: process.env.NODE_ENV === "production" && "terser",
  banner: {
    js: "#!/usr/bin/env node",
  },
  tsconfig: "tsconfig.build.json",
});
