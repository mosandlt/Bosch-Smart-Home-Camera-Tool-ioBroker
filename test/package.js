/**
 * Package validation smoke test.
 * Uses @iobroker/testing to verify io-package.json and package.json are valid.
 */

const path = require("path");
const { tests } = require("@iobroker/testing");

// Run the package tests (validates io-package.json structure + package.json fields).
// Path is resolved to the repo root, not the test/ working dir Mocha runs from.
tests.packageFiles(path.join(__dirname, ".."));
