// covers: subcommand:aidlc-utility:doctor, subcommand:aidlc-utility:plugin-sync

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPluginProjection,
  composePluginFixture,
  copyHarnessInstall,
} from "../harness/plugin-kit.ts";

const BUN = process.execPath;
const TIMEOUT_MS = 60_000;
const PLUGIN = "test-pro";
setDefaultTimeout(TIMEOUT_MS);

function graph(project: string): Array<{ slug?: string }> {
  return JSON.parse(
    readFileSync(join(project, ".claude", "tools", "data", "stage-graph.json"), "utf-8"),
  );
}

function runDoctor(project: string) {
  return spawnSync(
    BUN,
    [join(project, ".claude", "tools", "aidlc-utility.ts"), "doctor"],
    {
      cwd: project,
      encoding: "utf-8",
      timeout: TIMEOUT_MS - 5_000,
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: project,
        AIDLC_HARNESS_DIR: ".claude",
      },
    },
  );
}

describe("t314 doctor detects plugin composition erased by an engine reinstall", () => {
  let tmp: string;
  let pluginBuilt: string;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "aidlc-t314-"));
    pluginBuilt = join(tmp, "plugin", "claude");
    buildPluginProjection(PLUGIN, "claude", pluginBuilt);
  }, TIMEOUT_MS);

  afterAll(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  test("reinstall fails doctor until the plugin is composed again", () => {
    const project = join(tmp, "reinstall");
    composePluginFixture({
      plugin: PLUGIN,
      harness: "claude",
      projectDir: project,
      pluginBuilt,
    });
    expect(graph(project).some((stage) => stage.slug === "test-pro-integration")).toBe(true);
    expect(graph(project).some((stage) => stage.slug === "test-pro-full-suite")).toBe(true);

    copyHarnessInstall("claude", project);
    expect(graph(project).some((stage) => stage.slug === "test-pro-integration")).toBe(false);

    const broken = runDoctor(project);
    const brokenOut = `${broken.stdout ?? ""}${broken.stderr ?? ""}`;
    expect(broken.status).toBe(1);
    expect(brokenOut).toContain("Composed plugin surface:");
    expect(brokenOut).toContain("test-pro");
    expect(brokenOut).toContain("/aidlc plugin sync");
    expect(brokenOut).toContain("Uncompiled stage files:");
    expect(brokenOut).toContain("plugin-owned files");

    composePluginFixture({
      plugin: PLUGIN,
      harness: "claude",
      projectDir: project,
      pluginBuilt,
      copyInstall: false,
    });
    const repaired = runDoctor(project);
    expect(repaired.status).toBe(0);
    expect(repaired.stdout).toContain(
      "Composed plugin surface: all enabled plugin stages and recorded contributions are present",
    );
  });

  test("a stale contribution sidecar fails doctor even when plugin stages remain compiled", () => {
    const project = join(tmp, "stale-sidecar");
    composePluginFixture({
      plugin: PLUGIN,
      harness: "claude",
      projectDir: project,
      pluginBuilt,
    });
    expect(graph(project).some((stage) => stage.slug === "test-pro-integration")).toBe(true);

    cpSync(
      join(
        process.cwd(),
        "dist",
        "claude",
        ".claude",
        "aidlc-common",
        "stages",
        "construction",
        "build-and-test.md",
      ),
      join(
        project,
        ".claude",
        "aidlc-common",
        "stages",
        "construction",
        "build-and-test.md",
      ),
    );

    const broken = runDoctor(project);
    const brokenOut = `${broken.stdout ?? ""}${broken.stderr ?? ""}`;
    expect(broken.status).toBe(1);
    expect(brokenOut).toContain("Composed plugin surface:");
    expect(brokenOut).toContain("test-pro: stage build-and-test");
    expect(brokenOut).toContain("missing produces=");
    expect(brokenOut).toContain("/aidlc plugin sync");

    composePluginFixture({
      plugin: PLUGIN,
      harness: "claude",
      projectDir: project,
      pluginBuilt,
      copyInstall: false,
    });
    expect(runDoctor(project).status).toBe(0);
  });
});
