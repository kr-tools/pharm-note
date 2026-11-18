#!/usr/bin/env node
/* =========================================================
   PHARM NOTE — AI 약사 실무 분석 '초안' 만들기
   ---------------------------------------------------------
   순서: ① 식약처 공식 데이터 모으기 → ② AI에게 초안 요청
         → ③ 'draft(검토 전)' 상태로 저장
   관리자가 검토·승인하기 전에는 어디에도 공개되지 않습니다.

   - API 키: 환경변수 ANTHROPIC_API_KEY (GitHub Secrets)
   - 모델:   환경변수 AI_MODEL (없으면 claude-sonnet-5-5)
   - 키가 없거나 API 오류가 나도 앱의 다른 기능에는 영향 없음

   직접 실행: node scripts/generate-analysis.mjs            (초안 없는 후보 전부)
             node scripts/generate-analysis.mjs 202600123  (특정 제품만)
   ========================================================= */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_MODEL = "claude-sonnet-5-5";
const API_URL = process.env.AI_API_URL || "https://api.anthropic.com/v1/messages";
const API_VERSION = "2026-10-21";

const readJSON = async (f, fb) => {
  try { return JSON.parse(await readFile(f, "utf8")); } catch { return fb; }
};

const shardOf = (id) => String(id).slice(-2).padStart(2, "0");

async function loadDetail(dataDir, id, cache) {
  const key = shardOf(id);
  if (!cache[key]) cache[key] = await readJSON(path.join(dataDir, "otc", "detail", `${key}.json`), {});
  return cache[key][id] || null;
}

function ingredientRows(p) {
  const seen = new Set();
  return (p?.ingredientDetails || [])
    .filter((d) => {
      const k = `${d.name}|${d.amount}|${d.unit}`;
      return d.name && !seen.has(k) && seen.add(k);
    })
    .map((d) => {
      const amt = /^\d+\.\d+$/.test(d.amount || "") ? d.amount.replace(/\.?0+$/, "") : d.amount;
      return `${d.name} ${[amt, d.unit].filter(Boolean).join(" ")}`.trim();
    });
}

const short = (s, n) => (s && s.length > n ? s.slice(0, n) + "…" : s || "");

/* ---------- ① 공식 데이터 모으기 ---------- */

async function collectOfficialData(dataDir, itemSeq) {
  const cache = {};
  const p = await loadDetail(dataDir, itemSeq, cache);
  if (!p) throw new Error("식약처 DB에서 이 제품의 상세 정보를 찾지 못했어요. (품목기준코드 확인 필요)");

  const target = {
    제품명: p.name,
    업체: p.company,
    허가일: p.permitDate,
    허가상태: p.status,
    의약품분류: p.className,
    제형_제품명기준: p.form,
    성분및함량: ingredientRows(p),
    효능효과: p.easy?.efficacy || "",
    용법용량: p.easy?.useMethod || "",
    금기경고: p.easy?.warning || "",
    주의사항: p.easy?.caution || "",
    상호작용: p.easy?.interaction || "",
    이상반응: p.easy?.sideEffect || "",
    보관법: p.easy?.storage || "",
  };

  // 비교 대상: 유효성분 구성이 같은 제품 → 없으면 주성분 하나를 공유하는 제품
  const otc = await readJSON(path.join(dataDir, "otc-products.json"), { columns: [], rows: [] });
  const ci = (c) => otc.columns.indexOf(c);
  const setKey = (s) => String(s || "").split(" · ").map((x) => x.replace(/\s/g, "")).filter(Boolean).sort().join("|");
  const myKey = setKey(p.ingredients.join(" · "));
  const first = (p.ingredients[0] || "").replace(/\s/g, "");
  const rows = otc.rows.filter((r) => r[ci("id")] !== p.id && r[ci("status")] === "정상");
  let similar = rows.filter((r) => setKey(r[ci("ingredients")]) === myKey);
  let basis = "유효성분 구성이 같은 제품";
  if (!similar.length && first) {
    similar = rows.filter((r) => setKey(r[ci("ingredients")]).split("|").includes(first));
    basis = `주성분(${p.ingredients[0]})을 함께 가진 제품`;
  }
  // 공급실적 있는 제품을 우선, 최대 8개
  similar = similar.sort((a, b) => (b[ci("supply")] || 0) - (a[ci("supply")] || 0)).slice(0, 8);

  const compared = [];
  for (const r of similar) {
    const d = await loadDetail(dataDir, r[ci("id")], cache);
    compared.push({
      id: r[ci("id")],
      제품명: r[ci("name")],
      업체: r[ci("company")],
      제형_제품명기준: r[ci("form")],
      성분및함량: d ? ingredientRows(d) : String(r[ci("ingredients")] || "").split(" · "),
      용법용량: short(d?.easy?.useMethod, 200),
    });
  }
  return { target, compared, basis };
}

/* ---------- ② AI에게 초안 요청 ---------- */

