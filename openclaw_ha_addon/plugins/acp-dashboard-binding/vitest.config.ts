// 9.2 (why boundAgents win over exclusions) (register-crash forensics 2026-10-13): the registerFull contract test
// imports index.ts, whose static plugin-sdk imports must resolve in vitest.
// The pinned gateway is aliased read-only from the image's /usr/lib install —
// same source of truth tsconfig.check.json uses for its `paths`.
export default {
  test: {
    environment: "node",
    // registerFull pulls the real dist SDK through the alias on first import
    // (~11 s cold); the default 5 s timeout flips that into a false failure.
    testTimeout: 20000,
    // local untracked dep-research checkout, not test code (kept off the
    // vitest default include, which only knows node_modules, not this name)
    exclude: ["../node_modules_deps/**", "node_modules_deps/**"],
  },
  resolve: {
    alias: [
      {
        find: /^openclaw$/,
        replacement: "/usr/lib/node_modules/openclaw/dist/index.js",
      },
      {
        find: /^openclaw\/plugin-sdk\/(.*)$/,
        replacement: "/usr/lib/node_modules/openclaw/dist/plugin-sdk/$1.js",
      },
    ],
  },
};
