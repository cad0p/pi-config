// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Tests for {@link fromJSON} — v1 JSON → v2 {@link SteeringConfig}
 * import helper.
 *
 * Covers:
 *   - Happy paths: top-level fields, rule fields, `when.cwd`.
 *   - Golden conversions: the v1 JSON fixtures in
 *     `../loader.test.ts`'s source pass through with the expected
 *     output.
 *   - Rejection paths: every v2-only construct (plugins, observers,
 *     function predicates, custom `when` keys).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FromJSONError, fromJSON } from "./compat.ts";

describe("compat: fromJSON happy paths", () => {
  it("empty object produces empty config", () => {
    assert.deepEqual(fromJSON({}), {});
  });

  it("preserves `disable` list (renames to `disabledRules` in v2)", () => {
    const out = fromJSON({ disable: ["rule-a", "rule-b"] });
    assert.deepEqual(out.disabledRules, ["rule-a", "rule-b"]);
  });

  it("preserves `defaultNoOverride`", () => {
    assert.equal(fromJSON({ defaultNoOverride: true }).defaultNoOverride, true);
    assert.equal(
      fromJSON({ defaultNoOverride: false }).defaultNoOverride,
      false,
    );
  });

  it("converts a minimal rule", () => {
    const out = fromJSON({
      rules: [
        {
          name: "no-foo",
          tool: "write",
          field: "path",
          pattern: "^foo",
          reason: "foo forbidden",
        },
      ],
    });
    assert.deepEqual(out.rules, [
      {
        name: "no-foo",
        tool: "write",
        field: "path",
        pattern: "^foo",
        reason: "foo forbidden",
      },
    ]);
  });

  it("rejects bash rules: bash `pattern:` was removed (issue #117)", () => {
    // Pre-1.0, no shim: fromJSON does NOT import bash `pattern:` at
    // all — any bash rule throws FromJSONError with the rule path
    // plus a migration message (rewrite as `command:` + leaves in
    // TypeScript). No anchored-vs-clever classifier, no translation,
    // no new `command:` JSON input key, no WARN-and-continue.
    try {
      fromJSON({
        rules: [
          {
            name: "no-foo",
            tool: "bash",
            field: "command",
            pattern: "^foo",
            reason: "foo forbidden",
          },
        ],
      });
      assert.fail("expected FromJSONError");
    } catch (err) {
      assert.ok(err instanceof FromJSONError);
      assert.equal(err.path, "<root>.rules[0].pattern");
      assert.match(err.message, /rewrite the rule in TypeScript as `command:`/);
    }
  });

  it("still imports write/edit `pattern:` (their mechanism is untouched)", () => {
    const out = fromJSON({
      rules: [
        {
          name: "no-secret",
          tool: "edit",
          field: "content",
          pattern: "secret",
          reason: "no secrets",
        },
      ],
    });
    const imported = out.rules?.[0];
    assert.ok(imported?.tool === "edit" && imported.pattern === "secret");
  });

  it("passes `requires` / `unless` strings through on write/edit rules (transient)", () => {
    const out = fromJSON({
      rules: [
        {
          name: "rich",
          tool: "write",
          field: "path",
          pattern: "secret",
          requires: "\\.env$",
          unless: "\\.env\\.example$",
          reason: "no secrets in tracked files",
        },
      ],
    });
    assert.equal(out.rules?.[0]?.requires, "\\.env$");
    assert.equal(out.rules?.[0]?.unless, "\\.env\\.example$");
  });

  it("carries forward `requires` / `unless` / `noOverride` / `when.cwd`", () => {
    const out = fromJSON({
      rules: [
        {
          name: "rich",
          tool: "write",
          field: "path",
          pattern: "secret",
          requires: "\\.env$",
          unless: "\\.env\\.example$",
          noOverride: true,
          reason: "no secrets in tracked files",
          when: { cwd: "^/workplace" },
        },
      ],
    });
    const rule = out.rules?.[0];
    assert.ok(rule);
    assert.equal(rule.requires, "\\.env$");
    assert.equal(rule.unless, "\\.env\\.example$");
    assert.equal(rule.noOverride, true);
    assert.equal(rule.when?.cwd, "^/workplace");
  });

  it("rejects non-cwd when keys at conversion (issue #75 compat path)", () => {
    // JSON cannot express plugin predicates, `not:`, or `condition:` —
    // an unknown key never survives conversion, so the compat path
    // meets the same validation bar as the TS load-time key check.
    assert.throws(
      () =>
        fromJSON({
          rules: [
            {
              name: "typo",
              tool: "write",
              field: "path",
              pattern: "^foo",
              reason: "x",
              when: { totallyMadeUp: true },
            },
          ],
        }),
      /JSON config cannot express `when\.totallyMadeUp`.*\(at <root>\.rules\[0\]\.when\.totallyMadeUp\)/,
    );
  });

  it("golden: example fixture used by the v1 JSON loader tests round-trips", () => {
    // Mirrors the shape of the fixture at
    // `src/loader.test.ts` — using a
    // generic name so this test doesn't grow an import dependency
    // on the legacy fixture file.
    const fixture = {
      disable: ["noisy-rule"],
      defaultNoOverride: true,
      rules: [
        {
          name: "block-dangerous",
          tool: "write",
          field: "path",
          pattern: "^/etc/",
          reason: "dangerous path",
          noOverride: true,
        },
        {
          name: "warn-in-workplace",
          tool: "edit",
          field: "content",
          pattern: "TODO",
          reason: "don't land TODOs from workplace paths",
          when: { cwd: "^/workplace" },
        },
      ],
    };
    const out = fromJSON(fixture);
    assert.deepEqual(out.disabledRules, ["noisy-rule"]);
    assert.equal(out.defaultNoOverride, true);
    assert.equal(out.rules?.length, 2);
    assert.equal(out.rules?.[0]?.noOverride, true);
    assert.equal(out.rules?.[1]?.when?.cwd, "^/workplace");
  });
});

