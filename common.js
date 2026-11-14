// Общая логика: загрузка прайсов НаДа-ДЕЗ с Google Диска и разбор строк.
//
// Формат прайса (столбцы A–I):
//   A Наименование | B Производитель | C Формуляция | D ДВ | E Группа |
//   F Расход | G Упаковка | H Ед. изм. | I Цена
// Особенности:
//   - строка, где заполнен только столбец A, — заголовок раздела;
//   - строка с пустым A, но с ценой — другая фасовка товара из строки выше;
//   - в разделах «...для бытового применения» ДВ стоит в D или E, а в F/G — от каких вредителей.
(function () {
  const cfg = window.PRICE_CONFIG;
  const A = 0, MAKER = 1, FORM = 2, DV = 3, GROUP = 4, PACK = 6, UNIT = 7, PRICE = 8;

  // Разбор CSV по RFC 4180 (кавычки, запятые и переносы строк внутри ячеек).
  function parseCSV(text) {
    const rows = [];
    let row = [], field = "", i = 0, inQuotes = false;
    text = text.replace(/^﻿/, "");
    while (i < text.length) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          inQuotes = false; i++; continue;
        }
        field += c; i++; continue;
      }
      if (c === '"') { inQuotes = true; i++; continue; }
      if (c === ",") { row.push(field); field = ""; i++; continue; }
      if (c === "\r") { i++; continue; }
      if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
      field += c; i++;
    }
    if (field !== "" || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  const clean = s => String(s || "").replace(/\s+/g, " ").trim();
  const norm = s => clean(s).toLowerCase().replace(/ё/g, "е").replace(/["'«»™®]/g, "").replace(/[\s.,;:]+$/g, "");

  // "1 525,00" → 1525; "1900,00   скидка от обьема" → 1900 + примечание; "65,00 ₽" → 65
  function parsePrice(raw) {
    const s = clean(raw);
    const m = s.match(/^(\d[\d\s ]*(?:[.,]\d+)?)\s*(?:₽|руб\.?|р\.?)?\s*(.*)$/i);
    if (!m) return null;
    const value = Number(m[1].replace(/[\s ]/g, "").replace(",", "."));
    return isNaN(value) ? null : { value, note: m[2] };
  }

  // Короткий постоянный код товара: хэш от «название + формуляция + фасовка».
  // Не зависит от цены и порядка строк — меняется только если переименовать товар или фасовку.
  function makeId(it) {
    let h = 0x811c9dc5;
    const s = norm(it.name) + "|" + norm(it.form) + "|" + norm(it.packKey);
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(36);
  }

  function parseList(rows, source) {
    const items = [];
    let household = false, last = null;
    for (const r of rows) {
      const cell = k => clean(r[k]);
      const filled = r.filter(x => clean(x)).length;

      // заголовок раздела
      if (filled === 1 && cell(A)) {
        household = /бытов/i.test(cell(A));
        last = null;
        continue;
      }
      const price = parsePrice(cell(PRICE));
      if (!price) continue;                         // шапка, контакты, пустые строки

      let base;
      if (cell(A)) {
        base = household
          ? { name: cell(A), maker: cell(MAKER), dv: cell(DV) || cell(GROUP), pests: cell(PACK) || cell(PACK - 1) }
          : { name: cell(A), maker: cell(MAKER), form: cell(FORM), dv: cell(DV) };
        last = base;
      } else if (last) {
        base = last;                                // доп. фасовка товара выше
      } else continue;

      // Фасовка: обычно в «Ед. изм.» (H); если там просто «1шт», а граммовка в «Упаковке» (G) — показываем обе.
      const g = household ? "" : cell(PACK), u = household ? "" : cell(UNIT);
      let pack = u || g;
      if (g && u && norm(g) !== norm(u) && /^\d*\s*шт\.?$/i.test(u)) pack = g + ", " + u;
      items.push({ ...base, pack, packKey: g + "|" + u, price: price.value, note: price.note, source });
    }
    return items;
  }

  function sourceUrl(src) {
    const m = String(src).match(/\/d\/([\w-]{20,})/);
    return m ? "https://docs.google.com/spreadsheets/d/" + m[1] + "/export?format=csv" : src;
  }

  async function loadPrice() {
    const srcs = [].concat(cfg.PRICE_LISTS || []).filter(Boolean);
    if (!srcs.length) throw new Error("В config.js не указаны ссылки на прайсы (PRICE_LISTS).");
    const lists = await Promise.all(srcs.map(async (src, n) => {
      const res = await fetch(sourceUrl(src), { cache: "no-store" });
      if (!res.ok) throw new Error("Прайс №" + (n + 1) + " не загрузился (HTTP " + res.status + "). Проверь, что доступ к файлу открыт по ссылке.");
      return parseList(parseCSV(await res.text()), n + 1);
    }));

    // присваиваем коды; полные дубли (одинаковые название, формуляция и фасовка) получают суффикс -2, -3…
    const seen = {};
    const items = lists.flat();
    for (const it of items) {
      const id = makeId(it);
      seen[id] = (seen[id] || 0) + 1;
      it.id = seen[id] > 1 ? id + "-" + seen[id] : id;
    }
    return items;
  }

  function formatPrice(v) {
    return v.toLocaleString("ru-RU", { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 }) + " ₽";
  }

  function productUrl(id) {
    let base = cfg.SITE_URL || new URL("index.html", location.href).href;
    if (!/\.html?$/i.test(base) && !base.endsWith("/")) base += "/";
    return base + "?id=" + encodeURIComponent(id);
  }

  window.Price = { parseCSV, parseList, loadPrice, formatPrice, productUrl };
})();
