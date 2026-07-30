import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  evaluate, usesRootSchema, schemaArg, redact, blockMessage,
  SAFE_SCHEMA, ROOT_SCHEMA,
} from "../scripts/prisma-guard.mjs";

const GUARD = "scripts/prisma-guard.mjs";

/** Run the guard as a real process; returns { status, stderr }. */
function runGuard(args: string[]): { status: number; stderr: string } {
  try {
    execFileSync("node", [GUARD, ...args], { encoding: "utf8", stdio: "pipe" });
    return { status: 0, stderr: "" };
  } catch (e: any) {
    return { status: e.status ?? -1, stderr: (e.stderr ?? "") + (e.stdout ?? "") };
  }
}

describe("prisma guard — blocks schema-changing commands on the root schema", () => {
  const blocked = [
    ["migrate", "dev"],
    ["migrate", "deploy"],
    ["migrate", "reset"],
    ["db", "push"],
  ];

  for (const argv of blocked) {
    test(`implicit root schema: ${argv.join(" ")} → blocked`, () => {
      const v = evaluate(argv);
      assert.equal(v.blocked, true, `${argv.join(" ")} should be blocked`);
    });

    test(`explicit root schema: ${argv.join(" ")} --schema=${ROOT_SCHEMA} → blocked`, () => {
      const v = evaluate([...argv, `--schema=${ROOT_SCHEMA}`]);
      assert.equal(v.blocked, true);
    });

    test(`explicit root schema (space form): ${argv.join(" ")} → blocked`, () => {
      const v = evaluate([...argv, "--schema", ROOT_SCHEMA]);
      assert.equal(v.blocked, true);
    });

    test(`superset schema: ${argv.join(" ")} → allowed`, () => {
      const v = evaluate([...argv, `--schema=${SAFE_SCHEMA}`]);
      assert.equal(v.blocked, false, `${argv.join(" ")} on superset should be allowed`);
    });
  }
});

describe("prisma guard — allows safe commands", () => {
  for (const argv of [["generate"], ["validate"], ["format"], ["studio"], ["version"]]) {
    test(`${argv[0]} on root schema → allowed`, () => {
      assert.equal(evaluate(argv).blocked, false);
    });
  }

  test("migrate status → allowed", () => {
    assert.equal(evaluate(["migrate", "status"]).blocked, false);
  });

  test("migrate diff → allowed", () => {
    assert.equal(evaluate(["migrate", "diff"]).blocked, false);
  });

  test("db execute --file (reviewed SQL) → allowed", () => {
    const v = evaluate(["db", "execute", "--file", "prisma/migrations/x/migration.sql", "--schema", ROOT_SCHEMA]);
    assert.equal(v.blocked, false);
  });

  test("db execute without --file → blocked", () => {
    assert.equal(evaluate(["db", "execute"]).blocked, true);
  });
});

describe("prisma guard — schema path resolution", () => {
  test("superset path is not mistaken for the root path", () => {
    // The superset path CONTAINS "prisma/schema.prisma" as a substring; a
    // substring check would wrongly block it.
    assert.ok(SAFE_SCHEMA.includes(ROOT_SCHEMA), "precondition: substring overlap exists");
    assert.equal(usesRootSchema([`--schema=${SAFE_SCHEMA}`]), false);
  });

  test("no --schema means the implicit root schema", () => {
    assert.equal(usesRootSchema([]), true);
  });

  test("./-prefixed root path still resolves to root", () => {
    assert.equal(usesRootSchema([`--schema=./${ROOT_SCHEMA}`]), true);
  });

  test("schemaArg reads both = and space forms", () => {
    assert.equal(schemaArg(["--schema=a/b.prisma"]), "a/b.prisma");
    assert.equal(schemaArg(["--schema", "a/b.prisma"]), "a/b.prisma");
    assert.equal(schemaArg(["migrate", "dev"]), null);
  });
});

describe("prisma guard — does not leak secrets", () => {
  const SECRET = "postgresql://user:hunter2@db.example.com:5432/neondb?sslmode=require";

  test("connection strings are redacted in the block message", () => {
    const msg = blockMessage(["db", "push", "--url", SECRET]);
    assert.ok(!msg.includes("hunter2"), "password must not appear");
    assert.ok(!msg.includes("db.example.com"), "host must not appear");
    assert.ok(msg.includes("<REDACTED>"));
  });

  test("redact handles = and space forms and bare URLs", () => {
    assert.ok(!redact([`--url=${SECRET}`]).includes("hunter2"));
    assert.ok(!redact(["--url", SECRET]).includes("hunter2"));
    assert.ok(!redact([SECRET]).includes("hunter2"));
  });

  test("real process run does not print DATABASE_URL", () => {
    const r = runGuard(["db", "push"]);
    assert.equal(r.status, 1);
    const dbUrl = process.env.DATABASE_URL ?? "";
    if (dbUrl) assert.ok(!r.stderr.includes(dbUrl), "DATABASE_URL must not be echoed");
    assert.ok(!/hunter2|password=/i.test(r.stderr));
  });
});

describe("prisma guard — end-to-end process behaviour", () => {
  test("db push exits non-zero and explains why", () => {
    const r = runGuard(["db", "push"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /BLOCKED/);
    assert.match(r.stderr, /docs\/DATABASE\.md/);
    assert.match(r.stderr, /VideoSnapshot/);
    assert.match(r.stderr, new RegExp(SAFE_SCHEMA.replace(/[/.]/g, "\\$&")));
  });

  test("migrate reset exits non-zero", () => {
    assert.equal(runGuard(["migrate", "reset"]).status, 1);
  });
});
