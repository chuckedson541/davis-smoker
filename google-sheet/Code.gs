/**
 * Davis Smoker: shared log stored in this Google Sheet.
 *
 * Paste this whole file into Extensions > Apps Script of a new Google Sheet,
 * then Deploy > New deployment > Web app (Execute as: Me, Who has access: Anyone).
 * Put the Web app URL into the app's Settings on each phone.
 *
 * Each record lives on one row of the "docs" tab:
 *   A collection | B id | C updated (ms) | D deleted | E... record JSON (split across cells if long)
 * The "Readable" tabs are rebuilt for you to look at; the app never reads them.
 */

var SHEET = 'docs';
var CHUNK = 45000;          // Sheets allows 50,000 characters per cell
var MAX_CHUNKS = 20;

var PLAN = [
  "Measure each shelf's depth",
  'Inspect the smoker and trailer, then do the burn-out and the 6-hour test fire with probes',
  'Practice cooks: pork butt first, then chicken, ribs, and brisket last',
  "Smoke turkeys for family at Thanksgiving as a dry run for next year's preorders",
  'Call Lane County Environmental Health with the questions on the Prep tab',
  'Food handler cards for Max and Ben; one takes a Certified Food Protection Manager course',
  'Pick a business name and form the LLC',
  'Get quotes: insurance, a concession trailer or sink setup, road-legal trailer work, meat and firewood',
  'Visit three breweries with samples and ask about spring slots'
];

function doGet() {
  return json_({ ok: true, app: 'davis-smoker', now: Date.now() });
}

function doPost(e) {
  var req;
  try { req = JSON.parse((e && e.postData && e.postData.contents) || '{}'); }
  catch (err) { return json_({ ok: false, error: 'bad_request' }); }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) return json_({ ok: false, error: 'busy' });
  try {
    var sheet = sheet_();
    var table = read_(sheet);
    var cache = CacheService.getScriptCache();
    var ops = Array.isArray(req.ops) ? req.ops.slice(0, 100) : [];
    var seen = ops.length ? (cache.getAll(ops.map(function (o) { return 'op:' + o.oid; })) || {}) : {};
    var now = Date.now();
    var applied = [], fresh = {};

    ops.forEach(function (op) {
      if (!op || !op.oid || !op.c || !op.id) return;
      applied.push(op.oid);
      if (seen['op:' + op.oid]) return;                       // already applied on an earlier try
      var key = op.c + '/' + op.id;
      var row = table.byKey[key];
      var cur = row && !row.del ? row.data : null;
      var next = applyOp(cur, op);
      if (next === undefined) return;                         // nothing to change
      if (!row) { row = { c: op.c, id: op.id, r: 0 }; table.byKey[key] = row; table.rows.push(row); }
      row.data = next; row.del = next === null; row.u = now; row.dirty = true;
      fresh['op:' + op.oid] = '1';
    });

    if (applied.length) {
      write_(sheet, table);
      cache.putAll(fresh, 21600);
    }

    var since = Number(req.since) || 0;
    var docs = table.rows.filter(function (r) { return r.u >= since; }).map(function (r) {
      return { c: r.c, id: r.id, u: r.u, del: !!r.del, data: r.del ? null : r.data };
    });
    if (applied.length) { try { readable_(table); } catch (err) {} }
    return json_({ ok: true, now: now, applied: applied, docs: docs });
  } finally {
    lock.releaseLock();
  }
}

/* ---------- the same merge rules the app uses on the phone ---------- */
function applyOp(cur, op) {
  switch (op.op) {
    case 'set': return op.data && typeof op.data === 'object' ? op.data : undefined;
    case 'delete': return cur ? null : undefined;
    case 'update': return cur ? deepMerge(cur, op.data || {}) : undefined;
    case 'push': {
      var d = cur ? clone(cur) : (op.init ? clone(op.init) : null);
      if (!d) return undefined;
      var arr = Array.isArray(d[op.field]) ? d[op.field] : [];
      var v = op.value;
      if (!(v && v.id && arr.some(function (x) { return x && x.id === v.id; }))) arr.push(v);
      d[op.field] = arr; return d;
    }
    case 'pull': {
      if (!cur) return undefined;
      var p = clone(cur);
      p[op.field] = (Array.isArray(p[op.field]) ? p[op.field] : []).filter(function (x) { return !(x && x.id === op.match); });
      return p;
    }
    case 'inc': {
      if (!cur) return undefined;
      var q = clone(cur);
      var n = (Number(q[op.field]) || 0) + (Number(op.by) || 0);
      if (op.min != null && n < op.min) n = op.min;
      q[op.field] = Math.round(n * 1000) / 1000; return q;
    }
  }
  return undefined;
}
function isObj(x) { return x !== null && typeof x === 'object' && !Array.isArray(x); }
function clone(x) { return x == null ? x : JSON.parse(JSON.stringify(x)); }
function deepMerge(a, b) {
  var out = clone(a) || {};
  Object.keys(b).forEach(function (k) {
    out[k] = isObj(b[k]) && isObj(out[k]) ? deepMerge(out[k], b[k]) : clone(b[k]);
  });
  return out;
}

