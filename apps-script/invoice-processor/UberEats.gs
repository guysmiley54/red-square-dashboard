/**
 * UBEREATS.GS — Uber Eats payout summaries → Invoices / InvoiceLines
 *
 * Invoice Processor project (bound to BG Ops Data), alongside Code.gs and Overheads.gs.
 * Every global here starts with ue / UE_ : Apps Script shares one global scope across
 * files and a name clash does not error, it silently overrides by load order.
 *
 * WHAT IT DOES
 *   Every Sunday night noreply@uber.com sends one "Uber Eats Payouts Summary for <store>
 *   <from> - <to>" per store (three stores: Red Square Cafe Glenorchy, Red Square Cafe
 *   Cambridge, Luma Woodfired Pizza). The email BODY carries the full payout breakdown as
 *   HTML tables - gross sales, marketplace fees and their GST, ad spend, offers, chargebacks,
 *   adjustments, net payout. No PDF is needed and no model call is made: the tables are
 *   fixed-format, so they are parsed deterministically.
 *
 *   One Invoices row per store per pay period, supplier "Uber Eats", category "Overheads"
 *   (Adrian treats delivery-platform fees as overheads, not COGS - same as Doshii, 2 Nov
 *   2026), dated the LAST day of the pay period. total = everything Uber kept out of the
 *   gross = gross sales (inc GST) - net payout. That identity is checked on every email
 *   and the row is written CHECK when it fails.
 *
 *   InvoiceLines (ex GST, they sum to subtotal):
 *     MKTFEE      Marketplace fees            qty = orders, unit_price = fee per order
 *     ADS         Ad spend
 *     OFFERS      Offers on items
 *     OTHER       Other charges               (Uber shows these as a credit, so negative)
 *     CHARGEBACK  Net chargebacks             qty = orders charged back
 *     ADJ         Adjustments
 *     SALES       Uber Eats sales (info only) qty = orders, unit_price 0, line_total 0 -
 *                 so the invoice drill shows what the fees were charged on.
 *   gst = GST on marketplace fees + ad spend + offers + chargebacks. Chargebacks are
 *   refunds Uber gave the customer out of the venue's money: a real revenue loss, so they
 *   sit on the invoice as a cost line rather than vanishing.
 *
 * WHAT IT DOES NOT DO
 *   - It does not touch the monthly statement PDF that rides on the first email of each
 *     month, nor the "Your Uber Eats Monthly Statement is Ready" email. The weekly rows add
 *     up to the month; booking the PDF too would double count.
 *   - It does not know whether Uber Eats orders also reach the POS feed. If they do, sales
 *     are already in SalesFeed/PosSales and only the fees belong here (which is what this
 *     writes). If they don't, Uber sales are missing from the P&L sales line - the SALES
 *     info line on each invoice is there so that can be checked.
 *
 * VENUE
 *   The greeting line is "Hi <store> (<address>)". The subject says "Red Square Cafe" for
 *   BOTH cafes, so the subject can't tell them apart - the address can: 2 Howard Road is
 *   Glenorchy, 66 Kennedy Drive is Cambridge, and the Luma store carries "Luma" in its name
 *   (Luma shares 66 Kennedy Drive, so the name must be tested before the street).
 *
 * DEDUPE
 *   invoice_number = UBER-<GLN|CAM|LUMA>-<period end as YYYYMMDD>, so a re-read of the same
 *   email, or Uber re-sending a week, is caught by Code.gs's existing supplier+number key.
 *   Pay periods are usually Sun-Sat but not always (Cambridge's first was a fortnight,
 *   28 Sep - 11 Oct 2026), so the period END is the key, never a computed week.
 *
 * GMAIL
 *   These land in abeckitt@gmail.com, not accounts@, and are NOT labelled supplier-invoices.
 *   Keep it that way: labelling one would put the monthly PDF through lane 1 and the body
 *   through lane 2 of Code.gs, both of which would send it to the model and book it again.
 *
 * ENTRY POINTS (editor dropdown)
 *   ueSetup()        once: installs the hourly trigger on ueProcessLocked
 *   ueDryRun()       parses the newest UE.DRY_RUN_COUNT summaries and LOGS what it would
 *                    write. Writes nothing. Run this first and read the execution log.
 *   ueProcessLocked() what the trigger runs. Shares the script lock with
 *                    processInvoicesLocked so the two never write at once.
 *   ueBackfill()     one-off: same as ueProcess but with UE.BACKFILL_QUERY (no date cap).
 *                    Run until it reports 0 new.
 *   ueRetryFailed()  removes this file's own FAILED log rows so ueBackfill re-reads them.
 *
 * Uses from Code.gs: getSheets_, processedMessageIds_, existingInvoiceKeys_, isDupInvoice_,
 * markInvoice_, writeInvoice_, logProcessed_, CONFIG.DEFAULT_VENUE. No Code.gs change needed.
 */

