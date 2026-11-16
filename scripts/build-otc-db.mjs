#!/usr/bin/env node
/* =========================================================
   PHARM NOTE — 전체 일반의약품 데이터베이스 만들기
   ---------------------------------------------------------
   GitHub Actions에서 실행됩니다. (브라우저에서 실행되지 않음)
   1) 식약처 '의약품 제품 허가정보'에서 일반의약품 목록을 모두 받음
   2) 식약처 'e약은요'에서 효능·용법·주의사항(공급실적 있는 일반의약품)을 받음
   3) 두 자료를 품목기준코드로 합쳐 검색용 JSON을 만듦

   필요한 값: 환경변수 MFDS_API_KEY (GitHub Secrets에 저장한 인증키)
   외부 라이브러리 없이 Node.js 20 이상에서 동작합니다.
   ========================================================= */

import { writeFile, readFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";

const KEY = process.env.MFDS_API_KEY;
const BASE = process.env.MFDS_BASE_URL || "https://apis.data.go.kr/1471000";
const OUT = process.env.OUT_DIR || "data";
const FORCE = process.env.FORCE === "1";
const ROWS = 100;

const APIS = {
  permit: {
    label: "의약품 제품 허가정보",
    path: "DrugPrdtPrmsnInfoService08/getDrugPrdtPrmsnInq08",
    params: { spclty_pblc: "일반의약품" },
  },
  easy: {
    label: "e약은요",
    path: "DrbEasyDrugInfoService/getDrbEasyDrugList",
    params: {},
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

/* ---------- API 호출 ---------- */

async function getPage(api, pageNo) {
  const url = new URL(`${BASE}/${api.path}`);
  const qs = { serviceKey: KEY, pageNo, numOfRows: ROWS, type: "json", ...api.params };
  for (const [k, v] of Object.entries(qs)) url.searchParams.set(k, v);

  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 30000);
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timer);
      const text = await res.text();

      // 인증키 오류 등은 type=json이어도 XML로 오는 경우가 있음
      if (text.trim().startsWith("<")) {
        const msg =
          (text.match(/<returnAuthMsg>([^<]+)/) || text.match(/<resultMsg>([^<]+)/) || [])[1] ||
          text.slice(0, 200);
        throw new Error(`API 오류 응답: ${msg}`);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);

      const json = JSON.parse(text);
      const header = json.header || json.response?.header;
      const body = json.body || json.response?.body;
      if (header?.resultCode && header.resultCode !== "00") {
        throw new Error(`API 오류 ${header.resultCode}: ${header.resultMsg}`);
      }
      if (!body) throw new Error("응답에 body가 없습니다");

      let items = body.items;
      if (items && !Array.isArray(items)) items = items.item ?? [];
      if (items && !Array.isArray(items)) items = [items];
      return { total: Number(body.totalCount) || 0, items: items || [] };
    } catch (e) {
      lastErr = e;
      // 인증키 문제는 다시 시도해도 같으므로 바로 중단
      if (/SERVICE_KEY|SERVICE KEY|등록되지 않은|인증/i.test(e.message)) break;
      log(`  재시도 ${attempt}/4 (${api.label} ${pageNo}페이지): ${e.message}`);
      await sleep(2000 * attempt);
    }
  }
  throw lastErr;
}

async function fetchAll(api) {
  const first = await getPage(api, 1);
  const pages = Math.ceil(first.total / ROWS);
  log(`${api.label}: 전체 ${first.total}건 / ${pages}페이지`);
  const all = [...first.items];
  for (let p = 2; p <= pages; p++) {
    const { items } = await getPage(api, p);
    all.push(...items);
    if (p % 25 === 0) log(`  ${api.label}: ${p}/${pages}페이지`);
    await sleep(120);
  }
  return { total: first.total, items: all };
}

/* ---------- 값 정리 ---------- */

const toCamel = (k) => k.toLowerCase().replace(/_([a-z])/g, (_, c) => c.toUpperCase());

// 같은 정보가 대문자/소문자/카멜표기로 올 수 있어 여러 이름을 차례로 확인
function pick(obj, keys) {
  for (const k of keys) {
    for (const cand of [k, k.toLowerCase(), toCamel(k)]) {
      const v = obj[cand];
      if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
    }
  }
  return "";
}

const stripTags = (s) => String(s || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

function toISODate(s) {
  const d = String(s || "").replace(/\D/g, "");
  return d.length >= 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : "";
}

// "[M040702]포도당|[M040426]염화나트륨" → ["포도당", "염화나트륨"]
function parseIngredients(s) {
  if (!s) return [];
  return String(s)
    .split(/[|;]/)
    .map((x) => x.replace(/\[[^\]]*\]/g, "").trim())
    .filter(Boolean);
}

