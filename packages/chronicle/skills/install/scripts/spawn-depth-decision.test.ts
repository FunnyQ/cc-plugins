import { describe, expect, test } from "bun:test";

import { REQUIRED_DEPTH, decideSpawnDepth } from "./spawn-depth-decision";

describe("decideSpawnDepth", () => {
  test("需要的深度是 2 — main → orchestrator → child", () => {
    expect(REQUIRED_DEPTH).toBe(2);
  });

  test("settings 完全沒有 env 區塊時要寫入", () => {
    const decision = decideSpawnDepth({});
    expect(decision.action).toBe("write");
    expect(decision.value).toBe(2);
  });

  test("有 env 但沒有這個 key 時要寫入", () => {
    const decision = decideSpawnDepth({ env: { OTHER: "1" } });
    expect(decision.action).toBe("write");
    expect(decision.value).toBe(2);
  });

  test("值過低時要提高", () => {
    const decision = decideSpawnDepth({
      env: { CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "1" },
    });
    expect(decision.action).toBe("write");
    expect(decision.value).toBe(2);
  });

  test("值剛好足夠時不動", () => {
    const decision = decideSpawnDepth({
      env: { CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "2" },
    });
    expect(decision.action).toBe("ok");
  });

  test("值更高時保持不動 — 只提高、絕不降低", () => {
    const decision = decideSpawnDepth({
      env: { CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "5" },
    });
    expect(decision.action).toBe("ok");
  });

  test("值是數字型別而非字串時仍能判讀", () => {
    const decision = decideSpawnDepth({
      env: { CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: 3 },
    });
    expect(decision.action).toBe("ok");
  });

  test("值無法解析成數字時視為缺失並覆寫", () => {
    const decision = decideSpawnDepth({
      env: { CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "deep" },
    });
    expect(decision.action).toBe("write");
    expect(decision.value).toBe(2);
  });

  test("settings 不是物件時回報無法解析，不嘗試寫入", () => {
    expect(decideSpawnDepth(null).action).toBe("unparsable");
    expect(decideSpawnDepth([]).action).toBe("unparsable");
    expect(decideSpawnDepth("nope").action).toBe("unparsable");
  });

  test("env 存在但不是物件時回報無法解析", () => {
    expect(decideSpawnDepth({ env: "nope" }).action).toBe("unparsable");
  });

  test("每個決策都帶可直接顯示給使用者的理由", () => {
    for (const settings of [{}, { env: {} }, null]) {
      expect(decideSpawnDepth(settings).reason.length).toBeGreaterThan(0);
    }
  });
});
