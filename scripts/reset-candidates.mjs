#!/usr/bin/env node
/* =========================================================
   PHARM NOTE — 자동 수집 후보 한 번에 정리
   ---------------------------------------------------------
   '확인 대기' 상태인 자동 수집 후보만 지웁니다.
   - 확인 완료 / 확인 불가 / 직접 추가한 후보는 그대로 둡니다.
   - '삭제 기록'을 남기지 않으므로, 다음 수집 때 새 규칙으로 다시 판단합니다.

   모드 (환경변수 MODE)
   - news : 뉴스로 모인 '확인 대기' 후보만
   - auto : 뉴스 + 신규 허가로 모인 '확인 대기' 후보 전부
   ========================================================= */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const DATA = process.env.DATA_DIR || "data";
const MODE = process.env.MODE || "news";
const file = path.join(DATA, "pending-products.json");

const pending = JSON.parse(await readFile(file, "utf8"));
const origins = MODE === "auto" ? ["news", "permit"] : ["news"];

const removed = [];
for (const [id, c] of Object.entries(pending.items || {})) {
  if (c.status === "pending" && origins.includes(c.origin)) {
    removed.push(`${c.name} (${c.origin === "news" ? "뉴스" : "신규 허가"})`);
    delete pending.items[id];
  }
}

pending.updatedAt = new Date().toISOString();
await writeFile(file, JSON.stringify(pending, null, 2) + "\n");
console.log(`✅ ${removed.length}건 정리했어요 (남은 후보 ${Object.keys(pending.items).length}건)`);
removed.slice(0, 100).forEach((n) => console.log(" -", n));