const SYSTEM = `당신은 한국 약국에서 일하는 약사를 돕는 보조자입니다.
아래 규칙을 반드시 지키세요.
1. 제공된 식약처 공식 데이터(JSON)에 있는 내용만 근거로 씁니다.
2. 데이터에 없는 효능, 안전성, 임상 근거, 가격, 출시 배경을 만들어내지 않습니다.
3. 비교는 제공된 비교 제품 데이터(성분·함량·제형·용법)로만 합니다. 우열을 단정하지 않습니다.
4. 필요한 정보가 데이터에 없으면 "제공된 허가정보에 없음 — 원문 확인 필요"라고 씁니다.
5. 제형은 제품명 기준 분류라는 점을 감안하고, 확실하지 않으면 단정하지 않습니다.
6. 각 항목은 "• "로 시작하는 짧은 문장 2~5개로, 약사가 바로 읽을 수 있는 한국어로 씁니다.
7. 출력은 아래 JSON 하나만 씁니다. 다른 말은 쓰지 않습니다.
{"differences": "...", "formNotes": "...", "counseling": "...", "practicePoints": "..."}
- differences: 기존(비교) 제품과의 차이점 — 성분 구성, 함량, 제형, 복용 방법 차이
- formNotes: 제형상의 특징과 복용 방법
- counseling: 복약지도·환자 상담 시 확인/주의할 점 (허가사항의 금기·경고·주의사항 근거)
- practicePoints: 약국 실무 포인트 (진열·추천 대상 확인·중복 성분 주의 등, 허가사항 범위 안에서)`;

async function callAI(payload, model) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("AI API 키(ANTHROPIC_API_KEY)가 설정되지 않았어요.");

  const body = JSON.stringify({
    model,
    max_tokens: 2000,
    system: SYSTEM,
    messages: [{ role: "user", content: `다음 공식 데이터로 약사 실무 분석 초안을 JSON으로 작성하세요.\n\n${JSON.stringify(payload, null, 1)}` }],
  });

  const send = (auth) =>
    fetch(API_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": API_VERSION, ...auth },
      body,
      signal: AbortSignal.timeout(120000),
    });

  let res = await send({ "x-api-key": key });
  if (res.status === 401) res = await send({ authorization: `Bearer ${key}` });
  const text = await res.text();
  if (!res.ok) throw new Error(`AI API 오류 (${res.status}): ${text.slice(0, 300)}`);

  const json = JSON.parse(text);
  const out = (json.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
  const m = out.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("AI 응답에서 결과(JSON)를 찾지 못했어요.");
  const r = JSON.parse(m[0]);
  const pick = (k) => String(r[k] || "").trim().slice(0, 3000);
  return { differences: pick("differences"), formNotes: pick("formNotes"), counseling: pick("counseling"), practicePoints: pick("practicePoints"), model: json.model || model };
}

/* ---------- ③ 저장 ---------- */

// 한 제품의 초안 만들기 (관리자 요청 처리에서도 사용)
export async function generateFor(itemSeq, { dataDir = "data" } = {}) {
  const file = path.join(dataDir, "pharmacist-analysis.json");
  const store = await readJSON(file, { updatedAt: null, items: {} });
  store.items ||= {};
  const model = process.env.AI_MODEL || DEFAULT_MODEL;
  const now = new Date().toISOString();

  try {
    const { target, compared, basis } = await collectOfficialData(dataDir, itemSeq);
    const ai = await callAI({ 분석대상: target, 비교기준: basis, 비교제품: compared }, model);
    store.items[itemSeq] = {
      status: "draft",
      ...ai,
      generatedAt: now,
      basedOn: { official: "식약처 의약품 제품 허가정보·주성분·e약은요", comparedBasis: basis, comparedIds: compared.map((c) => c.id) },
    };
    return { ok: true, name: target.제품명 };
  } catch (e) {
    // 실패 기록만 남기고, 기존에 승인된 분석은 그대로 둠
    const prev = store.items[itemSeq];
    store.items[itemSeq] = { ...(prev || { status: "none" }), lastError: e.message, lastErrorAt: now };
    return { ok: false, error: e.message };
  } finally {
    store.updatedAt = now;
    await writeFile(file, JSON.stringify(store, null, 2) + "\n");
  }
}

/* ---------- 직접 실행할 때 ---------- */

async function main() {
  const dataDir = process.env.DATA_DIR || "data";
  const only = process.argv[2];
  let ids;
  if (only) {
    ids = [only];
  } else {
    // 후보(확인 대기·확인 완료) 중 품목기준코드가 있고 초안이 아직 없는 제품
    const pending = await readJSON(path.join(dataDir, "pending-products.json"), { items: {} });
    const store = await readJSON(path.join(dataDir, "pharmacist-analysis.json"), { items: {} });
    ids = Object.values(pending.items || {})
      .filter((c) => c.itemSeq && ["pending", "confirmed"].includes(c.status))
      .map((c) => c.itemSeq)
      .filter((id) => !["draft", "approved"].includes(store.items?.[id]?.status));
  }
  if (!ids.length) return console.log("초안을 만들 제품이 없어요.");
  let ok = 0;
  for (const id of ids.slice(0, 30)) {
    const r = await generateFor(id, { dataDir });
    console.log(r.ok ? `✅ ${id} ${r.name}` : `⚠️ ${id} ${r.error}`);
    if (r.ok) ok++;
  }
  console.log(`완료: ${ok}/${Math.min(ids.length, 30)}개 초안 생성`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((e) => { console.error("❌", e.message); process.exit(1); });
}
