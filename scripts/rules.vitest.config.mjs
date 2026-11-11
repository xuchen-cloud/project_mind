// Documentation/motion rules have no application runtime or DOM dependency.
export default {
  test: {
    environment: "node",
    include: ["scripts/check-ui-standards.test.mjs", "scripts/portable-path-rules.test.mjs"],
  },
};
