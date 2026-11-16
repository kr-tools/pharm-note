/* =========================================================
   PHARM NOTE — 전체 OTC 검색
   data/otc-products.json(식약처 허가정보 + e약은요)을 불러와
   브라우저 안에서 바로 검색합니다.
   ========================================================= */

(function () {
  const $ = (id) => document.getElementById(id);
  const PAGE_SIZE = 30;

  const FIELDS = [
    { key: "all", label: "전체" },
    { key: "name", label: "제품명" },
    { key: "ingredients", label: "성분명" },
    { key: "company", label: "제조·판매사" },
    { key: "efficacy", label: "효능·효과" },
    { key: "form", label: "제형" },
    { key: "className", label: "의약품 분류" },
  ];

  const state = {
    products: [],
    meta: null,
    field: "all",
    status: "normal", // normal | all | inactive
    supplyOnly: false,
    form: "",
    shown: PAGE_SIZE,
    results: [],
  };

  // 띄어쓰기·기호 차이를 무시하고 비교하기 위한 정리
  const norm = (s) => String(s || "").toLowerCase().replace(/[\s·.,\-_()[\]/+]/g, "");

  /* ---------- 데이터 불러오기 ---------- */

  async function load() {
    renderLoading();
    try {
      const data = await PN.loadData("otc-products.json");
      const cols = data.columns || [];
      state.meta = data;
      state.products = (data.rows || []).map((row) => {
        const p = {};
        cols.forEach((c, i) => (p[c] = row[i]));
        p._n = {
          name: norm(p.name),
          ingredients: norm(`${p.ingredients} ${p.ingredientsEng || ""}`),
          company: norm(`${p.company} ${p.manufacturer}`),
          efficacy: norm(p.efficacy),
          form: norm(p.form),
          className: norm(p.className),
        };
        p._active = p.status === "정상";
        return p;
      });
      $("updated-at").textContent = PN.formatUpdated(data.updatedAt);
      if (data.demo) $("demo-banner").hidden = false;
      fillFormOptions();
      run();
    } catch (err) {
      renderError(err.message);
    }
  }

  function fillFormOptions() {
    const forms = [...new Set(state.products.map((p) => p.form).filter(Boolean))].sort((a, b) =>
      a.localeCompare(b, "ko")
    );
    $("form-filter").innerHTML =
      `<option value="">제형 전체</option>` +
      forms.map((f) => `<option value="${PN.escapeHTML(f)}">${PN.escapeHTML(f)}</option>`).join("");
  }

  /* ---------- 검색 ---------- */

  function matches(p, terms) {
    if (state.status === "normal" && !p._active) return false;
    if (state.status === "inactive" && p._active) return false;
    if (state.supplyOnly && p.supply !== 1) return false;
    if (state.form && p.form !== state.form) return false;
    if (!terms.length) return true;

    const hay =
      state.field === "all"
        ? `${p._n.name}|${p._n.ingredients}|${p._n.company}|${p._n.efficacy}|${p._n.form}|${p._n.className}`
        : p._n[state.field];
    // 여러 단어를 입력하면 모두 포함된 제품만 (예: "이부프로펜 연질캡슐")
    return terms.every((t) => hay.includes(t));
  }

  function score(p, terms) {
    const t = terms.join("");
    let s = 0;
    if (p._n.name.startsWith(t)) s += 100;
    else if (p._n.name.includes(t)) s += 60;
    if (p._n.ingredients.includes(t)) s += 30;
    if (p._active) s += 10;
    return s;
  }

  function run() {
    if (!state.products.length) return renderNoData();

    const q = $("q").value.trim();
    const terms = q.split(/\s+/).map(norm).filter(Boolean);
    const list = state.products.filter((p) => matches(p, terms));
    if (terms.length) {
      list.sort((a, b) => score(b, terms) - score(a, terms) || a.name.localeCompare(b.name, "ko"));
    }
    state.results = list;
    state.shown = PAGE_SIZE;
    syncURL(q);
    renderResults(q);
  }

  function syncURL(q) {
    try {
      const url = new URL(location.href);
      q ? url.searchParams.set("q", q) : url.searchParams.delete("q");
      history.replaceState(null, "", url);
    } catch (e) {}
  }

  /* ---------- 화면 그리기 ---------- */

  function statusBadge(p) {
    if (p.status === "정상") return `<span class="badge ok">허가 정상</span>`;
    if (!p.status || p.status === "정보 없음") return `<span class="badge muted">허가상태 미확인</span>`;
    return `<span class="badge off">${PN.escapeHTML(p.status)}</span>`;
  }

  function supplyBadge(p) {
    if (p.supply === 1) return `<span class="badge supply" title="e약은요 등재 = 공급실적이 있는 일반의약품">공급실적 있음</span>`;
    return "";
  }

  function card(p) {
    const ingr = String(p.ingredients || "").split(" · ").filter(Boolean);
    const ingrText = ingr.length > 3 ? `${ingr.slice(0, 3).join(" · ")} 외 ${ingr.length - 3}개` : ingr.join(" · ");
    const company = [p.company && `${p.company}`, p.manufacturer && `제조 ${p.manufacturer}`].filter(Boolean).join(" · ");
    return `
      <li>
        <a class="result" href="detail.html?id=${encodeURIComponent(p.id)}">
          <div class="result-top">
            <strong class="result-name">${PN.escapeHTML(p.name)}</strong>
            <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg>
          </div>
          ${company ? `<div class="result-company">${PN.escapeHTML(company)}</div>` : ""}
          ${ingrText ? `<div class="result-ingr">${PN.escapeHTML(ingrText)}</div>` : ""}
          <div class="badges">
            ${statusBadge(p)}${supplyBadge(p)}
            ${p.form ? `<span class="badge plain">${PN.escapeHTML(p.form)}</span>` : ""}
            ${p.className ? `<span class="badge plain">${PN.escapeHTML(p.className)}</span>` : ""}
          </div>
        </a>
      </li>`;
  }

  function renderResults(q) {
    const total = state.results.length;
    const shown = state.results.slice(0, state.shown);

    $("summary").innerHTML = q
      ? `<b>“${PN.escapeHTML(q)}”</b> 검색 결과 <b>${total.toLocaleString()}</b>개`
      : `일반의약품 <b>${total.toLocaleString()}</b>개 · 제품명이나 성분명을 입력해 보세요`;

    if (!total) {
      $("results").innerHTML = "";
      $("more").hidden = true;
      $("state").innerHTML = `
        <div class="empty">
          <strong>검색 결과가 없어요</strong>
          <p>띄어쓰기를 빼거나, 검색 범위를 ‘전체’로 바꾸거나,<br>‘허가 상태’를 ‘전체’로 바꿔 보세요.</p>
        </div>`;
      return;
    }

    $("state").innerHTML = "";
    $("results").innerHTML = shown.map(card).join("");
    $("more").hidden = state.shown >= total;
    $("more").textContent = `더 보기 (${Math.min(PAGE_SIZE, total - state.shown)}개)`;
  }

  function renderLoading() {
    $("summary").textContent = "데이터를 불러오는 중…";
    $("results").innerHTML = Array.from({ length: 4 })
      .map(() => `<li><div class="result"><div class="skeleton" style="height:18px;width:60%"></div><div class="skeleton" style="height:13px;width:40%;margin-top:10px"></div><div class="skeleton" style="height:22px;width:70%;margin-top:12px"></div></div></li>`)
      .join("");
  }

  function renderNoData() {
    $("summary").textContent = "";
    $("results").innerHTML = "";
    $("more").hidden = true;
    $("state").innerHTML = `
      <div class="empty">
        <strong>아직 의약품 데이터가 없어요</strong>
        <p>식약처 인증키를 등록하고 ‘OTC DB 업데이트’를 한 번 실행하면<br>전체 일반의약품이 여기에 채워져요.</p>
      </div>`;
  }

  function renderError(msg) {
    $("summary").textContent = "";
    $("results").innerHTML = "";
    $("state").innerHTML = `
      <div class="notice error">
        ${PN.escapeHTML(msg || "데이터를 불러오지 못했어요.")}<br>
        <button class="link-btn" id="retry" type="button">다시 시도</button>
      </div>`;
    $("retry").addEventListener("click", load);
  }

  /* ---------- 조작 연결 ---------- */

  function setupControls() {
    $("fields").innerHTML = FIELDS.map(
      (f) => `<button type="button" class="seg" data-field="${f.key}" aria-pressed="${f.key === state.field}">${f.label}</button>`
    ).join("");
    $("fields").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-field]");
      if (!btn) return;
      state.field = btn.dataset.field;
      $("fields").querySelectorAll(".seg").forEach((b) => b.setAttribute("aria-pressed", b === btn));
      run();
    });

    let timer;
    $("q").addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(run, 200);
    });
    $("search-form").addEventListener("submit", (e) => {
      e.preventDefault();
      $("q").blur();
      run();
    });
    $("status-filter").addEventListener("change", (e) => { state.status = e.target.value; run(); });
    $("form-filter").addEventListener("change", (e) => { state.form = e.target.value; run(); });
    $("supply-only").addEventListener("change", (e) => { state.supplyOnly = e.target.checked; run(); });
    $("more").addEventListener("click", () => {
      state.shown += PAGE_SIZE;
      renderResults($("q").value.trim());
    });

    // 홈에서 넘어온 검색어 넣기
    try {
      const q = new URLSearchParams(location.search).get("q");
      if (q) $("q").value = q;
    } catch (e) {}
  }

  setupControls();
  load();
})();
