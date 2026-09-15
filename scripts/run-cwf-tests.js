const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = process.cwd();

function collectTests(directory) {
  const fullDirectory = path.join(root, directory);

  return fs
    .readdirSync(fullDirectory, { withFileTypes: true })
    .flatMap((entry) => {
      const fullPath = path.join(fullDirectory, entry.name);

      if (entry.isDirectory()) {
        return collectTests(path.join(directory, entry.name));
      }

      if (
        entry.isFile() &&
        entry.name.endsWith(".test.ts")
      ) {
        return [fullPath];
      }

      return [];
    });
}

const testFiles = [
  ...collectTests("runtime-test"),
  ...collectTests("api-test"),
];

if (testFiles.length === 0) {
  console.error("No CWF test files found.");
  process.exit(1);
}

console.log("");
console.log("CWF test files:");
for (const file of testFiles) {
  console.log(`  ${path.relative(root, file)}`);
}
console.log("");

const command = process.platform === "win32"
  ? "npx.cmd"
  : "npx";

const result = spawnSync(
  command,
  ["hardhat", "test", ...testFiles],
  {
    stdio: "inherit",
    cwd: root,
  },
);

process.exit(
  result.status === null ? 1 : result.status,
);
