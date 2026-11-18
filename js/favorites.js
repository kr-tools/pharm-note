/* =========================================================
   PHARM NOTE — 즐겨찾기 · 최근 본 제품
   이 브라우저(기기)의 LocalStorage에 저장된 목록을 보여줍니다.
   ========================================================= */

(function () {
  const $ = (id) => document.getElementById(id);
  const esc = PN.escapeHTML;

  // 주소 끝 #favorites / #recent 로 탭 선택 (홈 화면 바로가기와 연결)
  let tab = location.hash === "#recent" ? "recent" : "favorites";

  function fmtDate(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return "";
    return `${d.getMonth() + 1}월 ${d.getDate()}일 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }

  function setTab(next) {
    tab = next;
    document.querySelectorAll("[data-tab]").forEach((b) => b.setAttribute("aria-selected", b.dataset.tab === tab));
    try { history.replaceState(null, "", `#${tab}`); } catch (e) {}
    render();
  }

  function itemHTML(item, kind) {
    const when = kind === "favorites" ? `${fmtDate(item.savedAt)} 저장` : `${fmtDate(item.viewedAt)} 확인`;
    const actionLabel = kind === "favorites" ? "즐겨찾기 해제" : "기록 삭제";
    const icon =
      kind === "favorites"
        ? `<svg viewBox="0 0 24 24" class="star-on" stroke-width="2" stroke-linejoin="round"><path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/></svg>`
        : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>`;
    return `
      <li class="saved-item">
        <a class="saved-link" href="detail.html?id=${encodeURIComponent(item.id)}">
          <strong>${esc(PN.displayName(item.name))}</strong>
          <span>${esc(item.company || "")}${item.company ? " · " : ""}${when}</span>
        </a>
        <button class="saved-action" type="button" data-remove="${esc(item.id)}" aria-label="${actionLabel}" title="${actionLabel}">${icon}</button>
      </li>`;
  }

  function render() {
    const favs = PN.getFavorites();
    const recent = PN.readStore(PN.KEYS.recent, []);
    $("count-favorites").textContent = favs.length;
    $("count-recent").textContent = recent.length;

    const list = tab === "favorites" ? favs : recent;
    $("clear-area").hidden = tab !== "recent" || !recent.length;
    resetClearButton();

    if (!list.length) {
      $("list").innerHTML = "";
      $("empty").hidden = false;
      $("empty").innerHTML =
        tab === "favorites"
          ? `<strong>저장한 제품이 없어요</strong><p>제품 상세 화면 오른쪽 위 ☆를 누르면 여기에 모여요.</p>
             <a class="btn-outline" href="search.html" style="max-width:220px;margin:14px auto 0">제품 검색하기</a>`
          : `<strong>최근 본 제품이 없어요</strong><p>제품 상세 화면을 열면 자동으로 기록돼요. (최대 30개)</p>`;
      return;
    }
    $("empty").hidden = true;
    $("list").innerHTML = list.map((it) => itemHTML(it, tab)).join("");
  }

  function remove(id) {
    if (tab === "favorites") {
      const item = PN.getFavorites().find((f) => f.id === id);
      if (item) PN.toggleFavorite(item);
    } else {
      PN.writeStore(PN.KEYS.recent, PN.readStore(PN.KEYS.recent, []).filter((r) => r.id !== id));
    }
    render();
  }

  // 전체 삭제는 실수 방지를 위해 두 번 눌러야 실행
  let armed = false;
  function resetClearButton() {
    armed = false;
    $("clear-recent").textContent = "최근 기록 전체 삭제";
    $("clear-recent").classList.remove("danger");
  }

  $("tabs").addEventListener("click", (e) => {
    const b = e.target.closest("[data-tab]");
    if (b) setTab(b.dataset.tab);
  });
  $("list").addEventListener("click", (e) => {
    const b = e.target.closest("[data-remove]");
    if (b) remove(b.dataset.remove);
  });
  $("clear-recent").addEventListener("click", () => {
    if (!armed) {
      armed = true;
      $("clear-recent").textContent = "한 번 더 누르면 모두 삭제돼요";
      $("clear-recent").classList.add("danger");
      setTimeout(() => armed && resetClearButton(), 4000);
      return;
    }
    PN.writeStore(PN.KEYS.recent, []);
    render();
  });
  window.addEventListener("hashchange", () => setTab(location.hash === "#recent" ? "recent" : "favorites"));

  // 다른 탭에서 바뀐 내용도 반영
  window.addEventListener("storage", render);

  setTab(tab);
})();
