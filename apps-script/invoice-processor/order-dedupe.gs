// =====================================================================
// ORDER / INVOICE DEDUPE
// =====================================================================
//
// THE PROBLEM
// Southern deliveries arrive as two documents: a Pepper order confirmation
// (6-char alphanumeric ref, e.g. RXUUDE) and, later, the real tax invoice
// (all-digit number, e.g. 5650395). Both get captured, and normal dedupe
// can't see it — different reference AND different total, because the
// invoice bills delivered weight rather than the ordered estimate.
//
// THE KEY
// The tax invoice PRINTS the order code. So the invoice can always be
// matched back to its order; the order can never be matched forward.
// Dedupe therefore always resolves IN FAVOUR OF THE INVOICE.
//
// SAFETY NET
// An order with no matching invoice is left counting as spend. If Southern
// stop sending PDFs again, the order confirmations silently take over and
// nothing is lost — which is the whole reason they were turned on.
//
// Superseded rows are NOT deleted. Their type becomes "superseded" so they
// drop out of spend but stay in the sheet for audit.

var DEDUPE = {
  SUPPLIER_MATCH: "SOUTHERN",   // only this supplier has the two-document pattern
  SCAN_ROWS: 400,               // how far back the live supersede check looks
  COL_TYPE: 11,                 // K
  COL_ORDER_REF: 16             // P
};

// An all-digit reference is a tax invoice. Anything containing a letter is an
// order code. (Southern order codes are alphanumeric — 6WCGX5, BGE0KU — so
// "no digits" is NOT the right test.)
function isOrderRef_(ref) { return /[A-Za-z]/.test(String(ref || "")); }

function fileIdFrom_(url) {
  var m = /\/d\/([A-Za-z0-9_-]+)/.exec(String(url || ""));
  return m ? m[1] : "";
}


// ---------------------------------------------------------------- backfill
//
// Run auditOrderDuplicates() first. It writes NOTHING — it reports which order
// rows are duplicated by a later tax invoice. Drive indexes the text inside
// PDFs, so the archived invoice PDFs are searched for each order code; no
// re-extraction, no API cost, no manual PDF opening.
//
// First run will ask for Drive authorisation.

function auditOrderDuplicates() { orderDupeCore_(false); }

// Only after you've read the audit log and it looks right.
function applyOrderDuplicates() { orderDupeCore_(true); }