var UE = {
  VERSION: "ubereats-111340",
  SUPPLIER: "Uber Eats",
  CATEGORY: "Overheads",
  // Subject-anchored so the marketing mail from the same domain is never looked at.
  QUERY: 'from:noreply@uber.com subject:"Uber Eats Payouts Summary" newer_than:60d',
  BACKFILL_QUERY: 'from:noreply@uber.com subject:"Uber Eats Payouts Summary"',
  MAX_PER_RUN: 12,
  DRY_RUN_COUNT: 6,
  ROUTE: "ubereats",
  // Tolerance for the gross - net = total identity and the printed section totals.
  TOL: 0.06
};

/* Store -> venue. Tested in order; the first match wins. 'name' is tested against the
   store name in the greeting, 'addr' against the address in brackets after it. Luma must
   come first because it shares Cambridge's street. */
var UE_VENUE_RULES = [
  { name: /luma/i,                 venue: "Luma Kitchen",          code: "LUMA" },
  { addr: /howard\s+r(oa)?d/i,     venue: "Red Square Glenorchy",  code: "GLN" },
  { addr: /kennedy\s+dr(ive)?/i,   venue: "Red Square Cambridge",  code: "CAM" }
];

var UE_MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/* ---------------------------------------------------------------- entry points */

function ueSetup() {
  var have = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === "ueProcessLocked"; });
  if (have) { Logger.log("Trigger already installed."); return; }
  ScriptApp.newTrigger("ueProcessLocked").timeBased().everyHours(1).create();
  Logger.log("Installed hourly trigger: ueProcessLocked");
}

function ueProcessLocked() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) { Logger.log("Another run is already in progress - skipping."); return; }
  try { ueProcess(); } finally { lock.releaseLock(); }
}

function ueProcess() { ueRun_(UE.QUERY, false); }
function ueBackfill() { ueRun_(UE.BACKFILL_QUERY, false); }

/**
 * Removes this file's own FAILED rows from ProcessedEmails (notes starting "ubereats:") so
 * the next ueBackfill reads those emails again. Touches nothing else in the tab. Use after a
 * parser fix - 11 Nov 2026: 12 pre-September emails failed on a layout with no GST lines.
 */
function ueRetryFailed() {
  var log = getSheets_().log, last = log.getLastRow();
  if (last < 2) { Logger.log("ProcessedEmails empty."); return; }
  var vals = log.getRange(2, 1, last - 1, 6).getValues(), gone = 0;
  for (var i = vals.length - 1; i >= 0; i--) {
    if (String(vals[i][4]) === "FAILED" && /^ubereats:/.test(String(vals[i][5]))) { log.deleteRow(i + 2); gone++; }
  }
  Logger.log("Removed " + gone + " FAILED ubereats row(s). Now run ueBackfill.");
}

