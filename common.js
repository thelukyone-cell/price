// Общая логика: загрузка прайсов НаДа-ДЕЗ с Google Диска и разбор строк.
//
// Читаются все вкладки каждого прайса (список вкладок — со страницы htmlview, CORS ok).
//
// Основной формат (столбцы A–I):
//   A Наименование | B Производитель | C Формуляция | D ДВ | E Группа |
//   F Расход | G Упаковка | H Ед. изм. | I Цена
// Если во вкладке есть строка заголовков («наименование … цена»), столбцы берутся по ней
// (так устроена вкладка дезсредств: A наименование | B описание | F упаковка | G цена).
// Во вкладке «Оборудование и СИЗ» столбец D — описание, а не ДВ.
// Особенности:
//   - строка, где заполнен только столбец A, — заголовок раздела;
//   - строка с пустым A, но с ценой — другая фасовка товара из строки выше;
//   - в разделах «...для бытового применения» ДВ стоит в D или E, а в F/G — от каких вредителей.
(function () {
  const cfg = window.PRICE_CONFIG;
  // Столбцы основного формата (A–I). Без строки заголовков вкладка читается так.
  const DEFAULT_COLS = { name: 0, maker: 1, form: 2, dv: 3, group: 4, pack: 6, unit: 7, price: 8 };
  const HEADER_COLS = [
    [/^наименован/, "name"], [/^производ/, "maker"], [/^формуляц/, "form"], [/^дв$/, "dv"],
    [/^групп/, "group"], [/^упаков/, "pack"], [/^ед\.?\s*изм/, "unit"], [/^цена/, "price"], [/^описан/, "desc"],
  ];

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

  // Строка заголовков → номера столбцов, или null, если это не заголовки.
  function headerCols(r) {
    const cols = {};
    r.forEach((x, k) => {
      const h = norm(x);
      for (const [re, key] of HEADER_COLS) if (re.test(h) && !(key in cols)) cols[key] = k;
    });
    return "name" in cols && "price" in cols ? cols : null;
  }

  // sheet — название вкладки
  function parseList(rows, source, sheet) {
    const items = [];
    const equipment = /оборудован|сиз/i.test(sheet || "");
    let c = DEFAULT_COLS, household = false, last = null;
    for (const r of rows) {
      const cell = k => k === undefined ? "" : clean(r[k]);
      const filled = r.filter(x => clean(x)).length;

      const hdr = headerCols(r);
      if (hdr) { c = hdr; last = null; continue; }

      // заголовок раздела (бывает и в столбце B)
      if (filled === 1 && !parsePrice(cell(c.price))) {
        household = /бытов/i.test(r.map(clean).find(Boolean));
        last = null;
        continue;
      }
      const price = parsePrice(cell(c.price));
      if (!price) continue;                         // шапка, контакты, пустые строки

      let base;
      if (cell(c.name)) {
        const name = cell(c.name), maker = cell(c.maker);
        base = household
          ? { name, maker, dv: cell(c.dv) || cell(c.group), pests: cell(c.pack) || cell(c.pack - 1) }
          : equipment
          ? { name, maker, form: cell(c.form), desc: cell(c.dv) }
          : { name, maker, form: cell(c.form), dv: cell(c.dv), desc: cell(c.desc) };
        last = base;
      } else if (last) {
        base = last;                                // доп. фасовка товара выше
      } else continue;

      // Фасовка: обычно в «Ед. изм.» (H); если там просто «1шт», а граммовка в «Упаковке» (G) — показываем обе.
      const g = household ? "" : cell(c.pack), u = household ? "" : cell(c.unit);
      let pack = u || g;
      if (g && u && norm(g) !== norm(u) && /^\d*\s*шт\.?$/i.test(u)) pack = g + ", " + u;
      items.push({ ...base, pack, packKey: g + "|" + u, price: price.value, note: price.note, source, sheet: sheet || "" });
    }
    return items;
  }

  function docBase(src) {
    const m = String(src).match(/\/d\/([\w-]{20,})/);
    return m ? "https://docs.google.com/spreadsheets/d/" + m[1] : null;
  }

  // Список вкладок [{name, gid}] в порядке, как в файле. Не удалось — null (тогда читаем только первую).
  async function listSheets(base) {
    try {
      const res = await fetch(base + "/htmlview", { cache: "no-store" });
      if (!res.ok) return null;
      const html = await res.text();
      const re = /items\.push\(\{name: "((?:[^"\\]|\\.)*)", pageUrl: "(?:[^"\\]|\\.)*", gid: "(\d+)"/g;
      const sheets = [];
      for (let m; (m = re.exec(html));) {
        let name = m[1];
        try { name = JSON.parse('"' + name.replace(/\\x([0-9a-f]{2})/gi, "\\u00$1") + '"'); } catch (e) {}
        sheets.push({ name: clean(name), gid: m[2] });
      }
      return sheets.length ? sheets : null;
    } catch (e) { return null; }
  }

  async function fetchCSV(url, n) {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error("Прайс №" + n + " не загрузился (HTTP " + res.status + "). Проверь, что доступ к файлу открыт по ссылке.");
    return parseCSV(await res.text());
  }

  // Все вкладки одного прайса → массив списков товаров, по одному на вкладку.
  async function loadFile(src, n) {
    const base = docBase(src);
    if (!base) return [parseList(await fetchCSV(src, n), n, "")];
    const sheets = await listSheets(base);
    const csv = base + "/export?format=csv";
    if (!sheets) return [parseList(await fetchCSV(csv, n), n, "")];
    // первую вкладку берём без gid — ровно как раньше
    return Promise.all(sheets.map(async (sh, k) =>
      parseList(await fetchCSV(k ? csv + "&gid=" + sh.gid : csv, n), n, sh.name)));
  }

  async function loadPrice() {
    const srcs = [].concat(cfg.PRICE_LISTS || []).filter(Boolean);
    if (!srcs.length) throw new Error("В config.js не указаны ссылки на прайсы (PRICE_LISTS).");
    const files = await Promise.all(srcs.map((src, n) => loadFile(src, n + 1)));

    // присваиваем коды; полные дубли (одинаковые название, формуляция и фасовка) получают суффикс -2, -3…
    // Порядок: сначала первые вкладки всех прайсов, потом остальные — так у товаров, что были
    // до чтения всех вкладок, коды (и суффиксы дублей) не меняются и напечатанные QR работают.
    const seen = {};
    const items = files.map(f => f[0]).concat(...files.map(f => f.slice(1))).flat();
    for (const it of items) {
      const id = makeId(it);
      seen[id] = (seen[id] || 0) + 1;
      it.id = seen[id] > 1 ? id + "-" + seen[id] : id;
    }
    return items;
  }

  // Розничные цены (версия для Перми): Google-таблица cfg.RETAIL_LIST, в строке заголовков —
  // столбцы «Код» и «Розница» (по желанию «Наименование» и «Фасовка»). Цены вписываются вручную.
  // Возвращает функцию: товар → { value, note } или null.
  async function loadRetail() {
    const none = () => null;
    if (!cfg.RETAIL_LIST) return none;
    const base = docBase(cfg.RETAIL_LIST);
    const res = await fetch(base ? base + "/export?format=csv" : cfg.RETAIL_LIST, { cache: "no-store" });
    if (!res.ok) throw new Error("Таблица розничных цен не загрузилась (HTTP " + res.status + "). Проверь, что доступ к ней открыт по ссылке.");
    const rows = parseCSV(await res.text());
    const byId = {}, byName = {};
    let c = null;
    for (const r of rows) {
      if (!c) {
        const h = r.map(norm), find = re => h.findIndex(x => re.test(x));
        const k = { id: find(/^код/), retail: find(/^розн/), name: find(/^наименован/), pack: find(/^фасовк/) };
        if (k.retail >= 0 && (k.id >= 0 || k.name >= 0)) c = k;
        continue;
      }
      const p = parsePrice(r[c.retail]);
      if (!p) continue;
      if (c.id >= 0 && clean(r[c.id])) byId[clean(r[c.id])] = p;
      // запасной вариант — по названию и фасовке (если таблица исказила код, например «12e4» → число)
      if (c.name >= 0 && clean(r[c.name])) byName[norm(r[c.name]) + "|" + norm(c.pack >= 0 ? r[c.pack] : "")] = p;
    }
    return it => byId[it.id] || byName[norm(it.name) + "|" + norm(variant(it))] || null;
  }

  function formatPrice(v) {
    return v.toLocaleString("ru-RU", { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 }) + " ₽";
  }

  function productUrl(id) {
    let base = cfg.SITE_URL || new URL("index.html", location.href).href;
    if (!/\.html?$/i.test(base) && !base.endsWith("/")) base += "/";
    return base + "?id=" + encodeURIComponent(id);
  }

  // Подпись под названием: «формуляция · фасовка». Длинная «формуляция» (во вкладке оборудования
  // там бывает целое описание) в подпись не идёт — она показывается как описание.
  const LONG_FORM = 40;
  const variant = it => [it.form && it.form.length <= LONG_FORM ? it.form : "", it.pack].filter(Boolean).join(" · ");
  const description = it => [it.form && it.form.length > LONG_FORM ? it.form : "", it.desc].filter(Boolean).join("\n");

  window.Price = { parseCSV, parseList, loadPrice, loadRetail, formatPrice, productUrl, variant, description };
})();
