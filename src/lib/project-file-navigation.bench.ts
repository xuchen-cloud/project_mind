import { bench, describe } from "vitest";
import { indexProjectFiles, projectFilePathMatches } from "./project-file-navigation";

// Both implementations join the same D documents and E = D directory entries.
// Fixture creation is outside timing; index construction is inside timing.
// Timing is descriptive only. Getter counts in the unit tests are the
// deterministic evidence that building reads D paths and lookups read none.
for (const size of [1000, 2000, 5000]) {
  describe(`project file directory join: D = E = ${size}`, () => {
    const rootPath = "C:\\workspace\\";
    const documents = Object.freeze(Array.from({ length: size }, (_, id) => ({
      id,
      managedPath: `C:\\workspace\\notes\\file-${id}.md`,
    })));
    const relativePaths = documents.map(document => `notes/file-${document.id}.md`);
    const expectedChecksum = size * (size - 1) / 2;

    bench("legacy matcher + find", () => {
      let checksum = 0;
      for (let id = 0; id < relativePaths.length; id += 1) {
        const result = documents.find(document => projectFilePathMatches(document.managedPath, rootPath, relativePaths[id]));
        if (result !== documents[id]) throw new Error(`Incorrect legacy match at ${id}`);
        checksum += result.id;
      }
      if (checksum !== expectedChecksum) throw new Error("Incorrect legacy checksum");
    }, { time: 500, iterations: 3 });

    bench("index build + lookup", () => {
      const index = indexProjectFiles({ rootPath, documents });
      let checksum = 0;
      for (let id = 0; id < relativePaths.length; id += 1) {
        const result = index.findByRelativePath(relativePaths[id]);
        if (result !== documents[id]) throw new Error(`Incorrect indexed match at ${id}`);
        checksum += result.id;
      }
      if (checksum !== expectedChecksum) throw new Error("Incorrect indexed checksum");
    }, { time: 500, iterations: 3 });
  });
}
