/* =========================================================
   PHARM NOTE — 주간 브리핑
   ---------------------------------------------------------
   data/weekly-briefings.json 에는 '출시 확인 완료'된 제품만 들어갑니다.
   (6단계 관리자 승인을 거친 제품만 자동으로 추가됨)

   브리핑 항목 형식:
   {
     "id": "2026-W46",                    // 주차 고유 ID
     "periodStart": "2026-11-09",          // 월요일
     "periodEnd": "2026-11-15",            // 일요일
     "title": "11월 9일 – 15일 신제품 브리핑",
     "publishedAt": "2026-11-16T08:00:00+09:00",
     "items": [
       {
         "id": "202600123",               // 품목기준코드 (식약처 DB와 연결)
         "name": "…", "company": "…",     // DB에 아직 없을 때 대신 표시
         "seller": "…",                   // 판매사 (확인된 경우)
         "launchDate": "2026-11-10",       // 실제 출시일 (관리자 확인)
         "evidence": [{ "title": "…", "url": "https://…" }]  // 공식 출시 근거
       }
     ]
   }
   ========================================================= */

(function () {
  const $ = (id) => document.getElementById(id);
  const esc = PN.escapeHTML;
  const nedrugURL = (id) => `https://nedrug.mfds.go.kr/pbp/CCBBB01/getItemDetail?itemSeq=${encodeURIComponent(id)}`;
  const safeURL = (u) => (/^https?:\/\//.test(u || "") ? u : "");

  let briefings = [];
  let analysis = {};

  async function load() {
    $("content").innerHTML = `
      <div class="skeleton" style="height:120px;border-radius:20px"></div>
      <div class="skeleton" style="height:260px;border-radius:16px;margin-top:14px"></div>`;
    try {
      const data = await PN.loadData("weekly-briefings.json");
      if (data.demo) $("demo-banner").hidden = false;
      $("updated-at").textContent = PN.formatUpdated(data.updatedAt);
      briefings = (Array.isArray(data.briefings) ? data.briefings : [])
        .slice()
        .sort((a, b) => String(b.periodStart).localeCompare(String(a.periodStart)));
    } catch (err) {
      return showError(err.message);
    }

    // AI 분석은 없어도 브리핑은 정상 표시
    try {
      const a = await PN.loadData("pharmacist-analysis.json");
      analysis = a.items || {};
    } catch (e) {
      analysis = {};
    }

    if (!briefings.length) return showNoBriefing();
    renderWeekPicker();
    const fromHash = decodeURIComponent(location.hash.slice(1));
    showWeek(briefings.find((b) => b.id === fromHash) || briefings[0]);
  }

  /* ---------- 주차 선택 (과거 브리핑 보관) ---------- */

  function weekLabel(b) {
    const s = PN.parseDate(b.periodStart);
    const e = PN.parseDate(b.periodEnd);
    return `${s.getFullYear()}. ${PN.formatShortDate(s)} – ${PN.formatShortDate(e)}`;
  }

  function renderWeekPicker() {
    $("week-area").hidden = false;
    $("week-select").innerHTML = briefings
      .map((b, i) => {
        const n = (b.items || []).length;
        return `<option value="${esc(b.id)}">${i === 0 ? "최신 · " : ""}${weekLabel(b)} (${n}개)</option>`;
      })
      .join("");
    $("week-select").onchange = (e) => showWeek(briefings.find((b) => b.id === e.target.value));
  }

  async function showWeek(b) {
    if (!b) return;
    $("week-select").value = b.id;
    try { history.replaceState(null, "", `#${encodeURIComponent(b.id)}`); } catch (e) {}

    const items = (b.items || []).slice().sort((x, y) => String(y.launchDate).localeCompare(String(x.launchDate)));
    const s = PN.parseDate(b.periodStart);
    const e = PN.parseDate(b.periodEnd);

    $("content").innerHTML = `
      <section class="week-head">
        <span class="eyebrow"><span class="dot"></span>Weekly Briefing</span>
        <h1 class="briefing-title">${esc(b.title || `${PN.formatRange(s, e)} 신제품 브리핑`)}</h1>
        <div class="briefing-period">${PN.formatRange(s, e)} 출시 확인분</div>
        <div class="briefing-count"><span class="num">${items.length}</span><span class="label">개 신제품 출시 확인</span></div>
      </section>
      <div id="items">${items.length ? items.map(() => `<div class="skeleton" style="height:220px;border-radius:16px;margin-bottom:14px"></div>`).join("") : ""}</div>`;

    if (!items.length) {
      $("items").innerHTML = `
        <div class="empty">
          <strong>이 주에는 출시가 확인된 신제품이 없어요</strong>
          <p>후보 제품이 있더라도 공식 출시 근거가 확인되지 않으면 브리핑에 올리지 않아요.</p>
        </div>`;
      return;
    }

    const details = await loadDetails(items.map((it) => it.id));
    $("items").innerHTML = items.map((it) => itemHTML(it, details[it.id])).join("");
  }

  // 식약처 상세 자료를 필요한 파일만 골라 불러오기
  async function loadDetails(ids) {
    const out = {};
    const shards = [...new Set(ids.filter((id) => /^\d+$/.test(id || "")).map((id) => id.slice(-2).padStart(2, "0")))];
    await Promise.all(
      shards.map(async (key) => {
        try {
          const shard = await PN.loadData(`otc/detail/${key}.json`);
          ids.forEach((id) => { if (shard[id]) out[id] = shard[id]; });
        } catch (e) { /* 없으면 브리핑에 저장된 정보만 표시 */ }
      })
    );
    return out;
  }

  /* ---------- 제품 카드 ---------- */

  function ingredientsText(p, it) {
    const seen = new Set();
    const rows = (p?.ingredientDetails || []).filter((d) => {
      const k = `${d.name}|${d.amount}|${d.unit}`;
      return d.name && !seen.has(k) && seen.add(k);
    });
    if (rows.length) {
      return `<ul class="b-ingr">${rows
        .map((d) => {
          const amt = /^\d+\.\d+$/.test(d.amount || "") ? d.amount.replace(/\.?0+$/, "") : d.amount;
          return `<li><span>${esc(d.name)}</span><b>${esc([amt, d.unit].filter(Boolean).join(" "))}</b></li>`;
        })
        .join("")}</ul>`;
    }
    const names = p?.ingredients?.length ? p.ingredients : it.ingredients || [];
    return names.length ? `<p class="b-text">${esc(names.join(" · "))}</p>` : `<p class="b-text none">확인된 성분 정보 없음</p>`;
  }

  function itemHTML(it, p) {
    const name = p?.name || it.name || "이름 미확인";
    const company = p?.company || it.company || "";
    const efficacy = p?.easy?.efficacy || it.efficacy || "";
    const a = analysis[it.id];
    const approved = a && a.status === "approved" ? a : null;
    const evidence = (it.evidence || []).filter((e) => safeURL(e.url));
    const inDB = Boolean(p);

    return `
      <article class="b-card">
        <div class="b-top">
          <span class="badge launch">출시 확인</span>
          ${it.launchDate ? `<span class="b-date">출시일 ${esc(it.launchDate)}</span>` : ""}
        </div>
        <h2 class="b-name">${esc(name)}</h2>
        <p class="b-company">
          ${company ? `제조·허가 ${esc(company)}` : ""}${it.seller ? `${company ? " · " : ""}판매 ${esc(it.seller)}` : ""}
        </p>

        <div class="b-block official">
          <div class="b-label">공식 정보 · 식약처</div>
          <h3>주요 성분 및 함량</h3>
          ${ingredientsText(p, it)}
          <h3>효능·효과</h3>
          ${efficacy ? `<p class="b-text">${esc(efficacy)}</p>` : `<p class="b-text none">요약 정보 없음 — <a class="ext" href="${nedrugURL(it.id)}" target="_blank" rel="noopener">허가사항 원문 보기 ↗</a></p>`}
        </div>

        <div class="b-block ai">
          <div class="b-label">AI 분석 초안${approved ? " · 관리자 검토 완료" : ""}</div>
          ${
            approved
              ? `${approved.differences ? `<h3>기존 제품과의 차이점</h3><p class="b-text">${esc(approved.differences)}</p>` : ""}
                 ${approved.practicePoints ? `<h3>약사 실무 포인트</h3><p class="b-text">${esc(approved.practicePoints)}</p>` : ""}`
              : `<p class="b-text none">아직 검토를 마친 분석이 없어요.</p>`
          }
        </div>

        <div class="b-evidence">
          <h3>공식 출시 근거</h3>
          ${
            evidence.length
              ? `<ul>${evidence.map((e) => `<li><a class="ext" href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.title || e.url)} ↗</a></li>`).join("")}</ul>`
              : `<p class="b-text none">등록된 근거 없음</p>`
          }
        </div>

        ${inDB ? `<a class="btn-outline" href="detail.html?id=${encodeURIComponent(it.id)}">제품 상세 보기 →</a>` : ""}
      </article>`;
  }

  /* ---------- 상태 화면 ---------- */

  function showNoBriefing() {
    const { start, end } = PN.lastWeekRange();
    $("content").innerHTML = `
      <div class="empty">
        <strong>아직 발행된 브리핑이 없어요</strong>
        <p>매주 월요일 신제품 후보를 모은 뒤, 공식 출시 근거가 확인된 제품만 브리핑에 올라와요.<br>
        다음 대상 기간: ${PN.formatRange(start, end)}</p>
      </div>`;
  }

  function showError(msg) {
    $("content").innerHTML = `
      <div class="notice error">
        ${esc(msg || "브리핑을 불러오지 못했어요.")}<br>
        <button class="link-btn" id="retry" type="button">다시 시도</button>
      </div>`;
    $("retry").onclick = load;
  }

  load();
})();
