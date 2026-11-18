/* =========================================================
   PHARM NOTE — 공통 기능 (모든 페이지에서 사용)
   - LocalStorage 읽기/쓰기 (실패해도 앱이 멈추지 않도록)
   - JSON 데이터 불러오기 (오류 처리 포함)
   - 날짜 표시
   ========================================================= */

const PN = (() => {
  // 브라우저에 저장할 때 쓰는 이름표
  const KEYS = {
    favorites: "pharmnote.favorites", // 즐겨찾기 목록
    recent: "pharmnote.recent",       // 최근 본 제품 목록
  };

  // 현재 페이지가 /pages/ 안에 있으면 한 단계 위로 올라가야 data 폴더가 보임
  const ROOT = location.pathname.includes("/pages/") ? "../" : "./";

  function readStore(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function writeStore(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      return false;
    }
  }

  // data 폴더의 JSON 파일 불러오기. 실패하면 오류를 던져서 화면에서 안내함
  async function loadData(fileName) {
    const res = await fetch(`${ROOT}data/${fileName}`, { cache: "no-cache" });
    if (!res.ok) throw new Error(`데이터를 불러오지 못했어요 (${res.status})`);
    return res.json();
  }

  const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

  function formatLongDate(d) {
    return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEKDAYS[d.getDay()]})`;
  }

  function formatShortDate(d) {
    return `${d.getMonth() + 1}.${d.getDate()}`;
  }

  // "2026-11-09" 같은 문자열을 날짜로 (시간대 문제 없이)
  function parseDate(str) {
    const [y, m, day] = String(str).slice(0, 10).split("-").map(Number);
    return new Date(y, m - 1, day);
  }

  // 오늘 기준 '지난주 월요일 ~ 일요일'
  function lastWeekRange(today = new Date()) {
    const base = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const daysSinceMonday = (base.getDay() + 6) % 7;
    const thisMonday = new Date(base);
    thisMonday.setDate(base.getDate() - daysSinceMonday);
    const start = new Date(thisMonday);
    start.setDate(thisMonday.getDate() - 7);
    const end = new Date(thisMonday);
    end.setDate(thisMonday.getDate() - 1);
    return { start, end };
  }

  function formatRange(start, end) {
    return `${start.getMonth() + 1}월 ${start.getDate()}일 – ${end.getMonth() + 1}월 ${end.getDate()}일`;
  }

  function formatUpdated(iso) {
    if (!iso) return "아직 없음";
    const d = new Date(iso);
    if (isNaN(d)) return "아직 없음";
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()} ${hh}:${mm}`;
  }

  function escapeHTML(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  /* ---------- 즐겨찾기 · 최근 본 제품 ---------- */
  // 저장 형태: [{ id, name, company, savedAt }]
  function getFavorites() {
    return readStore(KEYS.favorites, []);
  }

  function isFavorite(id) {
    return getFavorites().some((f) => f.id === id);
  }

  // 즐겨찾기에 없으면 추가, 있으면 해제. 결과(추가됐는지)를 돌려줌
  function toggleFavorite(item) {
    const list = getFavorites();
    const idx = list.findIndex((f) => f.id === item.id);
    if (idx >= 0) {
      list.splice(idx, 1);
      writeStore(KEYS.favorites, list);
      return false;
    }
    list.unshift({ id: item.id, name: item.name, company: item.company || "", savedAt: new Date().toISOString() });
    writeStore(KEYS.favorites, list);
    return true;
  }

  // 최근 본 제품: 같은 제품은 맨 앞으로 옮기고 최대 30개까지 보관
  function addRecent(item) {
    const list = readStore(KEYS.recent, []).filter((r) => r.id !== item.id);
    list.unshift({ id: item.id, name: item.name, company: item.company || "", viewedAt: new Date().toISOString() });
    writeStore(KEYS.recent, list.slice(0, 30));
  }

  /* ---------- 제품명 도우미 ---------- */
  // '(수출용)' 제품은 수출 전용이라 국내 화면에서 숨김
  const isExportOnly = (name) => /수출용|수출전용/.test(String(name || ""));
  // '(수출명:○○)' 표기는 국내 판매 제품의 수출 이름 → 목록에서는 떼고 보여줌
  function displayName(name) {
    let s = String(name || "");
    for (let guard = 0; guard < 3; guard++) {
      const m = s.match(/\s*\((수출명|수출,\s*군납명)/);
      if (!m) break;
      // 괄호 짝을 맞춰 '(수출명 … )' 전체를 제거 (안에 괄호가 또 있어도 처리)
      let depth = 0, end = -1;
      for (let i = m.index + m[0].indexOf("("); i < s.length; i++) {
        if (s[i] === "(") depth++;
        else if (s[i] === ")" && --depth === 0) { end = i; break; }
      }
      if (end < 0) break;
      s = s.slice(0, m.index) + s.slice(end + 1);
    }
    return s.trim() || String(name || "");
  }

  return {
    isExportOnly, displayName,
    getFavorites, isFavorite, toggleFavorite, addRecent,
    KEYS, ROOT, readStore, writeStore, loadData,
    formatLongDate, formatShortDate, parseDate, lastWeekRange, formatRange,
    formatUpdated, escapeHTML,
  };
})();
