#!/usr/bin/env node
/**
 * Verifies committed migrations are additive.
 *
 * Prisma emits a `-- CreateTable` style comment before every statement, so a
 * naive "skip lines starting with --" filter discards the entire file and
 * reports success no matter what the migration does. Comments are therefore
 * stripped by a real tokenizer that respects string literals and dollar
 * quoting, and statements are split outside strings.
 *
 *   node scripts/check-migrations.mjs [--baseline <dirname>] [--list]
 *
 * Exit 0 when every in-scope migration is additive, non-zero otherwise.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const DIR = "prisma/migrations";

/**
 * Migrations at or before this one predate the safety checker. They are
 * reported but not failed, because rewriting applied history is more dangerous
 * than the statements themselves. Everything after it must be additive.
 */
const DEFAULT_BASELINE = "0011_add_videosnapshot_isshort";

// ── SQL preprocessing ─────────────────────────────────────────────────────

/**
 * Remove `--` line comments and block comments, leaving string literals and
 * dollar-quoted bodies untouched.
 */
export function stripSqlComments(sql) {
  let out = "";
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];

    // Single-quoted string
    if (ch === "'") {
      out += ch;
      i++;
      while (i < n) {
        out += sql[i];
        if (sql[i] === "'" && sql[i + 1] === "'") { out += sql[i + 1]; i += 2; continue; }
        if (sql[i] === "'") { i++; break; }
        i++;
      }
      continue;
    }

    // Double-quoted identifier
    if (ch === '"') {
      out += ch;
      i++;
      while (i < n) {
        out += sql[i];
        if (sql[i] === '"') { i++; break; }
        i++;
      }
      continue;
    }

    // Dollar-quoted body: $tag$ ... $tag$
    if (ch === "$") {
      const m = /^\$[A-Za-z_0-9]*\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        const stop = end === -1 ? n : end + tag.length;
        out += sql.slice(i, stop);
        i = stop;
        continue;
      }
    }

    // Line comment
    if (ch === "-" && next === "-") {
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }

    // Block comment (nestable in Postgres)
    if (ch === "/" && next === "*") {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") { depth++; i += 2; continue; }
        if (sql[i] === "*" && sql[i + 1] === "/") { depth--; i += 2; continue; }
        i++;
      }
      continue;
    }

    out += ch;
    i++;
  }
  return out;
}

/** Split on `;` that lie outside string literals. */
export function splitStatements(sql) {
  const stmts = [];
  let cur = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    if (ch === "'" || ch === '"') {
      const q = ch;
      cur += ch;
      i++;
      while (i < n) {
        cur += sql[i];
        if (sql[i] === q && !(q === "'" && sql[i + 1] === "'")) { i++; break; }
        if (q === "'" && sql[i] === "'" && sql[i + 1] === "'") { cur += sql[i + 1]; i += 2; continue; }
        i++;
      }
      continue;
    }
    if (ch === ";") { stmts.push(cur.trim()); cur = ""; i++; continue; }
    cur += ch;
    i++;
  }
  if (cur.trim()) stmts.push(cur.trim());
  return stmts.filter(Boolean);
}

// ── Destructive patterns ──────────────────────────────────────────────────

export const RULES = [
  { name: "DROP TABLE",        re: /\bDROP\s+TABLE\b/i },
  { name: "DROP COLUMN",       re: /\bDROP\s+COLUMN\b/i },
  { name: "DROP TYPE",         re: /\bDROP\s+TYPE\b/i },
  { name: "DROP SCHEMA",       re: /\bDROP\s+SCHEMA\b/i },
  { name: "DROP DATABASE",     re: /\bDROP\s+DATABASE\b/i },
  { name: "DROP INDEX",        re: /\bDROP\s+INDEX\b/i },
  { name: "DROP CONSTRAINT",   re: /\bDROP\s+CONSTRAINT\b/i },
  { name: "TRUNCATE",          re: /\bTRUNCATE\b/i },
  { name: "DELETE FROM",       re: /\bDELETE\s+FROM\b/i },
  { name: "RENAME (data loss risk)", re: /\bALTER\s+TABLE\b[\s\S]*\bRENAME\b/i },
  // Only genuinely destructive CASCADE forms. `ON UPDATE CASCADE` on a foreign
  // key is ordinary Prisma output and propagates key changes, not deletions —
  // flagging it made every historical migration look destructive.
  { name: "DROP ... CASCADE",  re: /\b(DROP|TRUNCATE)\b[\s\S]*\bCASCADE\b/i },
  { name: "ON DELETE CASCADE", re: /\bON\s+DELETE\s+CASCADE\b/i },
  // Narrowing a column type can truncate data.
  { name: "ALTER COLUMN TYPE", re: /\bALTER\s+COLUMN\b[\s\S]*\bTYPE\b/i },
];