// "[01140]해열.진통.소염제" → { code: "01140", name: "해열.진통.소염제" }
function parseClass(s) {
  const m = String(s || "").match(/\[(\d+)\]\s*(.+)/);
  return m ? { code: m[1], name: m[2].trim() } : { code: "", name: String(s || "").trim() };
}

// 제품명 끝부분으로 제형을 분류 (공식 '제형' 항목이 아니라 제품명 기준 분류임)
const FORM_RULES = [
  [/(연질캡슐|경질캡슐|캡슐|캅셀)$/, "캡슐제"],
  [/(점안액|점비액|점이액|안약)$/, "점안·점비제"],
  [/(트로키|껌|구강용해필름|필름)$/, "트로키·껌·필름"],
  [/(정)$/, "정제"],
  [/(시럽|건조시럽)$/, "시럽제"],
  [/(현탁액|내복액|액|드링크|엘릭서|용액)$/, "액제"],
  [/(과립|세립|산|가루)$/, "산·과립제"],
  [/(연고|크림|겔|젤|로션|외용액|스프레이|에어로솔|폼)$/, "외용제(연고·크림·액)"],
  [/(패취|패치|플라스타|카타플라스마|파프|첩부제|테이프)$/, "첩부제(파스)"],
  [/(좌제|좌약|질정|질좌제)$/, "좌제·질정"],
];

function guessForm(name) {
  const base = String(name || "")
    .replace(/\([^)]*\)/g, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/[\d.,/\s]*(밀리그램|mg|g|mL|ml|그램|%)?\s*$/i, "")
    .trim();
  for (const [re, label] of FORM_RULES) if (re.test(base)) return label;
  return "기타";
}

/* ---------- 메인 ---------- */

async function readPrevCount() {
  try {
    const prev = JSON.parse(await readFile(path.join(OUT, "otc-products.json"), "utf8"));
    return prev.demo ? 0 : Number(prev.count) || 0;
  } catch {
    return 0;
  }
}