describe("compat: fromJSON rejections", () => {
  it("rejects non-object top-level", () => {
    assert.throws(() => fromJSON(null), FromJSONError);
    assert.throws(() => fromJSON(42), FromJSONError);
    assert.throws(() => fromJSON("string"), FromJSONError);
    assert.throws(() => fromJSON([]), FromJSONError);
  });

  it("rejects v2-only top-level keys with a clear error", () => {
    for (const key of [
      "plugins",
      "observers",
      "exemptions",
      "disablePlugins",
      "disabledPlugins",
      "disabledRules",
    ]) {
      let caught: unknown;
      try {
        fromJSON({ [key]: [] });
      } catch (e) {
        caught = e;
      }
      assert.ok(
        caught instanceof FromJSONError,
        `expected FromJSONError for ${key}`,
      );
      assert.ok(
        caught.message.includes(key),
        `error should mention the forbidden key, got: ${caught.message}`,
      );
      assert.equal(caught.path, `<root>.${key}`);
    }
  });

  it("rejects malformed `disable`", () => {
    assert.throws(() => fromJSON({ disable: "not-an-array" }), FromJSONError);
    assert.throws(() => fromJSON({ disable: [1, 2] }), FromJSONError);
  });

  it("rejects malformed `defaultNoOverride`", () => {
    assert.throws(() => fromJSON({ defaultNoOverride: "true" }), FromJSONError);
  });

  it("rejects missing required rule fields", () => {
    // missing name
    assert.throws(
      () =>
        fromJSON({
          rules: [{ tool: "write", field: "path", pattern: "p", reason: "r" }],
        }),
      FromJSONError,
    );
    // missing pattern
    assert.throws(
      () =>
        fromJSON({
          rules: [{ name: "n", tool: "write", field: "path", reason: "r" }],
        }),
      FromJSONError,
    );
    // wrong tool value
    assert.throws(
      () =>
        fromJSON({
          rules: [
            {
              name: "n",
              tool: "shell", // not one of bash/write/edit
              field: "command",
              pattern: "p",
              reason: "r",
            },
          ],
        }),
      FromJSONError,
    );
  });

  it("rejects invalid (tool, field) combinations per the Rule union", () => {
    // bash rules must use `field: "command"`; `path` / `content` are
    // silently-wrong combos the discriminated TS Rule union now
    // rejects. compat.ts mirrors the check at JSON parse time.
    assert.throws(
      () =>
        fromJSON({
          rules: [
            {
              name: "n",
              tool: "bash",
              field: "path",
              pattern: "p",
              reason: "r",
            },
          ],
        }),
      FromJSONError,
    );
    assert.throws(
      () =>
        fromJSON({
          rules: [
            {
              name: "n",
              tool: "bash",
              field: "content",
              pattern: "p",
              reason: "r",
            },
          ],
        }),
      FromJSONError,
    );
    // write / edit rules test `path` or `content`, never `command`.
    assert.throws(
      () =>
        fromJSON({
          rules: [
            {
              name: "n",
              tool: "write",
              field: "command",
              pattern: "p",
              reason: "r",
            },
          ],
        }),
      FromJSONError,
    );
    assert.throws(
      () =>
        fromJSON({
          rules: [
            {
              name: "n",
              tool: "edit",
              field: "command",
              pattern: "p",
              reason: "r",
            },
          ],
        }),
      FromJSONError,
    );
  });

  it("rejects non-string `pattern`", () => {
    assert.throws(
      () =>
        fromJSON({
          rules: [
            {
              name: "n",
              tool: "write",
              field: "path",
              pattern: 42,
              reason: "r",
            },
          ],
        }),
      FromJSONError,
    );
  });

  it("rejects function-shaped rule fields (they can't appear in JSON, but errors help hand-editing humans)", () => {
    assert.throws(
      () =>
        fromJSON({
          rules: [
            {
              name: "n",
              tool: "write",
              field: "path",
              pattern: "p",
              reason: "r",
              requires: 42,
            },
          ],
        }),
      FromJSONError,
    );
  });

  it("rejects plugin-registered `when` keys", () => {
    let caught: unknown;
    try {
      fromJSON({
        rules: [
          {
            name: "n",
            tool: "write",
            field: "path",
            pattern: "p",
            reason: "r",
            when: { branch: "^main$" },
          },
        ],
      });
    } catch (e) {
      caught = e;
    }
    assert.ok(caught instanceof FromJSONError);
    assert.ok(caught.message.includes("when.branch"));
    assert.ok(caught.path.endsWith("when.branch"));
  });

  it("rejects `when.not` / `when.condition` (v2-only)", () => {
    assert.throws(
      () =>
        fromJSON({
          rules: [
            {
              name: "n",
              tool: "write",
              field: "path",
              pattern: "p",
              reason: "r",
              when: { not: {} },
            },
          ],
        }),
      FromJSONError,
    );
    assert.throws(
      () =>
        fromJSON({
          rules: [
            {
              name: "n",
              tool: "write",
              field: "path",
              pattern: "p",
              reason: "r",
              when: { condition: "noop" },
            },
          ],
        }),
      FromJSONError,
    );
  });

  it("rejects `observer` key on a rule", () => {
    assert.throws(
      () =>
        fromJSON({
          rules: [
            {
              name: "n",
              tool: "write",
              field: "path",
              pattern: "p",
              reason: "r",
              observer: "some-name",
            },
          ],
        }),
      FromJSONError,
    );
  });

  it("rejects non-string `when.cwd`", () => {
    assert.throws(
      () =>
        fromJSON({
          rules: [
            {
              name: "n",
              tool: "write",
              field: "path",
              pattern: "p",
              reason: "r",
              when: { cwd: 42 },
            },
          ],
        }),
      FromJSONError,
    );
  });
});

describe("compat: FromJSONError", () => {
  it("carries a path pointing at the offending location", () => {
    try {
      fromJSON({
        rules: [
          {
            name: "ok",
            tool: "write",
            field: "path",
            pattern: "p",
            reason: "r",
          },
          {
            name: "bad",
            tool: "write",
            field: "path",
            pattern: 42,
            reason: "r",
          },
        ],
      });
      assert.fail("expected throw");
    } catch (err) {
      assert.ok(err instanceof FromJSONError);
      assert.equal(err.path, "<root>.rules[1].pattern");
    }
  });
});