/** Classify one statement. Returns matched rule names. */
export function violations(stmt) {
  return RULES.filter((r) => r.re.test(stmt)).map((r) => r.name);
}

export function summarize(stmts) {
  const kinds = {};
  for (const s of stmts) {
    const m = s.match(/^\s*(CREATE\s+(?:UNIQUE\s+)?[A-Z]+|ALTER\s+TABLE|INSERT|UPDATE)/i);
    const k = m ? m[1].toUpperCase().replace(/\s+/g, " ") : "OTHER";
    kinds[k] = (kinds[k] ?? 0) + 1;
  }
  return Object.entries(kinds).map(([k, v]) => `${v}×${k}`).join(", ");
}

// ── Runner ────────────────────────────────────────────────────────────────

export function checkMigrationSql(sql) {
  const stmts = splitStatements(stripSqlComments(sql));
  const bad = [];
  for (const s of stmts) {
    const v = violations(s);
    if (v.length) bad.push({ statement: s, rules: v });
  }
  return { statements: stmts, bad };
}

function main() {
  const argv = process.argv.slice(2);
  const baselineIdx = argv.indexOf("--baseline");
  const baseline = baselineIdx >= 0 ? argv[baselineIdx + 1] : DEFAULT_BASELINE;

  if (!existsSync(DIR)) {
    console.error(`no ${DIR} directory`);
    process.exit(1);
  }

  const names = readdirSync(DIR)
    .filter((d) => existsSync(join(DIR, d, "migration.sql")))
    .sort();

  let enforced = 0;
  let failed = 0;
  const historical = [];

  console.log(`Migration safety check — baseline: ${baseline}\n`);

  for (const name of names) {
    const sql = readFileSync(join(DIR, name, "migration.sql"), "utf8");
    const { statements, bad } = checkMigrationSql(sql);
    const inScope = name > baseline;

    if (!inScope) {
      if (bad.length) {
        historical.push({ name, bad });
        console.log(`· ${name} — ${statements.length} stmt(s), ${bad.length} destructive (pre-baseline, reported only)`);
      } else {
        console.log(`· ${name} — ${statements.length} stmt(s), additive (pre-baseline)`);
      }
      continue;
    }

    enforced++;
    if (bad.length) {
      failed++;
      console.error(`\n✗ ${name} — ${bad.length} destructive statement(s):`);
      for (const b of bad) {
        console.error(`    [${b.rules.join(", ")}]`);
        console.error(`      ${b.statement.replace(/\s+/g, " ").slice(0, 160)}`);
      }
    } else {
      console.log(`✓ ${name} — ${statements.length} stmt(s), additive (${summarize(statements)})`);
    }
  }

  if (historical.length) {
    console.log(
      `\nPre-baseline migrations containing destructive statements (already applied, not rewritten):`,
    );
    for (const h of historical) {
      console.log(`  ${h.name}:`);
      for (const b of h.bad) {
        console.log(`    [${b.rules.join(", ")}] ${b.statement.replace(/\s+/g, " ").slice(0, 120)}`);
      }
    }
  }

  console.log(
    `\n${names.length} migration(s) found, ${enforced} enforced (after ${baseline}), ${failed} destructive.`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

// Only run when executed directly, so tests can import the helpers.
if (process.argv[1] && process.argv[1].endsWith("check-migrations.mjs")) main();
