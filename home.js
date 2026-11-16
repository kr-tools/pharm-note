/* =========================================================
   PHARM NOTE — 홈 화면
   ========================================================= */

(function () {
  const $ = (id) => document.getElementById(id);

  // ① 오늘 날짜
  $("today").textContent = PN.formatLongDate(new Date());

  // ③ 빠른 검색: 입력 후 Enter 또는 '검색'을 누르면 검색 페이지로 이동
  $("quick-search").addEventListener("submit", (e) => {
    e.preventDefault();
    const q = $("q").value.trim();
    location.href = "pages/search.html" + (q ? `?q=${encodeURIComponent(q)}` : "");
  });

  // ④ 나의 보관함: 저장된 개수 표시
  const favs = PN.readStore(PN.KEYS.favorites, []);
  const recent = PN.readStore(PN.KEYS.recent, []);
  $("fav-count").textContent = favs.length ? `${favs.length}개 저장됨` : "아직 없어요";
  $("recent-count").textContent = recent.length ? `${recent.length}개 기록됨` : "아직 없어요";

  // ② Weekly Briefing 카드
  const card = $("briefing-body");

  function renderLoading() {
    card.innerHTML = `
      <div class="skeleton" style="height:24px;width:70%;margin:10px 0 8px"></div>
      <div class="skeleton" style="height:14px;width:45%"></div>
      <div class="skeleton" style="height:44px;width:30%;margin-top:28px"></div>
      <div class="skeleton" style="height:48px;width:100%;margin-top:16px;border-radius:14px"></div>`;
  }

  function renderBriefing(latest) {
    const start = PN.parseDate(latest.periodStart);
    const end = PN.parseDate(latest.periodEnd);
    const count = Array.isArray(latest.productIds) ? latest.productIds.length : 0;
    card.innerHTML = `
      <h2 class="briefing-title">${PN.escapeHTML(latest.title || `${PN.formatRange(start, end)} 신제품 브리핑`)}</h2>
      <div class="briefing-period">${PN.formatRange(start, end)} 출시 확인분</div>
      <div class="briefing-count">
        <span class="num">${count}</span><span class="label">개 신제품 출시 확인</span>
      </div>
      <a class="btn-primary" href="pages/briefing.html">브리핑 확인하기 →</a>`;
  }

  function renderEmpty() {
    const { start, end } = PN.lastWeekRange();
    card.innerHTML = `
      <h2 class="briefing-title">${PN.formatRange(start, end)} 신제품 브리핑</h2>
      <div class="briefing-period">출시 근거 확인 중</div>
      <div class="briefing-count">
        <span class="num">0</span><span class="label">개 신제품 출시 확인</span>
      </div>
      <p class="briefing-note">출시가 확인된 제품만 브리핑에 올라와요.</p>
      <a class="btn-primary" href="pages/briefing.html">지난 브리핑 보기 →</a>`;
  }

  function renderError(msg) {
    card.innerHTML = `
      <div class="notice error" style="margin-top:12px">
        ${PN.escapeHTML(msg)}<br>
        <button class="link-btn" id="retry" type="button">다시 시도</button>
      </div>`;
    $("retry").addEventListener("click", load);
  }

  async function load() {
    renderLoading();
    try {
      const data = await PN.loadData("weekly-briefings.json");
      $("updated-at").textContent = PN.formatUpdated(data.updatedAt);
      const list = Array.isArray(data.briefings) ? data.briefings : [];
      // 가장 최근 주차 브리핑을 찾음
      const latest = list
        .slice()
        .sort((a, b) => String(b.periodStart).localeCompare(String(a.periodStart)))[0];
      latest ? renderBriefing(latest) : renderEmpty();
    } catch (err) {
      renderError(err.message || "브리핑 데이터를 불러오지 못했어요.");
    }
  }

  load();
})();