function ueDryRun() {
  var threads = GmailApp.search(UE.QUERY, 0, 20), n = 0;
  for (var t = 0; t < threads.length && n < UE.DRY_RUN_COUNT; t++) {
    var msgs = threads[t].getMessages();
    for (var m = 0; m < msgs.length && n < UE.DRY_RUN_COUNT; m++, n++) {
      var msg = msgs[m];
      try {
        var p = ueParse_(msg.getBody(), msg.getSubject());
        var j = ueInvoice_(p);
        Logger.log(msg.getDate() + " | " + p.store + " @ " + p.address + "\n  -> " + ueSummary_(p, j));
      } catch (e) {
        Logger.log(msg.getDate() + " | " + msg.getSubject() + "\n  -> PARSE FAILED: " + (e && e.message ? e.message : e));
      }
    }
  }
  Logger.log(n + " message(s) read, nothing written.");
}

/* ---------------------------------------------------------------- run */

function ueRun_(query, quiet) {
  var sheets = getSheets_();
  var processedIds = processedMessageIds_(sheets.log);
  var existing = existingInvoiceKeys_(sheets.inv);
  var handled = 0, written = 0, start = 0, PAGE = 50;

  while (handled < UE.MAX_PER_RUN) {
    var threads = GmailApp.search(query, start, PAGE);
    if (!threads.length) break;
    for (var t = 0; t < threads.length && handled < UE.MAX_PER_RUN; t++) {
      // Both cafes' summaries share a subject, so Gmail threads them together - every
      // message in the thread is its own store and must be read, never just the first.
      var msgs = threads[t].getMessages();
      for (var m = 0; m < msgs.length && handled < UE.MAX_PER_RUN; m++) {
        var msg = msgs[m], id = msg.getId();
        if (processedIds[id]) continue;
        processedIds[id] = true;
        handled++;
        var status = "OK", note = "";
        try {
          var p = ueParse_(msg.getBody(), msg.getSubject());
          var j = ueInvoice_(p);
          if (p.orders === 0 && Math.abs(j.total) < 0.005) {
            status = "SKIPPED"; note = "no activity: " + p.store + " " + p.from + " - " + p.to;
          } else if (isDupInvoice_(existing, j)) {
            status = "SKIPPED"; note = "duplicate " + j.invoice_number + ", skipped";
          } else {
            writeInvoice_(sheets, j, msg.getFrom(), "payout summary", "", msg.getDate(), UE.ROUTE);
            markInvoice_(existing, j);
            written++;
            note = ueSummary_(p, j);
          }
        } catch (e) {
          status = "FAILED";
          note = "ubereats: " + String(e && e.message ? e.message : e);
        }
        logProcessed_(sheets.log, msg, status, note);
      }
    }
    start += PAGE;
  }
  if (!quiet) Logger.log(UE.VERSION + ": " + handled + " new message(s), " + written + " invoice(s) written.");
}

/* ---------------------------------------------------------------- parse */

/**
 * HTML body (+ subject, for the error message) -> plain object of the figures.
 * Throws when a required figure is missing, so the email lands FAILED and is visible.
 *
 * Only the FIRST "Payout breakdown" block is read. The first email of a month also carries
 * a "Last month consolidated summary" block with the same labels; reading past the first
 * block would take October's marketplace fee for the week's.
 */
