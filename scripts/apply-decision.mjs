#!/usr/bin/env node
/* =========================================================
   PHARM NOTE — 관리자 결정 반영
   ---------------------------------------------------------
   GitHub 이슈(관리자 화면에서 만든 '승인 요청')의 내용을 읽어
   데이터 파일에 반영합니다. GitHub Actions에서만 실행됩니다.

   - 저장소 주인 여부는 워크플로(approve-product.yml)에서 먼저 확인
   - 실제 출시일 + 공식 근거 URL이 없으면 '확인 완료'로 바꾸지 않음
   - 한 번 처리된 제품은 고유 ID로 관리해 중복 등록되지 않음

   입력: 환경변수 ISSUE_BODY (이슈 본문)
   출력: data/ 파일 수정 + RESULT_FILE(처리 결과 문장)
   ========================================================= */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const DATA = process.env.DATA_DIR || "data";
const RESULT_FILE = process.env.RESULT_FILE || "decision-result.md";
const MARKER = "<!-- pharm-note-request -->";

const F = {
  pending: path.join(DATA, "pending-products.json"),
  launch: path.join(DATA, "launch-evidence.json"),
  weekly: path.join(DATA, "weekly-briefings.json"),
  otc: path.join(DATA, "otc-products.json"),
};

class UserError extends Error {}

async function readJSON(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}
const writeJSON = (file, obj) => writeFile(file, JSON.stringify(obj, null, 2) + "\n");

/* ---------- 날짜 (한국 시간 기준) ---------- */

function todayKST() {
  return new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
}

function isValidDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || "")) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}

