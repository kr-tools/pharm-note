/* =========================================================
   PHARM NOTE — 출시 확인 관리 (관리자 전용)
   ---------------------------------------------------------
   이 화면은 데이터를 '직접' 저장하지 않습니다.
   버튼을 누르면 내용이 채워진 GitHub 이슈 작성 화면이 열리고,
   저장소 주인이 제출하면 GitHub Actions가 검증 후 반영합니다.
   (비밀 토큰이 브라우저에 전혀 필요 없는 방식)
   ========================================================= */

(function () {
  const $ = (id) => document.getElementById(id);
  const esc = PN.escapeHTML;
  const FALLBACK_REPO = "kr-tools/pharm-note";
  const MARKER = "<!-- pharm-note-request -->";

  // GitHub Pages 주소(아이디.github.io/저장소)에서 저장소 이름을 자동으로 알아냄
  const REPO = (() => {
    const h = location.hostname;
    const seg = location.pathname.split("/").filter(Boolean)[0];
    if (h.endsWith(".github.io") && seg) return `${h.split(".")[0]}/${seg}`;
    return FALLBACK_REPO;
  })();

  const STATUS = {
    pending: { label: "확인 대기" },
    confirmed: { label: "확인 완료" },
    unconfirmable: { label: "확인 불가" },
  };

  let items = [];
  let analysis = {};
  let tab = ["pending", "confirmed", "unconfirmable"].includes(location.hash.slice(1)) ? location.hash.slice(1) : "pending";
  let otcIndex = null;

  /* ---------- 불러오기 ---------- */

  async function load() {
    $("list").innerHTML = `<div class="skeleton" style="height:200px;border-radius:16px"></div>`;
    try {
      const data = await PN.loadData("pending-products.json");
      items = Object.values(data.items || {});
      try {
        analysis = (await PN.loadData("pharmacist-analysis.json")).items || {};
      } catch (e) {
        analysis = {}; // AI 분석 파일이 없어도 출시 검토는 정상 작동
      }
      $("updated-at").textContent = PN.formatUpdated(data.updatedAt);
      render();
      loadCollectReport();
    } catch (e) {
      $("list").innerHTML = `<div class="notice error">${esc(e.message)}<br><button class="link-btn" id="retry" type="button">다시 시도</button></div>`;
      $("retry").onclick = load;
    }
  }

  /* ---------- 지난 자동 수집 요약 ---------- */

  async function loadCollectReport() {
    const box = $("collect-report");
    try {
      const r = await PN.loadData("collect-report.json");
      const pd = (d) => String(d || "").slice(5).replace("-", ".");
      const news = r.news?.enabled
        ? `출시 기사 ${r.news.launchArticles}건 → 새 후보 ${r.news.added + r.news.unmatchedAdded}건`
        : `뉴스 탐색 꺼짐 (네이버 키 없음)`;
      box.innerHTML = `
        <strong>지난 자동 수집</strong> ${esc(PN.formatUpdated(r.runAt))} · 대상 ${pd(r.period?.start)}–${pd(r.period?.end)}<br>
        신규 허가 ${r.permits?.found ?? 0}건 → 새 후보 ${r.permits?.added ?? 0}건 · ${news}
        ${(r.warnings || []).length ? `<br><span class="warn-text">⚠️ ${r.warnings.map(esc).join("<br>⚠️ ")}</span>` : ""}`;
      box.hidden = false;
    } catch (e) {
      box.hidden = true; // 아직 자동 수집이 한 번도 실행되지 않음
    }
  }

  /* ---------- 목록 ---------- */

  function render() {
    for (const k of Object.keys(STATUS)) $(`count-${k}`).textContent = items.filter((i) => i.status === k).length;
    document.querySelectorAll("[data-tab]").forEach((b) => b.setAttribute("aria-selected", b.dataset.tab === tab));

    const list = items
      .filter((i) => i.status === tab)
      .sort((a, b) => String(b.reviewedAt || b.firstSeen).localeCompare(String(a.reviewedAt || a.firstSeen)));

    if (!list.length) {
      $("list").innerHTML = `<div class="empty"><strong>${STATUS[tab].label} 제품이 없어요</strong>
        <p>${tab === "pending" ? "매주 월요일 자동 수집 후 이곳에 후보가 올라와요. 위의 ‘후보 직접 추가’로 넣을 수도 있어요." : ""}</p></div>`;
      return;
    }
    $("list").innerHTML = list.map(cardHTML).join("");
  }

  function linkList(list) {
    const safe = (list || []).filter((s) => /^https?:\/\//.test(s.url || ""));
    if (!safe.length) return `<span class="none">없음</span>`;
    return `<ul class="a-links">${safe
      .map((s) => `<li><a class="ext" href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title || s.url)} ↗</a></li>`)
      .join("")}</ul>`;
  }

  function cardHTML(c) {
    const confirmed = c.status === "confirmed";
    const evidenceText = (c.evidence || []).map((e) => (e.title ? `${e.title} | ${e.url}` : e.url)).join("\n");
    return `
      <article class="a-card" data-id="${esc(c.id)}">
        <div class="a-top">
          <span>
            <span class="badge ${confirmed ? "launch" : c.status === "pending" ? "supply" : "off"}">${STATUS[c.status]?.label || c.status}</span>
            ${c.origin === "permit" ? `<span class="badge plain">신규 허가</span>` : c.origin === "news" ? `<span class="badge plain">뉴스</span>` : ""}
          </span>
          <span class="a-seen">최초 수집 ${esc(c.firstSeen || "-")}</span>
        </div>
        <h2 class="a-name">${esc(c.name)}</h2>
        <dl class="kvs a-kvs">
          <div class="kv"><dt>제조사</dt><dd>${esc(c.company) || '<span class="none">정보 없음</span>'}</dd></div>
          <div class="kv"><dt>성분 및 함량</dt><dd>${esc(c.ingredients) || '<span class="none">정보 없음</span>'}
            ${c.itemSeq ? `<br><a class="ext" href="detail.html?id=${encodeURIComponent(c.itemSeq)}" target="_blank">상세(함량) 보기 ↗</a>` : ""}</dd></div>
          <div class="kv"><dt>허가일</dt><dd>${esc(c.permitDate) || '<span class="none">정보 없음</span>'}</dd></div>
          <div class="kv"><dt>발견된 정보</dt><dd>${esc(c.foundInfo) || '<span class="none">없음</span>'}</dd></div>
          <div class="kv"><dt>출처 링크</dt><dd>${linkList(c.sources)}</dd></div>
          ${confirmed ? `
          <div class="kv"><dt>실제 출시일</dt><dd><b>${esc(c.launchDate)}</b></dd></div>
          <div class="kv"><dt>출시 근거</dt><dd>${linkList(c.evidence)}</dd></div>` : ""}
          ${c.memo ? `<div class="kv"><dt>검토 메모</dt><dd>${esc(c.memo)}</dd></div>` : ""}
        </dl>

        ${aiHTML(c)}

        <details class="a-form" ${c.status === "pending" ? "open" : ""}>
          <summary>${confirmed ? "출시일·근거 수정 / 상태 변경" : "검토하기"}</summary>
          <label>실제 출시일 <span class="req">승인 시 필수</span>
            <input type="date" name="launchDate" value="${esc(c.launchDate || "")}" max="${todayISO()}">
          </label>
          <label>공식 출시 근거 URL <span class="req">승인 시 필수</span>
            <textarea name="evidence" rows="3" placeholder="한 줄에 하나씩 입력&#10;예) 동화약품 보도자료 | https://...">${esc(evidenceText)}</textarea>
          </label>
          <label>판매사 <span class="opt">선택</span>
            <input type="text" name="seller" value="${esc(c.seller || "")}" placeholder="제조사와 다를 때만">
          </label>
          ${!c.itemSeq ? `
          <label>품목기준코드 연결 <span class="opt">선택</span>
            <input type="text" name="itemSeq" inputmode="numeric" placeholder="식약처 DB 제품과 연결할 때">
          </label>` : ""}
          <label>검토 메모 <span class="opt">선택 · 공개 저장소에 기록돼요</span>
            <textarea name="memo" rows="2">${esc(c.memo || "")}</textarea>
          </label>
          <p class="a-error" hidden></p>
          <div class="a-actions">
            <button type="button" class="btn-primary" data-act="confirm">${confirmed ? "수정 내용 승인 요청" : "실제 출시 확인 · 승인 요청"}</button>
            <div class="a-sub">
              ${c.status !== "unconfirmable" ? `<button type="button" class="btn-ghost" data-act="unconfirmable">확인 불가 처리</button>` : ""}
              <button type="button" class="btn-ghost danger" data-act="delete">후보 삭제</button>
            </div>
          </div>
        </details>
      </article>`;
  }

  /* ---------- AI 분석 초안 영역 ---------- */

  const AI_FIELDS = [
    ["differences", "기존 제품과의 차이점"],
    ["formNotes", "제형상의 특징"],
    ["counseling", "복약지도 시 주의할 점"],
    ["practicePoints", "약국 실무 포인트"],
  ];

  // 카드별로 고른 비교 제품 (최대 4개)
  const picks = new Map();

  function pickerHTML(c) {
    const chosen = picks.get(c.id) || [];
    return `
      <details class="a-cmp" ${chosen.length ? "open" : ""}>
        <summary>비교 제품 직접 고르기 <span class="opt">선택 · 최대 4개 · 안 고르면 같은 제형에서 자동 선택</span></summary>
        <div class="cmp-chosen">${chosen
          .map((x) => `<span class="cmp-chip">${esc(x.name)}<button type="button" data-cmp-del="${esc(x.id)}" aria-label="빼기">✕</button></span>`)
          .join("") || `<span class="sec-note" style="margin:0">아직 고른 제품이 없어요</span>`}</div>
        <input type="search" class="cmp-q" placeholder="제품명으로 찾기 (예: 타이레놀)" autocomplete="off">
        <div class="cmp-results"></div>
      </details>`;
  }

  async function searchCompare(card, q) {
    const box = card.querySelector(".cmp-results");
    if (q.length < 2) { box.innerHTML = ""; return; }
    try { await ensureIndex(); } catch (e) { box.innerHTML = `<p class="a-error">${esc(e.message)}</p>`; return; }
    const k = q.replace(/\s/g, "").toLowerCase();
    const chosen = new Set((picks.get(card.dataset.id) || []).map((x) => x.id));
    const found = otcIndex.filter((p) => p.status === "정상" && p.key.includes(k)).slice(0, 6);
    box.innerHTML = found.length
      ? found.map((p) => `<div class="add-row">
          <span><span class="mini-name">${esc(p.name)}</span><span class="mini-meta">${esc(p.company)} · ${esc(p.form || "")}</span></span>
          ${chosen.has(p.id) ? `<span class="badge plain">선택됨</span>` : `<button type="button" class="btn-ghost" data-cmp-add="${esc(p.id)}" data-name="${esc(p.name)}">고르기</button>`}
        </div>`).join("")
      : `<p class="sec-note">찾는 제품이 없어요.</p>`;
  }

  function rerenderPicker(card) {
    const c = items.find((i) => i.id === card.dataset.id);
    const old = card.querySelector(".a-cmp");
    if (!c || !old) return;
    const q = old.querySelector(".cmp-q").value;
    old.outerHTML = pickerHTML(c);
    const input = card.querySelector(".cmp-q");
    input.value = q;
    card.querySelector(".a-cmp").open = true;
    if (q) searchCompare(card, q);
  }

  function aiHTML(c) {
    const key = c.itemSeq || c.id;
    const a = analysis[key];
    const has = a && ["draft", "approved"].includes(a.status);
    const state = !has ? "초안 없음" : a.status === "approved" ? "검토 완료 · 공개 중" : "검토 전 · 비공개";
    const err = a?.lastError ? `<p class="a-error">최근 생성 실패: ${esc(a.lastError)}</p>` : "";
    if (!c.itemSeq) {
      return `<div class="a-ai"><div class="a-ai-label">AI 분석 초안</div>
        <p class="sec-note" style="margin:0">품목기준코드가 연결되면 AI 초안을 만들 수 있어요. (아래 ‘검토하기’에서 연결)</p></div>`;
    }
    return `
      <details class="a-ai" ${has && a.status === "draft" ? "open" : ""}>
        <summary><span class="a-ai-label">AI 분석 초안</span><span class="a-ai-state ${has ? a.status : ""}">${state}</span></summary>
        ${err}
        ${has ? `
          <p class="sec-note">공식 허가사항·성분 정보만으로 작성된 초안이에요. 내용을 확인하고 필요하면 고친 뒤 승인하세요.
            ${a.generatedAt ? `<br>생성: ${esc(a.generatedAt.slice(0, 10))}${a.model ? ` · ${esc(a.model)}` : ""}` : ""}
            ${a.basedOn?.comparedBasis ? ` · 비교: ${esc(a.basedOn.comparedBasis)} ${a.basedOn.comparedIds?.length || 0}개` : ""}</p>
          ${AI_FIELDS.map(([k, label]) => `
            <label class="a-ai-field">${label}
              <textarea name="ai-${k}" rows="4">${esc(a[k] || "")}</textarea>
            </label>`).join("")}
          ${pickerHTML(c)}
          <div class="a-sub" style="margin-top:12px">
            <button type="button" class="btn-ghost ai" data-act="analysis_approve">${a.status === "approved" ? "수정 내용 다시 승인" : "검토 완료 · 공개 승인"}</button>
            <button type="button" class="btn-ghost" data-act="analyze">AI 초안 다시 만들기</button>
          </div>`
        : `<p class="sec-note">아직 초안이 없어요. 버튼을 누르면 식약처 공식 데이터로 초안을 만들어요. (1~2분)</p>
          ${pickerHTML(c)}
          <button type="button" class="btn-ghost ai" data-act="analyze" style="width:100%;margin-top:8px">AI 초안 만들기</button>`}
      </details>`;
  }

  function todayISO() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  /* ---------- 요청(이슈) 만들기 ---------- */

  function parseEvidence(text) {
    return String(text || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const m = line.match(/^(.*?)\s*\|\s*(https?:\/\/\S+)\s*$/);
        return m ? { title: m[1].trim(), url: m[2] } : { title: "", url: line };
      });
  }

  const ACT_LABEL = {
    confirm: "출시 확인 승인", unconfirmable: "확인 불가 처리", delete: "후보 삭제", add: "후보 직접 추가",
    analyze: "AI 초안 만들기", analysis_approve: "AI 분석 검토 승인",
  };

  function openIssue(req, name) {
    const lines = [
      "PHARM NOTE 관리자 요청입니다.",
      "**아래 내용을 수정하지 말고, 오른쪽 아래 `Create`(또는 `Submit new issue`) 버튼을 눌러주세요.**",
      "",
      `- 작업: ${ACT_LABEL[req.action]}`,
      `- 제품: ${name}`,
      req.launchDate ? `- 실제 출시일: ${req.launchDate}` : "",
      ...(req.evidence || []).map((e) => `- 근거: ${e.url}`),
      "",
      MARKER,
      "```json",
      JSON.stringify(req, null, 2),
      "```",
    ].filter((l) => l !== "");
    const title = `[PHARM NOTE] ${ACT_LABEL[req.action]}: ${name}`.slice(0, 200);
    const body = lines.join("\n");
    const base = `https://github.com/${REPO}/issues/new?title=${encodeURIComponent(title)}`;
    const full = `${base}&body=${encodeURIComponent(body)}`;

    // 주소가 너무 길면(AI 분석 본문 등) GitHub가 받아주지 않으므로 복사-붙여넣기 방식
    if (full.length > 6000) {
      const paste = () => {
        const w = window.open(`${base}&body=${encodeURIComponent("(여기를 모두 지우고 붙여넣기 하세요)")}`, "_blank");
        if (w) w.opener = null;
        showSheet(true, base);
      };
      navigator.clipboard?.writeText(body).then(paste, () => showSheet(true, base, body));
      return;
    }
    const w = window.open(full, "_blank");
    if (w) w.opener = null;
    showSheet(false, full);
  }

  // 다음에 할 일 안내 (새 창이 막혔을 때 쓸 링크 포함)
  function showSheet(needPaste, url, bodyForManualCopy) {
    const sheet = $("sheet");
    sheet.innerHTML = `
      <div class="sheet-inner">
        <strong>${needPaste ? "본문을 복사했어요" : "GitHub 창이 열렸어요"}</strong>
        <p>${needPaste
          ? "내용이 길어서 붙여넣기 방식으로 진행해요. GitHub 창의 본문 칸을 <b>모두 지우고 붙여넣기</b>(Ctrl+V / 길게 눌러 붙여넣기)한 뒤 Create를 눌러주세요."
          : "GitHub 창에서 내용을 고치지 말고 <b>Create</b>를 눌러주세요. 1~2분 뒤 반영되고, 이슈에 결과 댓글이 달려요."}</p>
        ${bodyForManualCopy ? `<textarea readonly rows="5" style="width:100%">${esc(bodyForManualCopy)}</textarea>` : ""}
        <div class="sheet-btns">
          <a class="btn-ghost" href="${esc(url)}" target="_blank" rel="noopener">창이 안 열렸다면 여기</a>
          <button type="button" class="btn-ghost" id="sheet-close">닫기</button>
        </div>
      </div>`;
    sheet.hidden = false;
    $("sheet-close").onclick = () => (sheet.hidden = true);
  }

  function handleAction(card, act, btn) {
    const c = items.find((i) => i.id === card.dataset.id);
    if (!c) return;
    const val = (n) => card.querySelector(`[name="${n}"]`)?.value.trim() || "";
    const err = card.querySelector(".a-error");
    err.hidden = true;

    if (act === "confirm") {
      const launchDate = val("launchDate");
      const evidence = parseEvidence(val("evidence"));
      const bad = evidence.filter((e) => !/^https?:\/\/\S+\.\S+/.test(e.url));
      const problems = [];
      if (!launchDate) problems.push("실제 출시일을 입력해 주세요.");
      else if (launchDate > todayISO()) problems.push("출시일이 오늘 이후예요. 실제 출시 후에 승인할 수 있어요.");
      if (!evidence.length) problems.push("공식 출시 근거 URL이 없으면 승인할 수 없어요.");
      if (bad.length) problems.push("근거 URL은 http:// 또는 https:// 로 시작해야 해요.");
      if (val("itemSeq") && !/^\d+$/.test(val("itemSeq"))) problems.push("품목기준코드는 숫자만 입력해요.");
      if (problems.length) {
        err.innerHTML = problems.map(esc).join("<br>");
        err.hidden = false;
        return;
      }
      return openIssue(
        { v: 1, action: "confirm", id: c.id, launchDate, evidence, seller: val("seller"), itemSeq: val("itemSeq") || undefined, memo: val("memo") },
        c.name
      );
    }

    if (act === "analysis_approve") {
      const fields = Object.fromEntries(AI_FIELDS.map(([k]) => [k, val(`ai-${k}`)]));
      if (!Object.values(fields).some(Boolean)) {
        err.textContent = "분석 내용이 비어 있어요.";
        err.hidden = false;
        return;
      }
      return openIssue({ v: 1, action: "analysis_approve", id: c.id, ...fields }, c.name);
    }
    if (act === "analyze") {
      const compareIds = (picks.get(c.id) || []).map((x) => x.id);
      return openIssue({ v: 1, action: "analyze", id: c.id, ...(compareIds.length ? { compareIds } : {}) }, c.name);
    }

    if (act === "delete" && btn.dataset.armed !== "1") {
      // 실수 방지: 두 번 눌러야 삭제 요청
      btn.dataset.armed = "1";
      btn.textContent = "한 번 더 누르면 삭제 요청";
      setTimeout(() => { btn.dataset.armed = ""; btn.textContent = "후보 삭제"; }, 4000);
      return;
    }
    openIssue({ v: 1, action: act, id: c.id, memo: val("memo") }, c.name);
  }

  /* ---------- 후보 직접 추가 (식약처 DB에서 찾기) ---------- */

  async function ensureIndex() {
    if (otcIndex) return otcIndex;
    const d = await PN.loadData("otc-products.json");
    const ci = (c) => d.columns.indexOf(c);
    otcIndex = d.rows.map((r) => ({
      id: r[ci("id")], name: r[ci("name")], company: r[ci("company")],
      permitDate: r[ci("permitDate")], status: r[ci("status")], form: r[ci("form")],
      key: String(r[ci("name")]).replace(/\s/g, "").toLowerCase(),
    }));
    return otcIndex;
  }

  async function searchDB(q) {
    const box = $("add-results");
    if (q.length < 2) { box.innerHTML = ""; return; }
    if (!otcIndex) {
      box.innerHTML = `<p class="sec-note">의약품 데이터를 불러오는 중…</p>`;
      try {
        await ensureIndex();
      } catch (e) {
        box.innerHTML = `<p class="notice error">${esc(e.message)}</p>`;
        return;
      }
    }
    const k = q.replace(/\s/g, "").toLowerCase();
    const found = otcIndex
      .filter((p) => p.key.includes(k) || p.id === q)
      .sort((a, b) => String(b.permitDate).localeCompare(String(a.permitDate)))
      .slice(0, 8);
    const inList = new Set(items.map((i) => i.itemSeq || i.id));
    box.innerHTML = found.length
      ? `<ul class="mini-list">${found
          .map((p) => `<li><div class="add-row">
              <span><span class="mini-name">${esc(p.name)}</span>
              <span class="mini-meta">${esc(p.company)} · 허가 ${esc(p.permitDate)} · ${esc(p.status)}</span></span>
              ${inList.has(p.id) ? `<span class="badge plain">이미 후보</span>` : `<button type="button" class="btn-ghost" data-add="${esc(p.id)}" data-name="${esc(p.name)}">후보로 추가</button>`}
            </div></li>`)
          .join("")}</ul>`
      : `<p class="sec-note">찾는 제품이 없어요.</p>`;
  }

  /* ---------- 공통 ---------- */

  let toastTimer;
  function toast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
  }

  $("repo-name").textContent = REPO;
  $("tabs").addEventListener("click", (e) => {
    const b = e.target.closest("[data-tab]");
    if (!b) return;
    tab = b.dataset.tab;
    try { history.replaceState(null, "", `#${tab}`); } catch (er) {}
    render();
  });
  $("list").addEventListener("click", (e) => {
    const add = e.target.closest("[data-cmp-add]");
    const del = e.target.closest("[data-cmp-del]");
    if (add || del) {
      const card = (add || del).closest(".a-card");
      let list = picks.get(card.dataset.id) || [];
      if (add) {
        if (list.length >= 4) return toast("비교 제품은 최대 4개까지 고를 수 있어요");
        list = [...list, { id: add.dataset.cmpAdd, name: add.dataset.name }];
      } else {
        list = list.filter((x) => x.id !== del.dataset.cmpDel);
      }
      picks.set(card.dataset.id, list);
      return rerenderPicker(card);
    }
    const btn = e.target.closest("[data-act]");
    if (btn) handleAction(btn.closest(".a-card"), btn.dataset.act, btn);
  });
  let ct;
  $("list").addEventListener("input", (e) => {
    if (!e.target.classList.contains("cmp-q")) return;
    clearTimeout(ct);
    const card = e.target.closest(".a-card");
    ct = setTimeout(() => searchCompare(card, e.target.value.trim()), 250);
  });

  let t;
  $("add-q").addEventListener("input", (e) => {
    clearTimeout(t);
    t = setTimeout(() => searchDB(e.target.value.trim()), 250);
  });
  $("add-results").addEventListener("click", (e) => {
    const b = e.target.closest("[data-add]");
    if (b) openIssue({ v: 1, action: "add", id: b.dataset.add }, b.dataset.name);
  });

  load();
})();