function ueParse_(html, subject) {
  var text = ueText_(html);

  var hi = /Hi\s+(.+?)\s*\(([^)]*)\)\s*,/.exec(text);
  if (!hi) throw new Error("no store greeting in body (" + subject + ")");
  var store = hi[1].trim(), address = hi[2].trim();

  var per = /pay[- ]period\s+of\s+([A-Za-z]{3,9}\s+\d{1,2},\s*\d{4})\s*-\s*([A-Za-z]{3,9}\s+\d{1,2},\s*\d{4})/i.exec(text)
         || /Payout Period\s+([A-Za-z]{3,9}\s+\d{1,2},\s*\d{4})\s*-\s*([A-Za-z]{3,9}\s+\d{1,2},\s*\d{4})/i.exec(text);
  if (!per) throw new Error("no pay period in body (" + subject + ")");
  var from = ueIso_(per[1]), to = ueIso_(per[2]);

  var bStart = text.indexOf("Payout breakdown");
  if (bStart < 0) throw new Error("no 'Payout breakdown' block (" + subject + ")");
  var block = text.slice(bStart);
  var cut = block.length;
  ["Chargebacks ", "Last month consolidated summary", "Access your payout statements", "A simple way to view"].forEach(function (s) {
    var i = block.indexOf(s, 20);
    if (i > 0 && i < cut) cut = i;
  });
  block = block.slice(0, cut);

  function money(label, required) {
    // Label, optional "(N Orders)" or other bracket, then the signed dollar figure.
    var re = new RegExp(label + "(?:\\s*\\([^)]*\\))?\\s*(-?)\\$\\s*([\\d,]+\\.\\d{2})", "i");
    var m = re.exec(block);
    if (!m) { if (required) throw new Error("no '" + label + "' in payout breakdown (" + subject + ")"); return 0; }
    var v = Number(m[2].replace(/,/g, ""));
    return m[1] === "-" ? -v : v;
  }
  function count(label) {
    var m = new RegExp(label + "\\s*\\((\\d+)\\s*Orders?\\)", "i").exec(block);
    return m ? Number(m[1]) : null;
  }

  // "Sales (N Orders) $x" - anchored on the bracket, because the newer layout also prints
  // "Gross Sales $y" just before it and a bare "Sales" would land on that.
  var sm = /Sales\s*\((\d+)\s*Orders?\)\s*(-?)\$\s*([\d,]+\.\d{2})/i.exec(block);
  if (!sm) throw new Error("no 'Sales (N Orders)' line (" + subject + ")");
  var orders = Number(sm[1]);
  var salesLine = (sm[2] === "-" ? -1 : 1) * Number(sm[3].replace(/,/g, ""));

  // THREE layouts (11 Nov 2026, from the first backfill):
  //   legacy (to ~13 Sep 2026): no GST anywhere in the breakdown. "Sales (N Orders)" is the
  //       GST-INCLUSIVE total, and every fee line is inclusive too. The ex/GST split of sales
  //       is only in the daily table's Total row; the fees' GST is not printed at all.
  //   earnings (to ~25 Oct): "Sales" ex GST + "Tax on Sales", "Total Earnings", fee GST lines.
  //   gross (from ~1 Nov): "Gross Sales" header, section headers carry their totals.
  // Legacy is told by the absence of "Tax on Sales" in the block. Its fee GST is derived at
  // 1/11 (every Uber fee line in the later layouts carries 10% GST), and the row's marketplace
  // line says so.
  var legacy = !/Tax on Sales/i.test(block);
  var salesEx, salesTax, grossInc;
  if (legacy) {
    grossInc = salesLine;
    // Daily table: "Total | orders | sales ex | tax | sales inc"
    var dt = /Total\s+\d+\s+\$\s*([\d,]+\.\d{2})\s+\$\s*([\d,]+\.\d{2})\s+\$\s*([\d,]+\.\d{2})/i.exec(text.slice(0, bStart));
    if (dt && Math.abs(Number(dt[3].replace(/,/g, "")) - grossInc) <= 0.01) {
      salesEx = Number(dt[1].replace(/,/g, "")); salesTax = Number(dt[2].replace(/,/g, ""));
    } else {
      salesEx = ueRound_(grossInc / 1.1); salesTax = ueRound_(grossInc - salesEx);
    }
  } else {
    salesEx = salesLine;
    salesTax = money("Tax on Sales", true);
    grossInc = /Total Earnings|Gross Sales/i.test(block)
      ? (money("Total Earnings", false) || money("Gross Sales", false)) : 0;
    if (!grossInc) grossInc = ueRound_(salesEx + salesTax);
  }

  // Uber prints deductions negative and credits positive. Stored as printed; the invoice
  // step turns them into costs. In the legacy layout each printed figure is inclusive and
  // is split here so the fields mean the same thing whatever the layout.
  function pair(incLabel, taxLabel) {
    var v = money(incLabel, false);
    if (!legacy) return [v, money(taxLabel, false)];
    var ex = ueRound_(v / 1.1);
    return [ex, ueRound_(v - ex)];
  }
  var mk = pair("Marketplace Fees", "Tax on Marketplace Fees");
  if (!mk[0] && !/Marketplace Fees/i.test(block)) throw new Error("no 'Marketplace Fees' in payout breakdown (" + subject + ")");
  var oc = pair("Other Charges", "Tax On Other Charges");
  var of = pair("Offers On Items", "Tax on offer spends");
  var ad = pair("Ad Spends", "Tax on Net Ad Spends");
  var cb = pair("Net Chargeback Amount", "Net Tax On Chargeback");

  var p = {
    store: store, address: address, from: from, to: to, legacy: legacy,
    orders: orders, salesEx: salesEx, salesTax: salesTax, grossInc: grossInc,
    mktFee: mk[0], mktFeeTax: mk[1],
    otherCharges: oc[0], otherChargesTax: oc[1],
    uberFeesTotal: money("Total Uber Fees", false) || money("Uber Fees", false),
    offers: of[0], offersTax: of[1],
    adSpend: ad[0], adSpendTax: ad[1],
    marketingTotal: money("Total Marketing Spends", false) || money("Marketing", false),
    chargeback: cb[0], chargebackOrders: count("Net Chargeback Amount") || 0, chargebackTax: cb[1],
    adjustments: money("Adjustments", false),
    amendmentsTotal: money("Total Amendments", false) || money("Amendments", false),
    netPayout: money("Net Payout", true)
  };
  return p;
}

