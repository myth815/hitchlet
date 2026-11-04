import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { studioChildren } from "./studio-acceptance-children.mjs";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn) {
  for (let i = 0; i < 100; i++) {
    if (fn()) return;
    await wait(10);
  }
  throw Error("fixture timeout");
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "hitchlet-child-reload-")),
    file = join(dir, "child.mjs"),
    log = join(dir, "events");
  writeFileSync(log, "");
  writeFileSync(
    file,
    `import fs from 'node:fs';const log=process.env.EVENTS;fs.appendFileSync(log,'start:'+process.pid+'\\n');process.on('SIGTERM',()=>{fs.appendFileSync(log,'stop:'+process.pid+'\\n');process.exit(0)});setInterval(()=>{},1000);`,
  );
  return {
    dir,
    file,
    log,
    events: () => readFileSync(log, "utf8").trim().split("\n"),
    options: { env: { ...process.env, EVENTS: log }, stdio: "ignore" },
  };
}
test("reload stops old real child before replacement while caller parent remains alive", async () => {
  const f = fixture(),
    failures = [],
    g = studioChildren({ onFailure: (e) => failures.push(e) }),
    parent = process.pid;
  try {
    const a = g.start(f.file, f.options);
    await until(() => f.events()[0] === "start:" + a.pid);
    await g.stop();
    assert.ok(f.events().includes("stop:" + a.pid));
    const b = g.start(f.file, f.options);
    await until(() => f.events().includes("start:" + b.pid));
    assert.notEqual(a.pid, b.pid);
    assert.equal(process.pid, parent);
    assert.deepEqual(failures, []);
    assert.ok(
      f.events().indexOf("stop:" + a.pid) <
        f.events().indexOf("start:" + b.pid),
    );
    await g.stop();
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});
test("unexpected child exit is reported without terminating parent", async () => {
  const f = fixture(),
    errors = [],
    g = studioChildren({ onFailure: (e) => errors.push(e) });
  try {
    const a = g.start(f.file, f.options);
    await until(() => f.events()[0] === "start:" + a.pid);
    a.kill("SIGTERM");
    await until(() => errors.length === 1);
    assert.match(errors[0].message, /child exited/);
    await g.stop();
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});
test("nonterminating child returns bounded failure rather than claiming stop", async () => {
  const f = fixture();
  writeFileSync(
    f.file,
    `process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000);`,
  );
  let ready = false;
  const g = studioChildren({ onFailure: () => {}, timeoutMs: 50 }),
    a = g.start(f.file, { stdio: ["ignore", "pipe", "ignore"] });
  try {
    a.stdout.once("data", () => (ready = true));
    await until(() => ready);
    await assert.rejects(g.stop(), /did not stop/);
    assert.equal(a.exitCode, null);
  } finally {
    a.kill("SIGKILL");
    await new Promise((r) => a.once("exit", r));
    rmSync(f.dir, { recursive: true, force: true });
  }
});
