#!/usr/bin/env node
/* =========================================================
   PHARM NOTE — 주간 신제품 '후보' 모으기
   ---------------------------------------------------------
   매주 월요일 GitHub Actions에서 실행됩니다.
   대상 기간: 지난주 월요일 ~ 일요일 (한국 시간)

   ① 식약처 신규 허가: 기간 안에 허가된 일반의약품
   ② 출시 뉴스: 네이버 뉴스에서 '출시' 기사 → 제품명을 식약처 DB와 맞춰봄
      (허가일과 무관하게 실제 출시 소식을 찾기 위함)

   모든 후보는 '확인 대기'로만 저장됩니다. 출시 여부를 추측해서
   확정하지 않으며, 브리핑 등록은 관리자 승인 후에만 이뤄집니다.

   이미 후보에 있거나, 승인·삭제된 제품은 다시 올리지 않습니다.
   ========================================================= */

import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

const DATA = process.env.DATA_DIR || "data";
const NAVER_ID = process.env.NAVER_CLIENT_ID;
const NAVER_SECRET = process.env.NAVER_CLIENT_SECRET;
const HUB_URL = process.env.NAVER_HUB_URL || "https://naverapihub.apigw.ntruss.com/search/v1/news";
const DEV_URL = process.env.NAVER_DEV_URL || "https://openapi.naver.com/v1/search/news.json";

// 출시 기사를 찾는 검색어 (필요하면 여기서 추가·수정)
const QUERIES = [
  "일반의약품 출시",
  "일반약 출시",
  "OTC 신제품 출시",
  "약국 신제품 출시 의약품",
  "제약 신제품 출시 정",
  "제약 신제품 출시 캡슐",
  "제약 신제품 출시 시럽",
];

const readJSON = async (f, fb) => {
  try { return JSON.parse(await readFile(f, "utf8")); } catch { return fb; }
};
const writeJSON = (f, o) => writeFile(f, JSON.stringify(o, null, 2) + "\n");
const log = (...a) => console.log(...a);

/* ---------- 기간 (지난주 월~일, 한국 시간) ---------- */

function lastWeekKST(now = new Date()) {
  const kst = new Date(now.getTime() + 9 * 3600e3);
  const today = new Date(Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate()));
  const dow = (today.getUTCDay() + 6) % 7; // 월=0
  const thisMon = new Date(today); thisMon.setUTCDate(today.getUTCDate() - dow);
  const start = new Date(thisMon); start.setUTCDate(thisMon.getUTCDate() - 7);
  const end = new Date(thisMon); end.setUTCDate(thisMon.getUTCDate() - 1);
  const iso = (d) => d.toISOString().slice(0, 10);
  return { start: iso(start), end: iso(end), today: iso(today) };
}

/* ---------- 제품명 정리 ---------- */

const FORM_SUFFIX = /(연질캡슐|경질캡슐|캡슐|필름코팅정|서방정|츄어블정|발포정|정|건조시럽|시럽|현탁액|내복액|액|과립|산|연고|크림|겔|로션|패취|패치|플라스타|카타플라스마|점안액|트로키|좌제)$/;

function baseName(name) {
  let s = String(name || "");
  for (let i = 0; i < 5 && /\([^()]*\)/.test(s); i++) s = s.replace(/\([^()]*\)/g, "");
  return s.replace(/[()[\]]/g, "").replace(/[\d.,/\s]*(밀리그램|밀리그람|마이크로그램|mg|g|mL|ml|%|호)?\s*$/i, "").replace(/\s/g, "");
}
// 기사에서는 "○○정" 대신 "○○"로 쓰는 경우가 많아 제형 글자를 뺀 이름도 준비
const coreName = (base) => base.replace(FORM_SUFFIX, "");

const stripTags = (s) =>
  String(s || "").replace(/<[^>]*>/g, "").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'");

/* ---------- 네이버 뉴스 검색 ---------- */

