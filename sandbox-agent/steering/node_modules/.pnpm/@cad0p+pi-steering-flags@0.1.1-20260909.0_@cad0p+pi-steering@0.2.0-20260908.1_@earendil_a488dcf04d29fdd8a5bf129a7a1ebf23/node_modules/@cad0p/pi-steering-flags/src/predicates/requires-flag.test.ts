// SPDX-License-Identifier: MIT
// Part of pi-steering-flags.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PredicateWord } from "@cad0p/pi-steering";
import { testPredicate } from "@cad0p/pi-steering/testing";
import { requiresFlag } from "./requires-flag.ts";

function W(value: string): PredicateWord {
  return { value, text: value, pos: 0, end: value.length, rawText: value };
}

describe("requiresFlag", () => {
  it("fires when required flag is absent (shorthand string arg)", async () => {
    const fires = await testPredicate(requiresFlag, "--profile", {
      input: {
        tool: "bash",
        command: "aws s3 ls",
        basename: "aws",
        args: [W("s3"), W("ls")],
      },
      descriptors: { aws: {} },
    });
    assert.equal(fires, true);
  });

  it("does NOT fire when required flag is present (bare form)", async () => {
    const fires = await testPredicate(requiresFlag, "--profile", {
      input: {
        tool: "bash",
        command: "aws s3 ls --profile dev",
        basename: "aws",
        args: [W("s3"), W("ls"), W("--profile"), W("dev")],
      },
      descriptors: { aws: {} },
    });
    assert.equal(fires, false);
  });

  it("does NOT fire when required flag is present (attached form)", async () => {
    const fires = await testPredicate(requiresFlag, "--profile", {
      input: {
        tool: "bash",
        command: "aws s3 ls --profile=dev",
        basename: "aws",
        args: [W("s3"), W("ls"), W("--profile=dev")],
      },
      descriptors: { aws: {} },
    });
    assert.equal(fires, false);
  });

  it("object form: single flag", async () => {
    const fires = await testPredicate(
      requiresFlag,
      { flag: "--profile" },
      {
        input: {
          tool: "bash",
          command: "aws s3 ls",
          basename: "aws",
          args: [W("s3"), W("ls")],
        },
        descriptors: { aws: {} },
      },
    );
    assert.equal(fires, true);
  });

  it("object form: env-var equivalence satisfies", async () => {
    const fires = await testPredicate(
      requiresFlag,
      { flag: "--profile", env: "AWS_PROFILE" },
      {
        input: {
          tool: "bash",
          command: "AWS_PROFILE=dev aws s3 ls",
          basename: "aws",
          args: [W("s3"), W("ls")],
          envAssignments: [W("AWS_PROFILE=dev")],
        },
        descriptors: { aws: {} },
      },
    );
    assert.equal(fires, false);
  });

  it("object form: any of several flags satisfies", async () => {
    const fires = await testPredicate(
      requiresFlag,
      { flags: ["-n", "--namespace"] },
      {
        input: {
          tool: "bash",
          command: "kubectl apply -n kube-system",
          basename: "kubectl",
          args: [W("apply"), W("-n"), W("kube-system")],
        },
        descriptors: { kubectl: {} },
      },
    );
    assert.equal(fires, false);
  });

  it("object form: any of several envs satisfies", async () => {
    const fires = await testPredicate(
      requiresFlag,
      { flag: "--region", envs: ["AWS_REGION", "AWS_DEFAULT_REGION"] },
      {
        input: {
          tool: "bash",
          command: "AWS_DEFAULT_REGION=us-east-1 aws s3 ls",
          basename: "aws",
          args: [W("s3"), W("ls")],
          envAssignments: [W("AWS_DEFAULT_REGION=us-east-1")],
        },
        descriptors: { aws: {} },
      },
    );
    assert.equal(fires, false);
  });

  it("does NOT fire on malformed args (empty object → nothing to require)", async () => {
    const fires = await testPredicate(requiresFlag, {} as never, {
      input: {
        tool: "bash",
        command: "aws s3 ls",
        basename: "aws",
        args: [W("s3"), W("ls")],
      },
      descriptors: { aws: {} },
    });
    assert.equal(fires, false);
  });

  it("fires when command has no envAssignments slot and the flag is absent", async () => {
    // Agents without envAssignments in the context still behave sensibly.
    const fires = await testPredicate(
      requiresFlag,
      { flag: "--profile", env: "AWS_PROFILE" },
      {
        input: {
          tool: "bash",
          command: "aws s3 ls",
          basename: "aws",
          args: [W("s3"), W("ls")],
          // envAssignments omitted
        },
        descriptors: { aws: {} },
      },
    );
    assert.equal(fires, true);
  });
});
