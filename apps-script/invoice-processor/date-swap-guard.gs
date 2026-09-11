// =====================================================================
// DATE SWAP GUARD  (v2 — backfill audit removed)
// =====================================================================
//
// WHY THIS WORKS
// The email that carried the invoice is a hard reference point: invoices
// arrive within days of their own date. Of the two possible readings of an
// ambiguous DD/MM date, only one lands near the email — the other is ~1-11
// months away. A date and its swap are never closer than ~28 days, so a
// window this tight can never contain both.
//
// It only swaps when the original is OUTSIDE the window AND the swap is
// INSIDE it. Anything else is left exactly as extracted.
//
// NOTE: this is write-time only. It uses the live email's own date, which is
// always correct even during a backfill run. It never touches rows already in
// the sheet — those need a different method, because column A (scanned) is the
// run date, not the email date.


// ---------------------------------------------------------------- 1. helpers

var DATE_BACK_DAYS = 14;   // how far before the email an invoice may legitimately be dated
var DATE_FWD_DAYS  = 21;   // order/delivery confirmations can sit in the near future

function pad2_(n) { return (n < 10 ? "0" : "") + n; }

// Mutates result.invoice_date in place. Call it straight after extraction so the
// corrected date flows through to the Drive filename and the sheet alike.
function fixInvoiceDate_(result, emailDate, notes) {
  var iso = String(result.invoice_date || "");
  var dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!dm) return false;

  var y = +dm[1], mo = +dm[2], d = +dm[3];

  // 13+ can't be a month, so the reading is unambiguous — never touch it.
  // d === mo is a no-op swap.
  if (d > 12 || mo > 12 || d === mo) return false;

  var ref = emailDate ? emailDate.getTime() : Date.now();
  var lo = ref - DATE_BACK_DAYS * 864e5;
  var hi = ref + DATE_FWD_DAYS * 864e5;
  var inWindow = function (yy, mm, dd) {
    var t = new Date(yy, mm - 1, dd).getTime();
    return t >= lo && t <= hi;
  };

  if (inWindow(y, mo, d)) return false;      // original is plausible — leave it
  if (!inWindow(y, d, mo)) return false;     // swap is no better — leave it

  result.invoice_date = dm[1] + "-" + pad2_(d) + "-" + pad2_(mo);
  if (notes) notes.push("date " + iso + " -> " + result.invoice_date + " (day/month swap corrected)");
  result._date_swapped = true;
  return true;
}


// ---------------------------------------------------------------- 2. call sites
//
// These two lines go in Code.gs. Without them this file does nothing.
//
// (a) In processAttachments_, after the not_invoice check and BEFORE isDupInvoice_
//     (so the Drive filename gets the corrected date too):
//
//       if (result.not_invoice) { ... return; }
//       fixInvoiceDate_(result, msg.getDate(), notes);          // <-- ADD
//       if (isDupInvoice_(existing, result)) { ... }
//
// (b) In the body lane, immediately before writeInvoice_:
//
//       fixInvoiceDate_(result, msg.getDate(), notes);          // <-- ADD
//       writeInvoice_(sheets, result, msg.getFrom(), "email body", "", msg.getDate(), route_(msg, 2));
//
// (c) OPTIONAL, in writeInvoice_ — tag the source so corrections are visible in
//     the explorer. Just after `var venue = detectVenue_(...)`:
//
//       if (j._date_swapped) route = (route || "") + " date-fixed";


// ---------------------------------------------------------------- 3. prompt tweak (prevention)
//
// Belt and braces — give the model the reference point too. In the attachment
// extraction call, prepend a text block before the document block:
//
//   { type: "text", text: "This email was received on " +
//       Utilities.formatDate(msg.getDate(), Session.getScriptTimeZone(), "yyyy-MM-dd") +
//       ". The invoice date is normally within a few days of that. Australian " +
//       "invoices are DD/MM/YYYY." }
//
// This reduces the error rate but does not remove the need for the guard above —
// the guard is deterministic, the prompt is not.