// 출시일이 속한 주의 월요일~일요일, 주차 ID(ISO 주차)
function weekOf(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // 월=0
  const mon = new Date(d); mon.setUTCDate(d.getUTCDate() - dow);
  const sun = new Date(mon); sun.setUTCDate(mon.getUTCDate() + 6);
  const thu = new Date(mon); thu.setUTCDate(mon.getUTCDate() + 3);
  const yearStart = new Date(Date.UTC(thu.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((thu - yearStart) / 864e5 + 1) / 7);
  const iso = (x) => x.toISOString().slice(0, 10);
  const md = (x) => `${x.getUTCMonth() + 1}월 ${x.getUTCDate()}일`;
  return {
    id: `${thu.getUTCFullYear()}-W${String(week).padStart(2, "0")}`,
    periodStart: iso(mon),
    periodEnd: iso(sun),
    title: `${md(mon)} – ${md(sun)} 신제품 브리핑`,
  };
}

/* ---------- 요청 읽기 ---------- */

function parseRequest(body) {
  const text = String(body || "");
  const at = text.indexOf(MARKER);
  if (at < 0) throw new UserError("관리자 화면에서 만든 요청이 아니에요. (표시 문구가 없음)");
  const m = text.slice(at).match(/```json\s*([\s\S]*?)```/);
  if (!m) throw new UserError("요청 내용(JSON)을 찾지 못했어요. 이슈 본문을 수정하지 말고 다시 시도해 주세요.");
  let req;
  try {
    req = JSON.parse(m[1]);
  } catch {
    throw new UserError("요청 내용(JSON) 형식이 깨졌어요. 관리자 화면에서 다시 요청해 주세요.");
  }
  if (!req || typeof req !== "object") throw new UserError("요청 내용이 비어 있어요.");
  return req;
}

// 줄바꿈은 살리고 나머지 제어문자만 제거 (AI 분석 본문용)
const cleanText = (s, max = 3000) => String(s ?? "").replace(/\r/g, "").replace(/[\u0000-\u0009\u000b-\u001f]/g, " ").trim().slice(0, max);
const clean = (s, max = 500) => String(s ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);

function cleanEvidence(list) {
  return (Array.isArray(list) ? list : [])
    .map((e) => ({ title: clean(e?.title, 200), url: clean(e?.url, 1000) }))
    .filter((e) => /^https?:\/\/[^\s]+\.[^\s]+/.test(e.url))
    .slice(0, 5);
}

/* ---------- 브리핑 반영 ---------- */

function removeFromBriefings(weekly, id) {
  for (const b of weekly.briefings) b.items = (b.items || []).filter((it) => it.id !== id);
  // 확인된 제품이 하나도 없는 주차는 목록에서 제외
  weekly.briefings = weekly.briefings.filter((b) => b.items.length);
}

function addToBriefing(weekly, entry) {
  removeFromBriefings(weekly, entry.id); // 출시일이 바뀐 경우 이전 주차에서 빼기
  const w = weekOf(entry.launchDate);
  let b = weekly.briefings.find((x) => x.id === w.id);
  if (!b) {
    b = { ...w, publishedAt: new Date().toISOString(), items: [] };
    weekly.briefings.push(b);
  }
  b.items.push(entry);
  b.items.sort((a, c) => String(a.launchDate).localeCompare(String(c.launchDate)));
  weekly.briefings.sort((a, c) => String(c.periodStart).localeCompare(String(a.periodStart)));
  return w;
}

/* ---------- 작업별 처리 ---------- */

async function main() {
  const req = parseRequest(process.env.ISSUE_BODY);
  const action = clean(req.action, 30);
  const id = clean(req.id, 80);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new UserError("제품 ID가 올바르지 않아요.");

  const pending = await readJSON(F.pending, { updatedAt: null, items: {}, deleted: {} });
  pending.items ||= {};
  pending.deleted ||= {};
  const launch = await readJSON(F.launch, { updatedAt: null, items: {} });
  launch.items ||= {};
  const weekly = await readJSON(F.weekly, { updatedAt: null, briefings: [] });
  weekly.briefings ||= [];

  const now = new Date().toISOString();
  const cand = pending.items[id];
  let result;

  if (action === "add") {
    // 식약처 DB에 있는 제품을 후보로 직접 추가
    if (!/^\d+$/.test(id)) throw new UserError("직접 추가는 품목기준코드(숫자)로만 할 수 있어요.");
    if (cand) throw new UserError(`이미 후보 목록에 있어요 (현재 상태: ${cand.status}).`);
    const otc = await readJSON(F.otc, null);
    const cols = otc?.columns || [];
    const row = (otc?.rows || []).find((r) => r[cols.indexOf("id")] === id);
    if (!row) throw new UserError("식약처 일반의약품 DB에서 이 품목기준코드를 찾지 못했어요.");
    const get = (c) => row[cols.indexOf(c)] ?? "";
    delete pending.deleted[id];
    pending.items[id] = {
      id,
      itemSeq: id,
      name: get("name"),
      company: get("company"),
      ingredients: get("ingredients"),
      permitDate: get("permitDate"),
      foundInfo: clean(req.memo) || "관리자가 직접 추가한 후보",
      sources: [{ title: "식약처 의약품안전나라", url: `https://nedrug.mfds.go.kr/pbp/CCBBB01/getItemDetail?itemSeq=${id}` }],
      firstSeen: todayKST(),
      status: "pending",
    };
    result = `✅ **${get("name")}** 을(를) '확인 대기' 후보로 추가했어요.`;
  } else {
    if (!cand) throw new UserError("후보 목록에서 이 제품을 찾지 못했어요. 이미 삭제됐을 수 있어요.");

    if (action === "confirm") {
      const launchDate = clean(req.launchDate, 10);
      const evidence = cleanEvidence(req.evidence);
      if (!isValidDate(launchDate)) throw new UserError("실제 출시일이 올바른 날짜(YYYY-MM-DD)가 아니에요.");
      if (launchDate > todayKST()) throw new UserError("출시일이 오늘 이후예요. 실제로 출시된 뒤에 승인해 주세요.");
      if (!evidence.length) throw new UserError("공식 출시 근거 URL이 없어요. 근거 URL이 있어야 승인할 수 있어요.");

      const itemSeq = clean(req.itemSeq || cand.itemSeq, 20);
      if (itemSeq && !/^\d+$/.test(itemSeq)) throw new UserError("품목기준코드는 숫자만 입력할 수 있어요.");
      const key = itemSeq || id;
      const seller = clean(req.seller, 100);

      Object.assign(cand, {
        status: "confirmed",
        itemSeq: itemSeq || "",
        launchDate,
        evidence,
        seller,
        memo: clean(req.memo, 1000),
        reviewedAt: now,
      });
      launch.items[key] = { launchDate, evidence, seller, confirmedAt: now, candidateId: id };
      if (key !== id) delete launch.items[id];

      const w = addToBriefing(weekly, {
        id: key,
        name: cand.name,
        company: cand.company,
        seller,
        ingredients: cand.ingredients ? String(cand.ingredients).split(" · ") : [],
        launchDate,
        evidence,
      });
      result = `✅ **${cand.name}** 출시 확인 완료 — 출시일 ${launchDate}, **${w.title}**에 등록했어요.`;
    } else if (action === "analyze") {
      // AI 초안 만들기 (공식 데이터 → AI → '검토 전' 상태로 저장)
      const itemSeq = cand.itemSeq;
      if (!itemSeq) throw new UserError("품목기준코드가 연결된 후보만 AI 초안을 만들 수 있어요.");
      const { generateFor } = await import("./generate-analysis.mjs");
      const compareIds = (Array.isArray(req.compareIds) ? req.compareIds : [])
        .map((x) => clean(x, 20)).filter((x) => /^\d+$/.test(x) && x !== itemSeq).slice(0, 4);
      const r = await generateFor(itemSeq, { dataDir: DATA, compareIds });
      if (!r.ok) throw new UserError(`AI 초안을 만들지 못했어요 — ${r.error} (공식 정보와 다른 기능은 정상이에요)`);
      result = `🤖 **${cand.name}** AI 분석 초안을 만들었어요. 관리자 화면에서 검토 후 승인해 주세요.`;
    } else if (action === "analysis_approve") {
      // 관리자가 검토(수정)한 AI 분석을 공개 승인
      const file = path.join(DATA, "pharmacist-analysis.json");
      const store = await readJSON(file, { updatedAt: null, items: {} });
      store.items ||= {};
      const key = cand.itemSeq || id;
      const prev = store.items[key];
      if (!prev || !["draft", "approved"].includes(prev.status)) throw new UserError("승인할 AI 초안이 없어요. 먼저 초안을 만들어 주세요.");
      const fields = ["differences", "formNotes", "counseling", "practicePoints"];
      const edited = Object.fromEntries(fields.map((f) => [f, cleanText(req[f])]));
      if (!fields.some((f) => edited[f])) throw new UserError("분석 내용이 비어 있어요.");
      store.items[key] = {
        ...prev,
        ...edited,
        status: "approved",
        reviewedAt: todayKST(),
        editedByAdmin: fields.some((f) => edited[f] !== (prev[f] || "")),
      };
      delete store.items[key].lastError;
      delete store.items[key].lastErrorAt;
      store.updatedAt = now;
      await writeJSON(file, store);
      result = `🟣 **${cand.name}** AI 분석을 검토 완료로 승인했어요. 이제 상세 페이지와 브리핑에 ‘AI 분석 · 관리자 검토 완료’로 표시돼요.`;
    } else if (action === "unconfirmable") {
      const key = cand.itemSeq || id;
      Object.assign(cand, { status: "unconfirmable", memo: clean(req.memo, 1000), reviewedAt: now });
      delete launch.items[key];
      removeFromBriefings(weekly, key);
      result = `⏸️ **${cand.name}** 을(를) '확인 불가'로 처리했어요. 브리핑에는 표시되지 않아요.`;
    } else if (action === "delete") {
      const key = cand.itemSeq || id;
      delete pending.items[id];
      pending.deleted[id] = now; // 자동 수집 때 다시 후보로 올라오지 않도록 기록
      delete launch.items[key];
      removeFromBriefings(weekly, key);
      result = `🗑️ **${cand.name}** 후보를 삭제했어요. 다음 자동 수집에서도 다시 올라오지 않아요.`;
    } else {
      throw new UserError(`알 수 없는 작업이에요: ${action}`);
    }
  }

  pending.updatedAt = launch.updatedAt = weekly.updatedAt = now;
  await writeJSON(F.pending, pending);
  await writeJSON(F.launch, launch);
  await writeJSON(F.weekly, weekly);
  await writeFile(RESULT_FILE, result + "\n");
  console.log(result);
}

main().catch(async (e) => {
  const msg = e instanceof UserError ? `❌ 반영하지 않았어요: ${e.message}` : `❌ 처리 중 오류가 났어요: ${e.message}`;
  console.error(msg);
  await writeFile(RESULT_FILE, msg + "\n").catch(() => {});
  process.exit(1);
});
