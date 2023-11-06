import * as core from "@actions/core";
import * as github from "@actions/github";
import type { PullRequest } from "@octokit/webhooks-types";

import { XMLParser } from "fast-xml-parser";
import * as fs from "fs/promises";

interface Results {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
}

let githubToken = core.getInput("token", { required: true });
let octokit = github.getOctokit(githubToken);

let checks = await octokit.rest.checks.listForRef({
  ...github.context.repo,
  ref: "main",
});

let xmlParser = new XMLParser({
  ignoreAttributes: false,
});

export function getCheckRunContext(): { sha: string; runId: number } {
  if (github.context.eventName === "workflow_run") {
    core.info(
      "Action was triggered by workflow_run: using SHA and RUN_ID from triggering workflow",
    );
    const event = github.context.payload;
    if (!event.workflow_run) {
      throw new Error(
        "Event of type 'workflow_run' is missing 'workflow_run' field",
      );
    }
    return {
      sha: event.workflow_run.head_commit.id,
      runId: event.workflow_run.id,
    };
  }

  const runId = github.context.runId;
  if (github.context.payload.pull_request) {
    core.info(
      `Action was triggered by ${github.context.eventName}: using SHA from head of source branch`,
    );
    const pr = github.context.payload.pull_request as PullRequest;
    return { sha: pr.head.sha, runId };
  }

  return { sha: github.context.sha, runId };
}

let context = getCheckRunContext();

let getCurrentResults = async (junitPath: string) => {
  let doc = xmlParser.parse(await fs.readFile(junitPath));

  let results: Results = {
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

/** Get the results of the last run of h2spec on the `main` branch */
let getReferenceResults = async (checkName: string) => {
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

  if (!check.output.summary) {
    console.log(`No summary found for check ${checkName}`);
    process.exit(1);
  }
  let m = regex.exec(check.output.summary);
  if (!m) {
    console.log(`Output summary didn't match expected structure`);
    console.log(`Structure was: ${regex}`);
    console.log(`Output was:\n${check.output.summary}`);
    process.exit(1);
  }

  let results: Results = {
    total: parseInt(m[1], 10),
    passed: parseInt(m[3], 10),
    failed: parseInt(m[4], 10),
    skipped: parseInt(m[5], 10),
  };
  return results;
};

/// Create a check with our results
const createResp = await octokit.rest.checks.create({
  head_sha: context.sha,
  name: "h2spec-regression",
  status: "in_progress",
  output: {
    title: "h2spec-regression",
    summary: "",
  },
  ...github.context.repo,
});

core.info(`Check created, id: ${createResp.data.id}`);

let regressionsDetected = false;
let outputLines: string[] = [];

let suites = core.getInput("suites").split(",");
for (const suite of suites) {
  let junitPath = `./${suite}.xml`;
  let current = await getCurrentResults(junitPath);
  let reference = await getReferenceResults(suite);
  if (current.failed > reference.failed) {
    let line = `Regression detected in ${suite}: ${current.failed} > ${reference.failed}`;
    outputLines.push(line);
    core.error(line);
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

    {
      let line = `No regression in ${suite}: failed count ${diff} (${current.passed} passed, ${current.failed} failed)`;
      outputLines.push(line);
      core.info(line);
    }
  }
}

/// Update the check with our conclusion
await octokit.rest.checks.update({
  check_run_id: createResp.data.id,
  conclusion: regressionsDetected ? "failure" : "success",
  status: "completed",
  output: {
    title: "h2spec-regression",
    summary: outputLines.join("\n"),
  },
  ...github.context.repo,
});

core.info("Check updated");
