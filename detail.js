/* =========================================================
   PHARM NOTE — 제품 상세 페이지
   모든 제품이 같은 구조를 사용합니다.
   1 기본 정보 / 2 성분 정보 / 3 공식 허가사항 / 4 약사 실무 분석 / 5 출처

   공식 정보(식약처)와 AI 분석은 서로 다른 색의 영역에 표시합니다.
   ========================================================= */

(function () {
  const $ = (id) => document.getElementById(id);
  const esc = PN.escapeHTML;
  const NONE = `<span class="none">정보 없음</span>`;
  const nedrugURL = (id) => `https://nedrug.mfds.go.kr/pbp/CCBBB01/getItemDetail?itemSeq=${encodeURIComponent(id)}`;

  const id = (() => {
    try { return new URLSearchParams(location.search).get("id") || ""; } catch (e) { return ""; }
  })();

  /* ---------- 데이터 불러오기 ---------- */

  async function load() {
    $("content").innerHTML = loadingHTML();
    if (!/^\d+$/.test(id)) return showMessage("제품을 찾을 수 없어요", "검색 화면에서 제품을 다시 선택해 주세요.");

    let product;
    try {
      const shard = await PN.loadData(`otc/detail/${id.slice(-2).padStart(2, "0")}.json`);
      product = shard[id];
    } catch (e) {
      // 상세 파일이 아직 없으면(첫 수집 전) 아래에서 안내
    }
    if (!product) {
      return showMessage(
        "이 제품의 상세 정보가 아직 없어요",
        "데이터 수집이 끝나지 않았거나, 허가정보에서 제외된 제품일 수 있어요.",
        nedrugURL(id)
      );
    }

    // 보조 자료: 실패해도 상세 페이지는 그대로 보여줌
    const [list, analysis, launch] = await Promise.all([
      PN.loadData("otc-products.json").catch(() => null),
      PN.loadData("pharmacist-analysis.json").catch(() => null),
      PN.loadData("launch-evidence.json").catch(() => null),
    ]);

    if (list?.demo) $("demo-banner").hidden = false;
    document.title = `${product.name} · PHARM NOTE`;

    const approved = analysis?.items?.[id];
    render(product, {
      sameIngredient: findSameIngredient(product, list),
      analysis: approved && approved.status === "approved" ? approved : null,
      launch: launch?.items?.[id] || null,
      updatedAt: list?.updatedAt,
    });

    PN.addRecent(product);
    setupFavorite(product);
  }

  // 유효성분 구성이 완전히 같은 제품 찾기 (식약처 데이터 비교, AI 아님)
  function findSameIngredient(p, list) {
    if (!list?.rows || !p.ingredients?.length) return [];
    const key = (arr) => arr.map((x) => x.replace(/\s/g, "")).sort().join("|");
    const target = key(p.ingredients);
    const cols = list.columns;
    const ci = (c) => cols.indexOf(c);
    return list.rows
      .filter((r) => r[ci("id")] !== p.id && key(String(r[ci("ingredients")] || "").split(" · ").filter(Boolean)) === target)
      .map((r) => ({
        id: r[ci("id")], name: r[ci("name")], company: r[ci("company")],
        form: r[ci("form")], status: r[ci("status")], supply: r[ci("supply")],
      }))
      .sort((a, b) => (a.status === "정상" ? 0 : 1) - (b.status === "정상" ? 0 : 1) || a.name.localeCompare(b.name, "ko"));
  }

  /* ---------- 화면 그리기 ---------- */

  const row = (label, value) => `<div class="kv"><dt>${label}</dt><dd>${value || NONE}</dd></div>`;
  const text = (s) => (s ? esc(s) : "");

  function statusBadge(p) {
    if (p.status === "정상") return `<span class="badge ok">허가 정상</span>`;
    if (!p.status || p.status === "정보 없음") return `<span class="badge muted">허가상태 미확인</span>`;
    return `<span class="badge off">${esc(p.status)}${p.cancelDate ? ` (${esc(p.cancelDate)})` : ""}</span>`;
  }

  function render(p, extra) {
    const ez = p.easy;

    $("content").innerHTML = `
      <!-- 제품명 영역 -->
      <section class="hero">
        <div class="badges">
          ${statusBadge(p)}
          ${p.supply === 1 ? `<span class="badge supply">공급실적 있음</span>` : ""}
          ${extra.launch ? `<span class="badge launch">출시 확인</span>` : ""}
        </div>
        <h1 class="product-name">${esc(p.name)}</h1>
        <p class="product-company">${esc(p.company || "")}${p.manufacturer ? ` · 제조 ${esc(p.manufacturer)}` : ""}</p>
      </section>

      <!-- 1. 기본 정보 -->
      <section class="sec">
        <h2 class="sec-title"><span class="num">1</span>기본 정보</h2>
        <dl class="kvs">
          ${row("제품명", esc(p.name))}
          ${row("업체명(허가)", text(p.company))}
          ${p.manufacturer ? row("위탁제조업체", text(p.manufacturer)) : ""}
          ${row("품목기준코드", esc(p.id))}
          ${row("허가번호", text(p.permitNo))}
          ${row("허가일", text(p.permitDate))}
          ${row("실제 출시일", extra.launch?.launchDate ? `${esc(extra.launch.launchDate)} <span class="hint">관리자 확인</span>` : `<span class="none">확인된 출시 정보 없음</span>`)}
          ${row("제형", p.form ? `${esc(p.form)} <span class="hint">제품명 기준 분류</span>` : "")}
          ${row("의약품 분류", text(p.className))}
          ${row("포장 단위", "")}
        </dl>
      </section>

      <!-- 2. 성분 정보 -->
      <section class="sec">
        <h2 class="sec-title"><span class="num">2</span>성분 정보</h2>
        ${ingredientsHTML(p)}
        <p class="sec-note">${p.ingredientDetails?.some((d) => d.amount) ? "함량은 식약처 주성분 정보 기준이에요. " : "성분별 함량은 "}첨가제는 식약처 허가사항 원문에서 확인할 수 있어요.
          <a class="ext" href="${nedrugURL(p.id)}" target="_blank" rel="noopener">의약품안전나라에서 보기 ↗</a></p>
      </section>

      <!-- 3. 공식 허가사항 (식약처) -->
      <section class="sec zone-official">
        <div class="zone-label official">공식 정보 · 식품의약품안전처</div>
        <h2 class="sec-title"><span class="num">3</span>공식 허가사항</h2>
        ${
          ez
            ? `
          ${qa("효능·효과", ez.efficacy)}
          ${qa("용법·용량", ez.useMethod)}
          ${qa("사용 전 반드시 알아야 할 내용 (금기·경고)", ez.warning)}
          ${qa("사용상 주의사항", ez.caution)}
          ${qa("함께 주의할 약·음식", ez.interaction)}
          ${qa("이상반응", ez.sideEffect)}
          ${qa("보관법", ez.storage)}
          <p class="sec-note">위 내용은 식약처 ‘e약은요’(일반의약품 개요정보)${ez.updated ? `, ${esc(ez.updated)} 수정본` : ""}이에요.
            소비자용 요약이므로 정확한 허가사항은 원문을 확인하세요.</p>`
            : `<p class="none-block">e약은요 요약 정보가 없는 제품이에요.</p>`
        }
        <a class="btn-outline" href="${nedrugURL(p.id)}" target="_blank" rel="noopener">허가사항 원문 보기 (의약품안전나라) ↗</a>
      </section>

      <!-- 4. 약사 실무 분석 -->
      <section class="sec">
        <h2 class="sec-title"><span class="num">4</span>약사 실무 분석</h2>

        <h3 class="sub-title">같은 성분 조합 제품 <span class="hint">식약처 데이터 자동 비교</span></h3>
        ${sameIngredientHTML(extra.sameIngredient)}

        <div class="zone-ai">
          <div class="zone-label ai">AI 분석 초안${extra.analysis ? " · 관리자 검토 완료" : ""}</div>
          ${extra.analysis ? analysisHTML(extra.analysis) : `
            <p class="none-block ai">아직 검토를 마친 분석이 없어요.<br>
            AI 초안은 관리자가 검토·승인한 뒤에만 이곳에 표시됩니다.</p>`}
          <p class="sec-note">AI 분석은 공식 허가사항이 아니며, 참고용입니다.</p>
        </div>
      </section>

      <!-- 5. 출처 -->
      <section class="sec">
        <h2 class="sec-title"><span class="num">5</span>출처</h2>
        <ul class="sources">
          <li><a class="ext" href="${nedrugURL(p.id)}" target="_blank" rel="noopener">식약처 의약품안전나라 — 제품 상세 ↗</a></li>
          <li>식약처 의약품 제품 허가정보 · 의약품개요정보(e약은요) (공공데이터포털)</li>
          ${(extra.launch?.evidence || [])
            .filter((e) => /^https?:\/\//.test(e.url || ""))
            .map((e) => `<li><a class="ext" href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.title || e.url)} ↗</a></li>`)
            .join("") || `<li class="none">제약사 공식 자료·제품 페이지: 등록된 자료 없음</li>`}
        </ul>
        <p class="sec-note">데이터 업데이트: ${PN.formatUpdated(extra.updatedAt)}</p>
      </section>`;
  }

  function ingredientsHTML(p) {
    const details = (p.ingredientDetails || []).filter((d) => d.name || d.nameEng);
    if (details.some((d) => d.amount)) {
      return `
        <table class="ingr-table">
          <thead><tr><th>성분</th><th>함량</th></tr></thead>
          <tbody>${details.map((d) => `
            <tr>
              <td>${esc(d.name || d.nameEng)}${d.name && d.nameEng ? `<span class="eng">${esc(d.nameEng)}</span>` : ""}</td>
              <td class="amt">${esc([d.amount, d.unit].filter(Boolean).join(" "))}${d.basis ? `<span class="eng">${esc(d.basis)}</span>` : ""}</td>
            </tr>`).join("")}
          </tbody>
        </table>`;
    }
    const ingr = p.ingredients || [];
    if (!ingr.length) return `<p class="none-block">유효성분 정보가 없어요.</p>`;
    const eng = p.ingredientsEng && p.ingredientsEng !== ingr && p.ingredientsEng.join() !== ingr.join() ? p.ingredientsEng : null;
    return `<ul class="ingr-list">${ingr.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
      ${eng ? `<p class="sec-note">영문: ${esc(eng.join(", "))}</p>` : ""}`;
  }

  function qa(title, body) {
    if (!body) return "";
    return `<div class="qa"><h3>${title}</h3><p>${esc(body)}</p></div>`;
  }

  function sameIngredientHTML(list) {
    if (!list.length) return `<p class="none-block">유효성분 구성이 같은 다른 일반의약품이 없어요.</p>`;
    const shown = list.slice(0, 8);
    return `
      <ul class="mini-list">
        ${shown.map((x) => `
          <li><a href="detail.html?id=${encodeURIComponent(x.id)}">
            <span class="mini-name">${esc(x.name)}</span>
            <span class="mini-meta">${esc(x.company || "")}${x.form ? ` · ${esc(x.form)}` : ""}${x.status !== "정상" ? ` · ${esc(x.status)}` : ""}</span>
          </a></li>`).join("")}
      </ul>
      ${list.length > shown.length ? `<p class="sec-note">외 ${list.length - shown.length}개 제품</p>` : ""}
      <p class="sec-note">성분 이름 기준 비교예요. 함량 차이는 각 제품의 허가사항 원문에서 확인하세요.</p>`;
  }

  // 7단계에서 승인된 분석 형식: { differences, practicePoints, counseling, reviewedAt }
  function analysisHTML(a) {
    const block = (t, v) => (v ? `<div class="qa"><h3>${t}</h3><p>${esc(v)}</p></div>` : "");
    return `
      ${block("기존 제품과의 차이점", a.differences)}
      ${block("제형상의 특징", a.formNotes)}
      ${block("복약지도 시 주의할 점", a.counseling)}
      ${block("약국 실무 포인트", a.practicePoints)}
      ${a.reviewedAt ? `<p class="sec-note">관리자 검토: ${esc(a.reviewedAt)}</p>` : ""}`;
  }

  /* ---------- 즐겨찾기 버튼 ---------- */

  function setupFavorite(p) {
    const btn = $("fav-btn");
    btn.hidden = false;
    const paint = () => {
      const on = PN.isFavorite(p.id);
      btn.setAttribute("aria-pressed", on);
      btn.setAttribute("aria-label", on ? "즐겨찾기 해제" : "즐겨찾기 추가");
    };
    paint();
    btn.onclick = () => {
      const added = PN.toggleFavorite(p);
      paint();
      toast(added ? "즐겨찾기에 추가했어요" : "즐겨찾기에서 뺐어요");
    };
  }

  let toastTimer;
  function toast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 1600);
  }

  /* ---------- 상태 화면 ---------- */

  function loadingHTML() {
    return `
      <div class="skeleton" style="height:22px;width:40%"></div>
      <div class="skeleton" style="height:30px;width:80%;margin-top:14px"></div>
      <div class="skeleton" style="height:16px;width:50%;margin-top:10px"></div>
      <div class="skeleton" style="height:180px;width:100%;margin-top:24px;border-radius:16px"></div>`;
  }

  function showMessage(title, body, link) {
    $("content").innerHTML = `
      <div class="empty">
        <strong>${esc(title)}</strong>
        <p>${esc(body)}</p>
        ${link ? `<p style="margin-top:12px"><a class="ext" href="${link}" target="_blank" rel="noopener">의약품안전나라에서 직접 보기 ↗</a></p>` : ""}
      </div>`;
  }

  load();
})();
