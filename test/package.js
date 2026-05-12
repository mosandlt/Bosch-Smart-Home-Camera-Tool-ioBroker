/**
 * Package validation smoke test.
 * Uses @iobroker/testing to verify io-package.json and package.json are valid.
 */

const { tests } = require("@iobroker/testing");

// Run the package tests (validates io-package.json structure + package.json fields)
tests.packageFiles(".");