/* ---------- sheet storage ---------- */
function sheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET);
  if (!sh) {
    sh = ss.insertSheet(SHEET);
    sh.getRange('A:Z').setNumberFormat('@');   // keep ids, dates and JSON as plain text
    sh.getRange(1, 1, 1, 5).setValues([['collection', 'id', 'updated', 'deleted', 'json']]);
    sh.setFrozenRows(1);
    var items = PLAN.map(function (t) { return { t: t, at: null }; });
    sh.appendRow(['plan', 'checklist', Date.now(), false, JSON.stringify({ items: items })]);
  }
  return sh;
}
function read_(sh) {
  var last = sh.getLastRow(), rows = [], byKey = {};
  if (last >= 2) {
    var width = Math.max(5, sh.getLastColumn());
    var vals = sh.getRange(2, 1, last - 1, width).getValues();
    vals.forEach(function (v, i) {
      if (!v[0]) return;
      var text = v.slice(4).join('');
      var data = null;
      try { data = text ? JSON.parse(text) : null; } catch (err) { data = null; }
      var row = { c: String(v[0]), id: String(v[1]), u: Number(v[2]) || 0, del: String(v[3]).toLowerCase() === 'true', data: data, r: i + 2 };
      rows.push(row); byKey[row.c + '/' + row.id] = row;
    });
  }
  return { rows: rows, byKey: byKey };
}
function write_(sh, table) {
  table.rows.forEach(function (row) {
    if (!row.dirty) return;
    var text = row.del ? '' : JSON.stringify(row.data);
    var chunks = [];
    for (var i = 0; i < text.length; i += CHUNK) chunks.push(text.slice(i, i + CHUNK));
    if (!chunks.length) chunks.push('');
    if (chunks.length > MAX_CHUNKS) throw new Error('Record too large: ' + row.c + '/' + row.id);
    var values = [row.c, row.id, row.u, !!row.del].concat(chunks);
    if (!row.r) { row.r = sh.getLastRow() + 1; }
    var width = Math.max(sh.getLastColumn(), values.length);
    while (values.length < width) values.push('');
    sh.getRange(row.r, 1, 1, values.length).setValues([values]);
    row.dirty = false;
  });
}
function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ---------- tabs for people to read (rebuilt after each change) ---------- */
function readable_(table) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var live = table.rows.filter(function (r) { return !r.del && r.data; });
  var tz = Session.getScriptTimeZone();
  var fmt = function (ms) { return ms ? Utilities.formatDate(new Date(ms), tz, 'yyyy-MM-dd HH:mm') : ''; };

  var sales = [['Date', 'Time', 'Item', 'Qty', 'Price', 'Total', 'Payment', 'Place', 'Logged by']];
  live.filter(function (r) { return r.c === 'sales'; }).forEach(function (r) {
    (r.data.lines || []).forEach(function (l) {
      sales.push([r.data.day, fmt(l.at).slice(11), l.name, l.qty, l.price, (l.qty || 0) * (l.price || 0), l.pay || '', l.place || '', l.by || '']);
    });
  });
  var cooks = [['Run', 'Fire lit', 'Fire out', 'Meat', 'How many', 'On', 'Off', 'Raw lb', 'Cooked lb', 'Yield %', 'Splits', 'Practice', 'Notes']];
  live.filter(function (r) { return r.c === 'cooks'; }).sort(function (a, b) { return (b.data.startedAt || 0) - (a.data.startedAt || 0); }).forEach(function (r) {
    var c = r.data, splits = 0;
    (c.log || []).forEach(function (e) { if (e && e.kind === 'wood') splits += e.n || 0; });
    var items = Object.keys(c.items || {}).map(function (k) { return c.items[k]; }).filter(function (x) { return x; });
    if (!items.length) items = [null];
    items.forEach(function (it) {
      cooks.push([c.name, fmt(c.startedAt), fmt(c.endedAt), it ? it.label : '', it ? it.count : '', it ? fmt(it.onAt) : '', it ? fmt(it.offAt) : '',
        it ? it.rawLb : '', it ? it.cookedLb : '', it && it.rawLb && it.cookedLb ? Math.round(it.cookedLb / it.rawLb * 100) : '', splits, c.practice ? 'yes' : 'no', c.notes || '']);
    });
  });
  var stock = [['Item', 'Group', 'On hand', 'Unit', 'Reorder at', 'Cost per unit']];
  live.filter(function (r) { return r.c === 'inventory'; }).forEach(function (r) {
    var i = r.data; stock.push([i.name, i.cat, i.qty, i.unit, i.low, i.cost]);
  });
  [['Readable: Sales', sales], ['Readable: Cooks', cooks], ['Readable: Stock', stock]].forEach(function (t) {
    var sh = ss.getSheetByName(t[0]) || ss.insertSheet(t[0]);
    sh.clearContents();
    var w = t[1][0].length;
    sh.getRange(1, 1, t[1].length, w).setValues(t[1].map(function (row) { while (row.length < w) row.push(''); return row.map(function (v) { return v == null ? '' : v; }); }));
    sh.setFrozenRows(1);
  });
}
