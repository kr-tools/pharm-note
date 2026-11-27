#!/usr/bin/env node
/* =========================================================
   PHARM NOTE — 열린 관리자 요청(이슈)을 오래된 순으로 모두 처리
   ---------------------------------------------------------
   요청을 짧은 시간에 여러 개 보내면 GitHub이 대기 중인 실행을
   취소할 수 있어요. 그래서 실행될 때마다 '아직 열려 있는 요청'을
   전부 찾아 처리합니다. (중간에 취소된 요청도 다음 실행에서 처리)

   사용: node scripts/process-requests.mjs apply   → 데이터 반영 (커밋 전)
        node scripts/process-requests.mjs report  → 결과 댓글 + 이슈 닫기 (커밋 후)

   필요한 값: GH_TOKEN, REPO(owner/repo), OWNER(저장소 주인)
   ========================================================= */

import { execFileSync } from "node:child_process";
import { readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const REPO = process.env.REPO;
const OWNER = process.env.OWNER;
const RESULTS = process.env.RESULTS_FILE || path.join(os.tmpdir(), "pharm-requests.json");
const RUN_URL = process.env.RUN_URL || "";
const TITLE_MARK = "[PHARM NOTE]";

const gh = (args, input) => execFileSync("gh", args, { encoding: "utf8", input, stdio: ["pipe", "pipe", "inherit"] });

async function apply() {
  // 저장소 주인이 연 요청 이슈만 (다른 사람의 이슈는 무시)
  const list = JSON.parse(
    gh(["issue", "list", "--repo", REPO, "--state", "open", "--author", OWNER, "--limit", "100", "--json", "number,title,body"])
  )
    .filter((i) => i.title.startsWith(TITLE_MARK))
    .sort((a, b) => a.number - b.number);

  console.log(`처리할 요청 ${list.length}건: ${list.map((i) => "#" + i.number).join(", ") || "없음"}`);
  const results = [];

  for (const issue of list) {
    const resultFile = path.join(os.tmpdir(), `result-${issue.number}.md`);
    await rm(resultFile, { force: true });
    let ok = true;
    try {
      execFileSync("node", ["scripts/apply-decision.mjs"], {
        env: { ...process.env, ISSUE_BODY: issue.body || "", RESULT_FILE: resultFile },
        stdio: ["ignore", "inherit", "inherit"],
      });
    } catch {
      ok = false;
    }
    let message;
    try {
      message = (await readFile(resultFile, "utf8")).trim();
    } catch {
      message = "❌ 처리 결과를 만들지 못했어요. Actions 로그를 확인해 주세요.";
    }
    console.log(`#${issue.number} ${ok ? "성공" : "실패"}: ${message.split("\n")[0]}`);
    results.push({ number: issue.number, ok, message });
  }
  await writeFile(RESULTS, JSON.stringify(results));
}

async function report() {
  let results = [];
  try {
    results = JSON.parse(await readFile(RESULTS, "utf8"));
  } catch {
    return console.log("남길 결과가 없어요.");
  }
  for (const r of results) {
    const tail = r.ok
      ? "\n\n반영된 내용은 2~5분 뒤 사이트에 나타나요."
      : "\n\n이 요청은 반영되지 않아 닫았어요. 필요하면 관리자 화면에서 다시 요청해 주세요.";
    const body = `${r.message}${tail}${RUN_URL ? `\n(실행 기록: ${RUN_URL})` : ""}`;
    gh(["issue", "comment", String(r.number), "--repo", REPO, "--body-file", "-"], body);
    // 성공·실패 모두 닫아서 같은 요청이 반복 처리되지 않게 함 (실패 이유는 댓글에 남음)
    gh(["issue", "close", String(r.number), "--repo", REPO, "--reason", r.ok ? "completed" : "not planned"]);
  }
  console.log(`결과 댓글 ${results.length}건 남김`);
}

const mode = process.argv[2];
(mode === "report" ? report() : apply()).catch((e) => {
  console.error("❌", e.message);
  process.exit(1);
});
