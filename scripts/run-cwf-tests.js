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

// Normalize paths for Hardhat's CLI on every platform.
const cliTestFiles = testFiles.map((file) =>
  path.relative(root, file).split(path.sep).join("/")
);

const command = process.platform === "win32" ? "npm.cmd" : "npm";

const result = spawnSync(
  command,
  ["exec", "--", "hardhat", "test", ...cliTestFiles],
  {
    stdio: "inherit",
    cwd: root,
    shell: process.platform === "win32",
  },
);

if (result.error) {
  console.error("Failed to start Hardhat test runner:", result.error);
  process.exit(1);
}

process.exit(result.status === null ? 1 : result.status);
