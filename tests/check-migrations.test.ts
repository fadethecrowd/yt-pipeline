import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  stripSqlComments, splitStatements, violations, checkMigrationSql,
} from "../scripts/check-migrations.mjs";

describe("migration checker — comment handling", () => {
  test("strips line comments", () => {
    const out = stripSqlComments(`-- CreateTable\nCREATE TABLE "a" ();`);
    assert.ok(!out.includes("CreateTable"));
    assert.match(out, /CREATE TABLE/);
  });

  test("strips block comments, including nested", () => {
    const out = stripSqlComments(`/* outer /* inner */ still */ CREATE TABLE "a" ();`);
    assert.ok(!out.includes("outer"));
    assert.ok(!out.includes("inner"));
    assert.match(out, /CREATE TABLE/);
  });

  test("does not strip -- inside a string literal", () => {
    const out = stripSqlComments(`INSERT INTO t VALUES ('a -- not a comment');`);
    assert.match(out, /not a comment/);
  });

  test("does not strip inside a double-quoted identifier", () => {
    const out = stripSqlComments(`CREATE TABLE "we--ird" ();`);
    assert.match(out, /we--ird/);
  });
});

describe("migration checker — statement splitting", () => {
  test("splits on semicolons outside strings", () => {
    assert.equal(splitStatements(`CREATE TABLE a(); CREATE TABLE b();`).length, 2);
  });

  test("does not split on a semicolon inside a string", () => {
    assert.equal(splitStatements(`INSERT INTO t VALUES ('a;b');`).length, 1);
  });
});

describe("migration checker — destructive detection", () => {
  const cases: [string, string][] = [
    ["DROP TABLE", `DROP TABLE "Comment"`],
    ["DROP COLUMN", `ALTER TABLE "Video" DROP COLUMN "title"`],
    ["TRUNCATE", `TRUNCATE TABLE "Video"`],
    ["DELETE FROM", `DELETE FROM "Video"`],
    ["DROP TYPE", `DROP TYPE "TestStage"`],
    ["DROP INDEX", `DROP INDEX "some_idx"`],
    ["RENAME (data loss risk)", `ALTER TABLE "Video" RENAME TO "Vid"`],
    ["ON DELETE CASCADE", `ALTER TABLE "a" ADD CONSTRAINT f FOREIGN KEY ("b") REFERENCES "c"("id") ON DELETE CASCADE`],
  ];

  for (const [rule, sql] of cases) {
    test(`flags ${rule}`, () => {
      assert.ok(violations(sql).includes(rule), `${sql} should trip ${rule}`);
    });
  }

  test("additive statements are clean", () => {
    for (const sql of [
      `CREATE TABLE "qa_record" ("id" TEXT NOT NULL)`,
      `CREATE INDEX "i" ON "t"("c")`,
      `CREATE TYPE "TestStage" AS ENUM ('DIAGNOSTIC')`,
      `ALTER TABLE "t" ADD COLUMN "c" TEXT`,
    ]) {
      assert.deepEqual(violations(sql), [], `${sql} should be clean`);
    }
  });

  test("ON UPDATE CASCADE on a foreign key is NOT flagged", () => {
    const sql = `ALTER TABLE "Video" ADD CONSTRAINT "fk" FOREIGN KEY ("topicId") REFERENCES "Topic"("id") ON DELETE RESTRICT ON UPDATE CASCADE`;
    assert.deepEqual(violations(sql), [], "benign FK must not be reported");
  });

  test("enum value TRUNCATED_JSON does not trigger the TRUNCATE rule", () => {
    const sql = `CREATE TYPE "ScriptFailureType" AS ENUM ('VALID', 'TRUNCATED_JSON')`;
    assert.deepEqual(violations(sql), []);
  });
});

describe("migration checker — false negatives", () => {
  test("a DROP preceded by a Prisma comment IS caught", () => {
    // Regression: the original implementation discarded any statement whose
    // chunk began with "--", and Prisma emits a comment before every
    // statement, so every migration passed unconditionally.
    const { bad } = checkMigrationSql(`-- CreateTable\nDROP TABLE "Comment";\n`);
    assert.equal(bad.length, 1);
    assert.ok(bad[0].rules.includes("DROP TABLE"));
  });

  test("real repo migration 0012 parses to its actual statements", () => {
    const sql = require("node:fs").readFileSync(
      "prisma/migrations/0012_reliability_qa_cost_models/migration.sql", "utf8",
    );
    const { statements, bad } = checkMigrationSql(sql);
    assert.ok(statements.length >= 15, `expected many statements, got ${statements.length}`);
    assert.deepEqual(bad, []);
  });

  test("destructive SQL only inside a comment is NOT a false positive", () => {
    const { bad } = checkMigrationSql(`-- we used to DROP TABLE "Comment" here\nCREATE TABLE "x" ();`);
    assert.deepEqual(bad, []);
  });
});

describe("migration checker — process behaviour", () => {
  test("exits zero on the repository's committed migrations", () => {
    const out = execFileSync("node", ["scripts/check-migrations.mjs"], { encoding: "utf8" });
    assert.match(out, /0 destructive/);
  });

  test("exits non-zero and names the file when a migration is destructive", () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = require("node:fs");
    const { tmpdir } = require("node:os");
    const { join } = require("node:path");
    const dir = mkdtempSync(join(tmpdir(), "migcheck-"));
    mkdirSync(join(dir, "prisma", "migrations", "0099_bad"), { recursive: true });
    writeFileSync(
      join(dir, "prisma", "migrations", "0099_bad", "migration.sql"),
      `-- DropTable\nDROP TABLE "MonitorAction";\n`,
    );
    let status = 0;
    let output = "";
    try {
      output = execFileSync(
        "node",
        [join(process.cwd(), "scripts/check-migrations.mjs"), "--baseline", "0000"],
        { cwd: dir, encoding: "utf8", stdio: "pipe" },
      );
    } catch (e: any) {
      status = e.status;
      output = (e.stdout ?? "") + (e.stderr ?? "");
    }
    assert.equal(status, 1, "must exit non-zero");
    assert.match(output, /0099_bad/, "must name the offending migration");
    assert.match(output, /DROP TABLE/, "must name the offending statement");
  });
});
