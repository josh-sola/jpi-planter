import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {},
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: {
      "vite-plus/prefer-vite-plus-imports": "error",
      // helpers.ts strips control characters from labels on purpose; the match is the point.
      "no-control-regex": "off",
      // Dependency interfaces (getSessionName, requestId, ...) use method shorthand only for
      // concise typing; every implementation is a plain closure that never reads `this`.
      "typescript/unbound-method": "off",
    },
    options: { typeAware: true, typeCheck: true },
  },
});