function orderDupeCore_(apply) {
  var inv = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Invoices");
  var data = inv.getDataRange().getValues();

  var orders = [], byFileId = {};
  for (var i = 1; i < data.length; i++) {
    var supplier = String(data[i][2] || "").toUpperCase();
    if (supplier.indexOf(DEDUPE.SUPPLIER_MATCH) < 0) continue;
    if (String(data[i][10] || "") === "superseded") continue;

    var ref = String(data[i][3] || "").replace(/^'/, "").trim();
    var rec = { row: i + 1, ref: ref, venue: data[i][1], date: data[i][4], total: data[i][8] };

    if (isOrderRef_(ref)) {
      orders.push(rec);
    } else {
      var fid = fileIdFrom_(data[i][13]);
      if (fid) byFileId[fid] = rec;      // archived tax-invoice PDFs, by Drive file id
    }
  }

  var hits = [], misses = [];
  orders.forEach(function (o) {
    if (!o.ref) return;
    var found = null;
    try {
      var files = DriveApp.searchFiles('fullText contains "' + o.ref + '" and trashed = false');
      while (files.hasNext() && !found) found = byFileId[files.next().getId()] || null;
    } catch (e) {
      Logger.log("Drive search failed for " + o.ref + ": " + e.message);
      return;
    }
    if (found) hits.push({ order: o, invoice: found }); else misses.push(o);
  });

  Logger.log("=== ORDERS SUPERSEDED BY A TAX INVOICE ===");
  hits.forEach(function (h) {
    Logger.log("row " + h.order.row + "  " + h.order.ref + "  " + h.order.venue +
      "  " + fmtDD_(h.order.date) + "  $" + money2_(h.order.total) +
      "   ->  invoice " + h.invoice.ref + " (row " + h.invoice.row + ")  $" + money2_(h.invoice.total));
  });
  if (!hits.length) Logger.log("none");

  Logger.log("");
  Logger.log("=== ORDERS WITH NO MATCHING INVOICE (left counting as spend) ===");
  misses.forEach(function (o) {
    Logger.log("row " + o.row + "  " + o.ref + "  " + o.venue + "  " +
      fmtDD_(o.date) + "  $" + money2_(o.total));
  });
  if (!misses.length) Logger.log("none");

  var dup = hits.reduce(function (s, h) { return s + (Number(h.order.total) || 0); }, 0);
  Logger.log("");
  Logger.log("--- " + hits.length + " duplicate order row(s) worth $" + money2_(dup) +
    "; " + misses.length + " unmatched. " + (apply ? "APPLYING." : "Nothing was changed.") + " ---");

  if (apply) {
    hits.forEach(function (h) { inv.getRange(h.order.row, DEDUPE.COL_TYPE).setValue("superseded"); });
    Logger.log("Marked " + hits.length + " row(s) superseded. Refresh the explorer.");
  }
}


// ---------------------------------------------------------------- going forward
//
// Called from writeInvoice_ when a tax invoice reports an order_ref. Marks the
// earlier order row superseded so the pair never both count. Returns a note or "".

// Suppliers whose orders reach the inbox as their own row before the tax invoice does.
// orderKey turns a reference into the key both documents share, or "" if the reference is
// not an order of that kind. It is applied to the invoice's order_ref AND to each earlier
// row's invoice_number, so the two only meet on a real order.
//   Southern: Pepper order code (letters in it) vs all-digit tax invoice; the invoice
//             prints the code as is.
//   Doppio:   Ordermentum notification (notifications@ordermentum.com, ref OMO106903, no
//             PDF) vs the Doppio tax invoice, whose order_ref is DP_ plus that number
//             (DP_OMO106903). Added 27 Nov 2026; OMO106903 had been superseded by hand.
var ORDER_PAIRS = [
  { supplier: /SOUTHERN/i,
    orderKey: function (ref) { return isOrderRef_(ref) ? ref.toUpperCase() : ""; } },
  { supplier: /DOPPIO/i,
    orderKey: function (ref) { var m = /OMO[\s_\-]*(\d+)/i.exec(ref); return m ? "OMO" + m[1] : ""; } }
];

function supersedeOrderRow_(invSheet, supplier, orderRef) {
  var ref = String(orderRef || "").replace(/^'/, "").trim();
  if (!ref) return "";
  var pair = null;
  for (var p = 0; p < ORDER_PAIRS.length; p++) {
    if (ORDER_PAIRS[p].supplier.test(String(supplier || ""))) { pair = ORDER_PAIRS[p]; break; }
  }
  if (!pair) return "";
  var key = pair.orderKey(ref);
  if (!key) return "";

  var last = invSheet.getLastRow();
  if (last < 2) return "";
  var start = Math.max(2, last - DEDUPE.SCAN_ROWS);
  var n = last - start + 1;
  var rows = invSheet.getRange(start, 1, n, DEDUPE.COL_ORDER_REF).getValues();

  for (var i = rows.length - 1; i >= 0; i--) {
    if (String(rows[i][10] || "") !== "invoice") continue;   // skips superseded and credits
    if (!pair.supplier.test(String(rows[i][2] || ""))) continue;
    if (pair.orderKey(String(rows[i][3] || "").replace(/^'/, "").trim()) !== key) continue;

    invSheet.getRange(start + i, DEDUPE.COL_TYPE).setValue("superseded");
    return "order " + key + " superseded by this invoice";
  }
  return "";
}

function money2_(v) { return (Math.round((Number(v) || 0) * 100) / 100).toFixed(2); }

function fmtDD_(d) {
  return (d instanceof Date)
    ? Utilities.formatDate(d, Session.getScriptTimeZone(), "yyyy-MM-dd")
    : String(d || "");
}