async function searchNews(query) {
  const qs = `query=${encodeURIComponent(query)}&display=100&start=1&sort=date`;
  // 1) NAVER API HUB (현재 방식) → 2) 실패(401/403)하면 예전 개발자센터 방식
  const tries = [
    [`${HUB_URL}?${qs}&format=json`, { "X-NCP-APIGW-API-KEY-ID": NAVER_ID, "X-NCP-APIGW-API-KEY": NAVER_SECRET }],
    [`${DEV_URL}?${qs}`, { "X-Naver-Client-Id": NAVER_ID, "X-Naver-Client-Secret": NAVER_SECRET }],
  ];
  let lastErr;
  for (const [url, headers] of tries) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
      const text = await res.text();
      if (res.status === 401 || res.status === 403) { lastErr = new Error(`인증 실패 (${res.status})`); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 150)}`);
      return JSON.parse(text).items || [];
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

/* ---------- 메인 ---------- */

async function main() {
  const win = lastWeekKST(process.env.NOW ? new Date(process.env.NOW) : new Date());
  log(`대상 기간: ${win.start} ~ ${win.end}`);
  // 기사 요약에만 이름이 나온 제품은 '최근 12개월 안에 허가된 제품'만 후보로
  const recentSince = (() => {
    const d = new Date(`${win.today}T00:00:00Z`);
    d.setUTCFullYear(d.getUTCFullYear() - 1);
    return d.toISOString().slice(0, 10);
  })();

  const otc = await readJSON(path.join(DATA, "otc-products.json"), null);
  if (!otc?.rows?.length) throw new Error("의약품 DB(otc-products.json)가 비어 있어요.");
  const ci = (c) => otc.columns.indexOf(c);
  const products = otc.rows.filter((r) => !/수출용|수출전용/.test(r[ci("name")])).map((r) => ({
    id: r[ci("id")], name: r[ci("name")], company: r[ci("company")], ingredients: r[ci("ingredients")],
    permitDate: r[ci("permitDate")], status: r[ci("status")],
  }));

  const pending = await readJSON(path.join(DATA, "pending-products.json"), { updatedAt: null, items: {}, deleted: {} });
  pending.items ||= {};
  pending.deleted ||= {};
  const launch = await readJSON(path.join(DATA, "launch-evidence.json"), { items: {} });

  // 이미 다룬 제품인지 (후보·승인·삭제 모두 포함)
  const known = (id) => pending.items[id] || pending.deleted[id] || launch.items?.[id];
  const nedrug = (id) => `https://nedrug.mfds.go.kr/pbp/CCBBB01/getItemDetail?itemSeq=${id}`;

  const report = {
    runAt: new Date().toISOString(),
    period: { start: win.start, end: win.end },
    permits: { found: 0, added: 0 },
    news: { enabled: Boolean(NAVER_ID && NAVER_SECRET), articles: 0, launchArticles: 0, matched: 0, added: 0, unmatchedAdded: 0, sourceAppended: 0 },
    addedIds: [],
    warnings: [],
  };

  function addCandidate(c) {
    pending.items[c.id] = { status: "pending", firstSeen: win.today, ...c };
    report.addedIds.push(c.id);
  }

  /* ① 신규 허가 */
  const newPermits = products.filter((p) => p.status === "정상" && p.permitDate >= win.start && p.permitDate <= win.end);
  report.permits.found = newPermits.length;
  for (const p of newPermits) {
    if (known(p.id)) continue;
    addCandidate({
      id: p.id, itemSeq: p.id, name: p.name, company: p.company, ingredients: p.ingredients, permitDate: p.permitDate,
      origin: "permit",
      foundInfo: `식약처 신규 허가 (${p.permitDate}) — 실제 출시 여부는 아직 확인되지 않음`,
      sources: [{ title: "식약처 의약품안전나라", url: nedrug(p.id) }],
    });
    report.permits.added++;
  }
  log(`① 신규 허가 ${report.permits.found}건 중 새 후보 ${report.permits.added}건`);

  /* ② 출시 뉴스 */
  if (!report.news.enabled) {
    report.warnings.push("네이버 검색 키(NAVER_CLIENT_ID/SECRET)가 없어 뉴스 탐색을 건너뜀");
  } else {
    // 제품명 사전: 정확한 이름(제형 포함)과 제형을 뺀 이름
    const byBase = new Map();
    const byCore = new Map();
    for (const p of products.filter((x) => x.status === "정상")) {
      const b = baseName(p.name);
      const c = coreName(b);
      if (b.length >= 3) (byBase.get(b) || byBase.set(b, []).get(b)).push(p);
      if (c.length >= 3 && c !== b) (byCore.get(c) || byCore.set(c, []).get(c)).push(p);
    }
    const baseKeys = [...byBase.keys()].sort((a, b) => b.length - a.length);
    const coreKeys = [...byCore.keys()].sort((a, b) => b.length - a.length);

    // 기사 모으기 (중복 기사 제거, 기간 안의 기사만)
    const articles = new Map();
    for (const q of QUERIES) {
      try {
        for (const it of await searchNews(q)) {
          const d = new Date(it.pubDate);
          const kstDay = isNaN(d) ? "" : new Date(d.getTime() + 9 * 3600e3).toISOString().slice(0, 10);
          if (!kstDay || kstDay < win.start || kstDay > win.end) continue;
          const url = it.originallink || it.link;
          if (!articles.has(url)) articles.set(url, { url, naver: it.link, date: kstDay, title: stripTags(it.title), desc: stripTags(it.description) });
        }
      } catch (e) {
        report.warnings.push(`뉴스 검색 실패 "${q}": ${e.message}`);
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    report.news.articles = articles.size;

    // 제품명 찾기: 정확한 이름 → (없으면) 제형 글자를 뺀 이름. 같은 이름이 여럿이면 하나만
    const isExport = (p) => /수출|[A-Za-z]{4,}/.test(p.name);
    const best = (list) =>
      list.slice().sort((x, y) => isExport(x) - isExport(y) || String(y.permitDate).localeCompare(String(x.permitDate)))[0];
    function findProducts(text, filter = () => true) {
      const flat = String(text || "").replace(/\s/g, "");
      const hits = new Map();
      for (const [keys, dict, kind] of [[baseKeys, byBase, "exact"], [coreKeys, byCore, "core"]]) {
        for (const k of keys) {
          if (!flat.includes(k)) continue;
          const list = dict.get(k).filter(filter);
          if (!list.length) continue;
          const p = best(list);
          if (!hits.has(p.id)) hits.set(p.id, { p, how: list.length > 1 ? `similar:${list.length}` : kind });
          if (hits.size >= 3) break;
        }
        if (hits.size) break;
      }
      return hits;
    }

    for (const a of articles.values()) {
      // 규칙 ① 제목에 '신제품' 또는 '출시'가 있는 기사만
      if (!/신제품|출시/.test(a.title)) continue;
      report.news.launchArticles++;
      const text = `${a.title} ${a.desc}`;

      // 규칙 ② 제목에 나온 제품 → 후보
      let hits = findProducts(a.title);
      let where = "제목";
      // 규칙 ③ 제목에 없고 요약에만 나온 제품 → 최근 12개월 안에 허가된 제품만
      if (!hits.size) {
        hits = findProducts(a.desc, (p) => String(p.permitDate) >= recentSince);
        where = "기사 요약(최근 12개월 내 허가 제품)";
      }

      const source = { title: `[뉴스 ${a.date}] ${a.title}`.slice(0, 200), url: a.url };

      if (!hits.size) {
        // DB에 없는 제품명: '일반의약품'이 언급된 출시 기사만 이름 미확인 후보로
        if (!/일반의약품|일반약|OTC/i.test(text)) continue; // 건강기능식품 등 제외
        const id = "news-" + createHash("sha1").update(a.url).digest("hex").slice(0, 10);
        if (known(id)) continue;
        addCandidate({
          id, itemSeq: "", name: a.title.slice(0, 80), company: "", ingredients: "", permitDate: "",
          origin: "news",
          foundInfo: `출시 관련 기사 (${a.date}) — 식약처 DB에서 제품을 특정하지 못함. 품목기준코드 연결 필요`,
          sources: [source],
        });
        report.news.unmatchedAdded++;
        continue;
      }

      for (const { p, how } of hits.values()) {
        report.news.matched++;
        const existing = pending.items[p.id];
        if (existing) {
          // 이미 후보면 출처만 추가 (확인 대기·확인 불가 상태일 때)
          if (existing.status !== "confirmed" && !(existing.sources || []).some((s) => s.url === source.url)) {
            existing.sources = [...(existing.sources || []), source].slice(0, 8);
            report.news.sourceAppended++;
          }
          continue;
        }
        if (known(p.id)) continue;
        const note = how.startsWith("similar")
          ? ` · 이름이 같거나 비슷한 제품 ${how.split(":")[1]}개 중 하나로 연결 — 다른 제품인지 확인 필요`
          : "";
        addCandidate({
          id: p.id, itemSeq: p.id, name: p.name, company: p.company, ingredients: p.ingredients, permitDate: p.permitDate,
          origin: "news",
          foundInfo: `출시 기사 발견 (${a.date}, ${where}에서 제품명 확인)${note}`,
          sources: [source, { title: "식약처 의약품안전나라", url: nedrug(p.id) }],
        });
        report.news.added++;
      }
    }
    log(`② 뉴스 ${report.news.articles}건 (출시 기사 ${report.news.launchArticles}) → 새 후보 ${report.news.added + report.news.unmatchedAdded}건, 출처 추가 ${report.news.sourceAppended}건`);
  }

  pending.updatedAt = new Date().toISOString();
  await writeJSON(path.join(DATA, "pending-products.json"), pending);
  await writeJSON(path.join(DATA, "collect-report.json"), report);
  for (const w of report.warnings) log("⚠️", w);
  log(`✅ 완료: 새 후보 ${report.addedIds.length}건`);

  // 다음 단계(AI 자동 초안)에서 쓸 수 있도록 새 후보 목록을 남김
  if (process.env.GITHUB_OUTPUT) {
    const ids = report.addedIds.filter((id) => /^\d+$/.test(id)).join(" ");
    await writeFile(process.env.GITHUB_OUTPUT, `new_ids=${ids}\n`, { flag: "a" });
  }
}

main().catch((e) => {
  console.error("❌ 후보 수집 실패:", e.message);
  process.exit(1);
});
