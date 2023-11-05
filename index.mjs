import core from "@actions/core";
import github from "@actions/github";

import { XMLParser } from "fast-xml-parser";
import fs from "fs/promises";

/**
 * @typedef {Object} Spec - Specification to check
 * @property {string} junitPath - Path to the JUnit XML file
 * @property {string} checkName - Name of the check to compare against
 */

/**
 * @typedef {Object} Results - Results of a test run
 * @property {number} total - Total number of tests
 * @property {number} passed - Number of tests passed
 * @property {number} failed - Number of tests failed
 * @property {number} skipped - Number of tests skipped
 */

let githubToken = core.getInput("github-token");
if (!githubToken) {
  console.log("No github-token input provided, exiting");
  process.exit(1);
}
let octokit = github.getOctokit(githubToken);

let checks = await octokit.rest.checks.listForRef({
  ...github.context.repo,
  ref: "main",
});

let xmlParser = new XMLParser({
  ignoreAttributes: false,
});

/**
 * @param {string} junitPath - Path to the JUnit XML file
 */
let getCurrentResults = async (junitPath) => {
  let doc = xmlParser.parse(await fs.readFile(junitPath));

  /**
   * @type {Results}
   */
  let results = {
    total: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
  };

  for (const ts of doc.testsuites.testsuite) {
    let tests = parseInt(ts["@_tests"], 10);
    let failures = parseInt(ts["@_failures"], 10);
    let errors = parseInt(ts["@_errors"], 10);
    let skipped = parseInt(ts["@_skipped"], 10);

    results.total += tests;
    results.failed += failures + errors;
    results.skipped += skipped;
    results.passed += tests - (failures + errors + skipped);
  }

  return results;
};

/**
 * Get the results of the last run of h2spec on the `main` branch
 * @param {string} checkName
 * @returns {Results}
 */
let getReferenceResults = async (checkName) => {
  let check = checks.data.check_runs.find((c) => c.name == checkName);
  if (!check) {
    console.log(`No ${JSON.stringify(checkName)} check found`);
    process.exit(0);
  }

  // example input:
  //   **94** tests were completed in **NaNms** with **70** passed, **24** failed and **0** skipped
  // example output:
  //   { total: 94, passed: 70, failed: 24, skipped: 0 }
  const regex =
    /[*][*](\d+)[*][*] tests were completed in [*][*](\w+)ms[*][*] with [*][*](\d+)[*][*] passed, [*][*](\d+)[*][*] failed and [*][*](\d+)[*][*] skipped/g;
  let m = regex.exec(check.output.summary);
  return {
    total: parseInt(m[1], 10),
    passed: parseInt(m[3], 10),
    failed: parseInt(m[4], 10),
    skipped: parseInt(m[5], 10),
  };
};

let regressionsDetected = false;
let outputLines = [];

let suites = core.getInput("suites").split(",");
for (const suite of suites) {
  let junitPath = `target/h2spec-${suite}.xml`;
  let current = await getCurrentResults(junitPath);
  let reference = await getReferenceResults(suite);
  if (current.failed > reference.failed) {
    outputLines.push(
      `Regression detected in ${spec.checkName}: ${current.failed} > ${reference.failed}`,
    );
    regressionsDetected = true;
  } else {
    let diff;
    if (current.failed == reference.failed) {
      diff = "unchanged";
    } else if (current.failed < reference.failed) {
      diff = `-${reference.failed - current.failed}`;
    } else if (current.failed > reference.failed) {
      diff = `+${current.failed - reference.failed}`;
    }

    outputLines.push(
      `No regression in ${spec.checkName}: failed count ${diff} (${current.passed} passed, ${current.failed} failed)`,
    );
  }
}

if (regressionsDetected) {
  outputLines.push(`Regressions detected, failing the build`);
  process.exit(1);
}

// Leave a comment on the PR with all lines in outputLines
let comment = outputLines.join("\n");

if (github.context.issue) {
  let issue_number = github.context.issue.number;
  console.log(`Leaving comment on PR #${issue_number}`);
  await octokit.rest.issues.createComment({
    ...github.context.repo,
    issue_number,
    body: comment,
  });
} else {
  console.log(
    `Not a PR, not leaving a comment. Comment would've been:\n${comment}`,
  );
}