/** Tags to spaces, entities decoded, whitespace collapsed. getBody() is HTML. */
function ueText_(html) {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ");
}

/** "Oct 19, 2026" -> "2026-10-19" */
function ueIso_(s) {
  var m = /([A-Za-z]{3})[a-z]*\s+(\d{1,2}),\s*(\d{4})/.exec(s);
  if (!m) throw new Error("bad date '" + s + "'");
  var mo = UE_MONTHS[m[1].toLowerCase()];
  if (!mo) throw new Error("bad month '" + m[1] + "'");
  return m[3] + "-" + ("0" + mo).slice(-2) + "-" + ("0" + m[2]).slice(-2);
}

function ueRound_(n) { return Math.round((Number(n) || 0) * 100) / 100; }

/* ---------------------------------------------------------------- invoice */

/** Parsed figures -> the object writeInvoice_ takes (same contract as the extractor). */
function ueInvoice_(p) {
  var rule = null;
  for (var i = 0; i < UE_VENUE_RULES.length && !rule; i++) {
    var r = UE_VENUE_RULES[i];
    if (r.name && r.name.test(p.store)) rule = r;
    else if (r.addr && r.addr.test(p.address)) rule = r;
  }
  var venue = rule ? rule.venue : CONFIG.DEFAULT_VENUE;
  var code = rule ? rule.code : "UNK";
  var checks = [];
  if (!rule) checks.push("venue not recognised from '" + p.store + " (" + p.address + ")'");

  // Costs are the negative of what Uber printed (a -$743.64 fee is a $743.64 cost; a
  // +$0.07 "Other Charges" is a 7c credit, so -0.07).
  var mktFee = ueRound_(-p.mktFee), mktFeeTax = ueRound_(-p.mktFeeTax);
  var other = ueRound_(-p.otherCharges), otherTax = ueRound_(-p.otherChargesTax);
  var ads = ueRound_(-p.adSpend), adsTax = ueRound_(-p.adSpendTax);
  var offers = ueRound_(-p.offers), offersTax = ueRound_(-p.offersTax);
  var cb = ueRound_(-p.chargeback), cbTax = ueRound_(-p.chargebackTax);
  var adj = ueRound_(-p.adjustments);

  var items = [];
  if (mktFee || p.orders) {
    var perOrder = p.orders ? Math.round(mktFee / p.orders * 10000) / 10000 : 0;
    var pct = p.salesEx ? Math.round(mktFee / p.salesEx * 1000) / 10 : 0;
    items.push(["Marketplace fees - " + p.orders + " orders" + (pct ? ", " + pct + "% of ex-GST sales" : "") + (p.legacy ? " (GST derived at 1/11 - old email layout)" : ""),
                p.orders, "order", perOrder, mktFee, "MKTFEE", 0]);
  }
  if (ads) items.push(["Ad spend", 1, "ea", ads, ads, "ADS", 0]);
  if (offers) items.push(["Offers on items", 1, "ea", offers, offers, "OFFERS", 0]);
  if (other) items.push(["Other charges", 1, "ea", other, other, "OTHER", 0]);
  if (cb) items.push(["Chargebacks - " + p.chargebackOrders + " order" + (p.chargebackOrders === 1 ? "" : "s") + " refunded to customers",
                      p.chargebackOrders || 1, "order", p.chargebackOrders ? Math.round(cb / p.chargebackOrders * 10000) / 10000 : cb, cb, "CHARGEBACK", 0]);
  if (adj) { items.push(["Adjustments", 1, "ea", adj, adj, "ADJ", 0]); checks.push("adjustment " + adj + " (no GST split printed)"); }
  // Info line: what the fees were charged on. $0 so it never counts as spend.
  items.push(["Uber Eats sales $" + p.grossInc.toFixed(2) + " inc GST - " + p.orders + " orders, " + p.from + " to " + p.to,
              p.orders, "order", 0, 0, "SALES", 0]);

  var subtotal = ueRound_(items.reduce(function (s, l) { return s + l[4]; }, 0));
  var gst = ueRound_(mktFeeTax + otherTax + adsTax + offersTax + cbTax);
  var total = ueRound_(subtotal + gst);

  // The identity the whole thing rests on: what Uber kept = gross - what it paid out.
  var kept = ueRound_(p.grossInc - p.netPayout);
  if (Math.abs(kept - total) > UE.TOL) checks.push("gross - net = " + kept.toFixed(2) + " but lines + gst = " + total.toFixed(2));
  // Printed section totals, when present.
  if (p.uberFeesTotal && Math.abs(-p.uberFeesTotal - (mktFee + mktFeeTax + other + otherTax)) > UE.TOL)
    checks.push("Uber Fees section " + (-p.uberFeesTotal).toFixed(2) + " != parts " + (mktFee + mktFeeTax + other + otherTax).toFixed(2));
  if (p.marketingTotal && Math.abs(-p.marketingTotal - (ads + adsTax + offers + offersTax)) > UE.TOL)
    checks.push("Marketing section " + (-p.marketingTotal).toFixed(2) + " != parts " + (ads + adsTax + offers + offersTax).toFixed(2));
  if (p.amendmentsTotal && Math.abs(-p.amendmentsTotal - (cb + cbTax + adj)) > UE.TOL)
    checks.push("Amendments section " + (-p.amendmentsTotal).toFixed(2) + " != parts " + (cb + cbTax + adj).toFixed(2));

  return {
    doc_type: "invoice",
    supplier: UE.SUPPLIER,
    invoice_number: "UBER-" + code + "-" + p.to.replace(/-/g, ""),
    invoice_date: p.to,
    subtotal: subtotal, gst: gst, freight: 0, total: total,
    items: items,
    category_override: UE.CATEGORY,
    venue_override: venue,
    deliver_to: p.store + ", " + p.address,
    force_check: checks.length > 0,
    ue_checks: checks,
    ue_store: p.store
  };
}

function ueSummary_(p, j) {
  return j.invoice_number + " " + j.venue_override + " " + p.from + ".." + p.to +
    ": gross " + p.grossInc.toFixed(2) + ", net payout " + p.netPayout.toFixed(2) +
    ", kept " + j.total.toFixed(2) + " (ex " + j.subtotal.toFixed(2) + " + gst " + j.gst.toFixed(2) + ")" +
    (j.ue_checks.length ? " CHECK: " + j.ue_checks.join("; ") : "");
}