async function main() {
  if (!KEY) {
    console.error("❌ MFDS_API_KEY가 없습니다. GitHub 저장소 Settings → Secrets에 등록했는지 확인하세요.");
    process.exit(1);
  }

  const warnings = [];

  // 1) 허가정보 (필수)
  const permit = await fetchAll(APIS.permit);
  const permitKeys = permit.items[0] ? Object.keys(permit.items[0]) : [];
  log("허가정보 항목 이름:", permitKeys.join(", "));

  // 2) e약은요 (실패해도 계속 진행)
  let easy = { total: 0, items: [] };
  let easyOk = true;
  try {
    easy = await fetchAll(APIS.easy);
  } catch (e) {
    easyOk = false;
    warnings.push(`e약은요 수집 실패: ${e.message} — 효능 텍스트·공급실적 표시 없이 진행`);
    log("⚠️", warnings.at(-1));
  }
  const easyKeys = easy.items[0] ? Object.keys(easy.items[0]) : [];

  const easyById = new Map();
  for (const it of easy.items) {
    const id = pick(it, ["itemSeq", "ITEM_SEQ"]);
    if (id) easyById.set(id, it);
  }

  // 3) 합치기
  const coverage = { ingredients: 0, class: 0, manufacturer: 0, permitDate: 0, status: 0, efficacy: 0 };
  const statusCounts = {};
  const formCounts = {};
  const products = new Map();
  let skippedEtc = 0;

  for (const it of permit.items) {
    const id = pick(it, ["ITEM_SEQ", "PRDLST_STDR_CODE", "itemSeq"]);
    if (!id) continue;

    // API가 필터를 무시하고 전문의약품을 섞어 보내는 경우 대비
    const kind = pick(it, ["SPCLTY_PBLC", "ETC_OTC_CODE", "ETC_OTC_NAME"]);
    if (kind && !kind.includes("일반")) { skippedEtc++; continue; }

    const name = pick(it, ["ITEM_NAME", "PRDUCT", "itemName"]);
    const cls = parseClass(pick(it, ["PRDUCT_TYPE", "CLASS_NO", "CLASS_NAME"]));
    const ingredients = parseIngredients(
      pick(it, ["ITEM_INGR_NAME", "MAIN_ITEM_INGR", "MAIN_INGR", "MATERIAL_NAME"])
    );
    const status = pick(it, ["CANCEL_NAME", "CANCEL_STATUS"]) || "정보 없음";
    const ez = easyById.get(id);

    const p = {
      id,
      name,
      company: pick(it, ["ENTP_NAME", "entpName"]),
      manufacturer: pick(it, ["CNSGN_MANUF", "MANUF_NAME"]),
      ingredients,
      ingredientsEng: pick(it, ["ITEM_INGR_ENG_NAME", "MAIN_INGR_ENG"]),
      form: guessForm(name),
      classCode: cls.code,
      className: cls.name,
      status,
      cancelDate: toISODate(pick(it, ["CANCEL_DATE"])),
      permitDate: toISODate(pick(it, ["ITEM_PERMIT_DATE", "PRMISN_DT"])),
      permitNo: pick(it, ["PRDUCT_PRMISN_NO", "ITEM_PERMIT_NO"]),
      ediCode: pick(it, ["EDI_CODE"]),
      supply: easyOk ? (ez ? 1 : 0) : null,
      easy: ez
        ? {
            efficacy: stripTags(pick(ez, ["efcyQesitm"])),
            useMethod: stripTags(pick(ez, ["useMethodQesitm"])),
            warning: stripTags(pick(ez, ["atpnWarnQesitm"])),
            caution: stripTags(pick(ez, ["atpnQesitm"])),
            interaction: stripTags(pick(ez, ["intrcQesitm"])),
            sideEffect: stripTags(pick(ez, ["seQesitm"])),
            storage: stripTags(pick(ez, ["depositMethodQesitm"])),
            updated: toISODate(pick(ez, ["updateDe"])),
          }
        : null,
    };

    if (p.ingredients.length) coverage.ingredients++;
    if (p.className) coverage.class++;
    if (p.manufacturer) coverage.manufacturer++;
    if (p.permitDate) coverage.permitDate++;
    if (status !== "정보 없음") coverage.status++;
    if (p.easy?.efficacy) coverage.efficacy++;
    statusCounts[status] = (statusCounts[status] || 0) + 1;
    formCounts[p.form] = (formCounts[p.form] || 0) + 1;

    products.set(id, p); // 같은 코드가 두 번 오면 나중 것으로 덮어씀(중복 제거)
  }

  const list = [...products.values()].sort((a, b) => a.name.localeCompare(b.name, "ko"));
  log(`일반의약품 ${list.length}건 정리 완료 (전문의약품 제외 ${skippedEtc}건)`);

  // 안전장치: 이전보다 크게 줄었다면 API 장애로 보고 덮어쓰지 않음
  const prevCount = await readPrevCount();
  if (!list.length || (prevCount && list.length < prevCount * 0.8 && !FORCE)) {
    console.error(
      `❌ 수집 건수가 비정상입니다 (이번 ${list.length}건 / 이전 ${prevCount}건). 기존 데이터를 유지하고 중단합니다.`
    );
    process.exit(1);
  }

  const updatedAt = new Date().toISOString();

  // 검색용 목록 (가볍게, 배열 형태로)
  const columns = [
    "id", "name", "company", "manufacturer", "ingredients", "form",
    "className", "status", "permitDate", "supply", "efficacy",
  ];
  const rows = list.map((p) => [
    p.id, p.name, p.company, p.manufacturer, p.ingredients.join(" · "), p.form,
    p.className, p.status, p.permitDate, p.supply,
    p.easy?.efficacy ? p.easy.efficacy.slice(0, 160) : "",
  ]);

  await mkdir(OUT, { recursive: true });
  await writeFile(
    path.join(OUT, "otc-products.json"),
    JSON.stringify({ updatedAt, count: list.length, supplyKnown: easyOk, columns, rows })
  );

  // 상세용 자료 (3단계 상세 페이지에서 사용) — 코드 끝 두 자리로 100개 파일에 나눠 저장
  const detailDir = path.join(OUT, "otc", "detail");
  await rm(detailDir, { recursive: true, force: true });
  await mkdir(detailDir, { recursive: true });
  const shards = {};
  for (const p of list) {
    const key = p.id.slice(-2).padStart(2, "0");
    (shards[key] ||= {})[p.id] = p;
  }
  for (const [key, obj] of Object.entries(shards)) {
    await writeFile(path.join(detailDir, `${key}.json`), JSON.stringify(obj));
  }

  // 점검용 보고서 (문제가 생기면 이 파일을 보면 원인을 알 수 있음)
  const report = {
    builtAt: updatedAt,
    sources: {
      permit: { api: APIS.permit.path, total: permit.total, received: permit.items.length, keys: permitKeys },
      easy: { api: APIS.easy.path, ok: easyOk, total: easy.total, received: easy.items.length, keys: easyKeys },
    },
    otcCount: list.length,
    skippedNonOtc: skippedEtc,
    statusCounts,
    formCounts,
    fieldCoverage: coverage,
    warnings,
  };
  await writeFile(path.join(OUT, "otc-build-report.json"), JSON.stringify(report, null, 2));

  log("✅ 완료");
  log(JSON.stringify({ otcCount: list.length, statusCounts, coverage }, null, 0));
}

main().catch((e) => {
  console.error("❌ 실패:", e.message);
  process.exit(1);
});
