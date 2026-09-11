/**
 * Statements.gs — captures supplier monthly statements into a Statements tab.
 *
 * Goes in the SAME Apps Script project as Code.gs ("Invoice Processor", bound to BG Ops
 * Data). Add it as a new file; nothing in Code.gs needs changing.
 *
 * Why it exists: the extraction prompt in Code.gs deliberately throws statements away
 * ("Statements must always be skipped - never extract them as invoices"). That is right for
 * the Invoices tab, but it means the supplier's own closing balance and due date - the figure
 * that actually gets paid - never reach the system. The payables dashboard was left summing
 * the invoices we happened to receive, which is not the same number.
 *
 * Deliberately standalone rather than a hook inside processAttachments_:
 *   - it cannot break invoice ingestion, which is the more important pipeline
 *   - it can be deleted or disabled on its own
 * The cost is that a statement email gets read twice - once by the invoice lanes, which skip
 * it, and once here. If Gmail or API quota ever bites, the cheaper arrangement is to call
 * stmtCaptureAttachment_ from the `result.not_invoice` branch of processAttachments_ instead
 * and drop the trigger below.
 *
 * Setup:
 *   1. Paste as a new file called Statements.
 *   2. Run stmtSetup() once. Creates the Statements and ProcessedStatements tabs and reports
 *      whether the API key is present. Authorise when asked.
 *   3. Add a time trigger on processStatementsLocked - daily is plenty; statements arrive
 *      once a month per supplier.
 *
 * Reads ANTHROPIC_API_KEY from Script Properties, the same one Code.gs uses.
 */

var STMT = {
  SHEET: "Statements",
  LOG_SHEET: "ProcessedStatements",
  /* Narrow on purpose. A wide query re-pages recent mail and exhausts the shared Gmail quota
     without ever reaching older messages - the same trap the invoice backfill hit. */
  QUERY: '(label:supplier-invoices OR deliveredto:accounts@redsquarecafe.com.au OR to:accounts@redsquarecafe.com.au) (subject:statement OR subject:"account statement" OR subject:"statement of account") newer_than:21d',
  MAX_EMAILS_PER_RUN: 10,
  MAX_LINES: 400,
  DRIVE_FOLDER: "Statement PDFs",
  MAX_ATTACHMENT_BYTES: 20 * 1024 * 1024,
  /* opening_balance and payments are what make a statement reconcilable. Without them a
     shortfall against our invoices is ambiguous: it could be an invoice we never received, or
     a balance carried over from last month. Five of the first nine statements needed exactly
     that distinction. The identity is:
         opening_balance + charges in period - payments = total (closing)
     so charges = total - opening_balance + payments, and THAT is the figure to compare with
     the sum of our invoices for the period. */
  /* New columns are APPENDED, never inserted, so earlier captures keep their values under the
     right labels and the tab migrates in place. Readers look columns up by name, so sheet order
     is presentation only.

     period_start/period_end are retained but are now derived from the line items rather than
     read off the document: none of the eight real statements state a period. opening_balance,
     payments and charges are likewise derived from the lines - opening_balance is a BROUGHT
     FWD line (only Manna prints one), payments is the total of any payment lines, and charges
     is the sum of invoice lines. The identity opening + charges - payments = total is now a
     CHECK on the extraction rather than something the model is asked to read. */
  HEADER: ["scanned", "supplier", "statement_number", "statement_date", "period_start", "period_end",
           "due_date", "total", "invoice_count", "status", "source", "pdf_url", "message_id",
           "opening_balance", "payments", "charges", "account", "line_count", "statement_id"],
  LINES_SHEET: "StatementLines",
  /* One row per line on the statement. This is the point of the whole exercise: comparing
     their reference numbers against ours names the missing invoice (SAV62449) instead of
     just reporting an unexplained shortfall. */
  LINES_HEADER: ["statement_id", "supplier", "statement_date", "line_date", "reference", "description",
                 "amount", "due_date", "kind", "account"],
  LOG_HEADER: ["scanned", "message_id", "subject", "from", "status", "notes"],
  VERSION: "statements-101040"
};

/* Written against the eight statements actually received in Aug-Sep 2026 (Bidfood, Asahi,
   Veolia, Freshline, Scottsdale, Savour, Onepac, Manna, BDD). Every one is an OPEN ITEM LIST:
   a row per unpaid invoice with a running balance, ending in a total. None states a period,
   and only Manna prints a brought-forward line. Earlier versions of this file asked for a
   period and an opening balance because I assumed a monthly-activity statement; that was
   wrong twice, so the prompt below describes the document these suppliers actually send. */
var STMT_PROMPT = [
  'This document may be a supplier STATEMENT OF ACCOUNT: a list of outstanding invoices with a',
  'total owing. It might instead be a single invoice, a credit note, or something else.',
  '',
  'If it is NOT a statement of account, respond with exactly: {"not_statement": true, "reason": "brief reason"}',
  '',
  'If it IS a statement, respond with ONLY this JSON and nothing else:',
  '{"supplier": "string", "statement_number": "string or empty", "statement_date": "YYYY-MM-DD",',
  ' "account": "string or empty", "due_date": "YYYY-MM-DD or empty", "total": number,',
  ' "lines": [{"date": "YYYY-MM-DD", "reference": "string", "description": "string or empty",',
  '            "amount": number, "due_date": "YYYY-MM-DD or empty", "kind": "invoice",',
  '            "account": "string or empty"}]}',
  '',
  'supplier: the company issuing the statement, not the recipient. Full legal name as printed.',
  'total: the closing balance owing - printed as "Total Balance", "Balance Due", "Amount Due",',
  '  "TOTAL OWING" or the last figure in the running balance column. A number only.',
  'account: the customer account number or code the supplier uses for us, if printed',
  '  (e.g. "303505", "RSQC - F", "Account #: 320").',
  'due_date: only a single due date printed for the WHOLE statement. If each line has its own',
  '  due date, leave this empty and put them on the lines.',
  '',
  'lines: EVERY row in the table of transactions, in the order printed. This is the most',
  '  important part - do not summarise, do not omit rows, do not merge rows.',
  '  date: the transaction date of that row.',
  '  reference: the invoice or document number exactly as printed, e.g. "SAV62449",',
  '    "INV297970", "F57513956", "S376830", "I70770274.HOB". Keep any letters and dots.',
  '  amount: that row\'s value. Use a NEGATIVE number for credits and payments. Ignore any',
  '    running "balance" column - we want the row\'s own amount, not the cumulative figure.',
  '  due_date: that row\'s own due date if the table has a due-date column.',
  '  kind: one of "invoice", "credit", "payment", "brought_forward", "other".',
  '    Use "brought_forward" for an opening line such as "BROUGHT FWD" that carries an earlier',
  '    balance rather than being a document. Use "credit" for credit notes or credit memos.',
  '  account: if the statement is split into sections per site or account (some suppliers',
  '    subtotal separately for each venue), the section this row belongs to. Otherwise empty.',
  '  Do NOT include subtotal, section-total, GST-total or ageing-summary rows as lines.',
  '',
  'All dates as YYYY-MM-DD. Australian format day/month/year on the source document.',
  'Respond with raw JSON only - no markdown fences, no commentary.'
].join("\n");

/* ---------- entry points ---------- */

function stmtSetup() {
  var s = stmtSheets_();
  var key = PropertiesService.getScriptProperties().getProperty("ANTHROPIC_API_KEY");
  Logger.log("Tabs ready: " + STMT.SHEET + ", " + STMT.LOG_SHEET
    + ". API key " + (key ? "found." : "MISSING - set ANTHROPIC_API_KEY in Script Properties.")
    + " Statements so far: " + Math.max(0, s.stmt.getLastRow() - 1));
}

function processStatementsLocked() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) { Logger.log("Another statement run is in progress; skipping."); return; }
  try { processStatements(); } finally { lock.releaseLock(); }
}

function processStatements() {
  var apiKey = PropertiesService.getScriptProperties().getProperty("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("Set ANTHROPIC_API_KEY in Project Settings > Script Properties first.");

  var sheets = stmtSheets_();
  var seenIds = stmtProcessedIds_(sheets.log);
  var existing = stmtExistingKeys_(sheets.stmt);
  var added = 0, scanned = 0;

  var threads = GmailApp.search(STMT.QUERY, 0, STMT.MAX_EMAILS_PER_RUN);
  threads.forEach(function (thread) {
    thread.getMessages().forEach(function (msg) {
      var id = msg.getId();
      if (seenIds[id]) return;
      scanned++;
      var notes = [];
      var status = "SKIPPED";
      try {
        var got = stmtCaptureMessage_(apiKey, msg, sheets, existing, notes);
        if (got) { added += got; status = "OK"; }
      } catch (e) {
        status = "FAILED";
        notes.push(String(e && e.message ? e.message : e));
      }
      stmtLog_(sheets.log, msg, status, notes.join(" | "));
      seenIds[id] = true;
    });
  });
  Logger.log(STMT.VERSION + ": scanned " + scanned + " messages, wrote " + added + " statements.");
  return { scanned: scanned, added: added };
}

/* One-click version of the two-step migration, for running from the editor dropdown:
   re-reads every statement so the fields added in this version get populated. */
function stmtRerunAll() {
  var r = stmtRerun();
  var p = processStatements();
  Logger.log("Re-read " + p.added + " of " + r.superseded + " statements.");
  return p;
}

/* ---------- capture ---------- */

function stmtCaptureMessage_(apiKey, msg, sheets, existing, notes) {
  var atts = msg.getAttachments();
  var added = 0;
  for (var i = 0; i < atts.length; i++) {
    var att = atts[i];
    if (!stmtIsPdf_(att)) continue;
    if (att.getSize() > STMT.MAX_ATTACHMENT_BYTES) { notes.push(att.getName() + ": too large, skipped"); continue; }
    added += stmtCaptureAttachment_(apiKey, att, msg, sheets, existing, notes) ? 1 : 0;
  }
  if (!atts.length) notes.push("no attachments");
  return added;
}

/* Also usable from Code.gs: in the `result.not_invoice` branch of processAttachments_, call
   stmtCaptureAttachment_(apiKey, att, msg, stmtSheets_(), stmtExistingKeys_(...), notes). */
function stmtCaptureAttachment_(apiKey, att, msg, sheets, existing, notes) {
  var j;
  try {
    j = stmtExtract_(apiKey, att, msg);
  } catch (e) {
    /* Name the attachment, or a failure in a multi-PDF email is untraceable. */
    throw new Error(att.getName() + " (" + Math.round(att.getSize() / 1024) + "KB): "
      + (e && e.message ? e.message : e));
  }
  if (!j || j.not_statement) { notes.push(att.getName() + ": not a statement (" + ((j && j.reason) || "?") + ")"); return false; }

  var row = stmtNormalise_(j, msg, notes);
  if (!row.supplier) { notes.push(att.getName() + ": no supplier name, skipped"); return false; }

  var key = stmtKey_(row);
  if (existing[key]) { notes.push(att.getName() + ": duplicate statement " + row.supplier + " " + row.statement_date + ", skipped"); return false; }
  existing[key] = true;

  /* Ties the line rows to their statement. A rerun creates a new id, so superseded lines stay
     attached to the superseded header rather than being deleted. */
  row.statement_id = stmtNorm_(row.supplier).slice(0, 14) + "-" + row.statement_date + "-"
    + Utilities.getUuid().slice(0, 8);
  var pdfUrl = stmtSavePdf_(att, row);
  stmtWrite_(sheets, row, msg, pdfUrl);
  notes.push(att.getName() + ": added " + row.supplier + " " + row.statement_date + " " + row.total
    + " (" + row.line_count + " lines)");
  return true;
}

function stmtExtract_(apiKey, att, msg) {
  var b64 = Utilities.base64Encode(att.getBytes());
  var payload = {
    model: stmtModelFor_(msg),
    max_tokens: 16000,
    messages: [{
      role: "user",
      content: [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } },
        { type: "text", text: STMT_PROMPT }
      ]
    }]
  };
  var resp = UrlFetchApp.fetch("https://api.anthropic.com/v1/messages", {
    method: "post",
    contentType: "application/json",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  var code = resp.getResponseCode();
  var text = resp.getContentText();
  if (code !== 200) throw new Error("API " + code + ": " + String(text).slice(0, 300));
  var body = JSON.parse(text);
  var out = "";
  (body.content || []).forEach(function (b) { if (b.type === "text") out += b.text; });
  return stmtParseJson_(out);
}

/* Models are picked the same way Code.gs does it, so a supplier whose PDFs are known to be
   awkward gets the better model here too. */
function stmtModelFor_(msg) {
  var C = (typeof CONFIG !== "undefined") ? CONFIG : {};
  var from = String(msg.getFrom() || "").toLowerCase();
  var premium = C.PREMIUM_SENDERS || [];
  for (var i = 0; i < premium.length; i++) {
    if (from.indexOf(String(premium[i]).toLowerCase()) !== -1) return C.PREMIUM_MODEL || "claude-sonnet-4-6";
  }
  return C.MODEL || "claude-haiku-4-5";
}

/* Models sometimes wrap JSON in prose or fences despite instructions. Take the outermost
   braces rather than trusting the whole string to parse. */
function stmtParseJson_(s) {
  var t = String(s || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try { return JSON.parse(t); } catch (e) { }
  var a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a === -1 || b <= a) throw new Error("model did not return JSON: " + t.slice(0, 200));
  return JSON.parse(t.slice(a, b + 1));
}

/* ---------- shaping ---------- */

function stmtNormalise_(j, msg, notes) {
  var row = {
    supplier: stmtStr_(j.supplier, 120),
    statement_number: stmtStr_(j.statement_number, 60),
    statement_date: stmtDate_(j.statement_date),
    account: stmtStr_(j.account, 60),
    due_date: stmtDate_(j.due_date),
    total: stmtNum_(j.total),
    status: "OK"
  };
  if (!row.statement_date) {
    row.statement_date = stmtISO_(msg.getDate());
    row.status = "CHECK"; notes.push("no statement date on document, used email date");
  }

  /* Lines are the point of this file. A statement whose lines did not come through is worth
     far less than one that did, so it is flagged rather than quietly stored as a bare total. */
  var raw = Array.isArray(j.lines) ? j.lines : [];
  if (raw.length > STMT.MAX_LINES) {
    notes.push("statement had " + raw.length + " lines, kept the first " + STMT.MAX_LINES);
    raw = raw.slice(0, STMT.MAX_LINES);
    row.status = "CHECK";
  }
  var KINDS = { invoice: 1, credit: 1, payment: 1, brought_forward: 1, other: 1 };
  row.lines = raw.map(function (L) {
    var kind = String(L && L.kind || "invoice").toLowerCase().replace(/[\s-]/g, "_");
    if (!KINDS[kind]) kind = "other";
    var amt = stmtNum_(L && L.amount);
    /* Credits and payments reduce the balance. Suppliers print them inconsistently - some
       with a minus, some in a separate Credit column - so the sign is forced from the kind
       rather than trusted, the same way credit notes are handled on the Invoices tab. */
    if (kind === "credit" || kind === "payment") amt = -Math.abs(amt);
    return {
      line_date: stmtDate_(L && L.date),
      reference: stmtStr_(L && L.reference, 60),
      description: stmtStr_(L && L.description, 200),
      amount: amt,
      due_date: stmtDate_(L && L.due_date),
      kind: kind,
      account: stmtStr_(L && L.account, 60) || row.account
    };
  });
  if (!row.lines.length) { row.status = "CHECK"; notes.push("no line items extracted"); }

  var sum = 0, opening = 0, payments = 0, charges = 0, invoiceLines = 0;
  var minD = "", maxD = "";
  row.lines.forEach(function (L) {
    sum += L.amount;
    if (L.kind === "brought_forward") opening += L.amount;
    else if (L.kind === "payment") payments += -L.amount;
    else { charges += L.amount; if (L.kind === "invoice") invoiceLines++; }
    if (L.line_date) {
      if (!minD || L.line_date < minD) minD = L.line_date;
      if (!maxD || L.line_date > maxD) maxD = L.line_date;
    }
  });
  row.opening_balance = +opening.toFixed(2);
  row.payments = +payments.toFixed(2);
  row.charges = +charges.toFixed(2);
  row.invoice_count = invoiceLines;
  row.line_count = row.lines.length;
  /* Derived, not read: none of these statements print a period. Kept because the payables
     view needs to know which span of our invoices to compare against. */
  row.period_start = minD;
  row.period_end = maxD || row.statement_date;

  if (!row.total) {
    /* Some layouts show only a running balance column with no labelled total. The lines
       still add up to it. */
    if (row.lines.length) {
      row.total = +sum.toFixed(2);
      notes.push("no total printed, used the sum of lines (" + row.total + ")");
    } else {
      row.status = "CHECK"; notes.push("no closing total read");
    }
  } else if (row.lines.length && Math.abs(sum - row.total) > 0.02) {
    /* The strongest signal available that a line was dropped or misread. */
    row.status = "CHECK";
    notes.push("lines sum to " + sum.toFixed(2) + " but the statement total is "
      + row.total.toFixed(2) + " (out by " + (row.total - sum).toFixed(2) + ")");
  }
  if (row.due_date && row.due_date < row.statement_date) {
    notes.push("statement due date " + row.due_date + " precedes the statement date, dropped");
    row.due_date = ""; row.status = "CHECK";
  }
  return row;
}

function stmtKey_(row) { return stmtNorm_(row.supplier) + "|" + row.statement_date; }

function stmtWrite_(sheets, row, msg, pdfUrl) {
  var sid = row.statement_id;
  var values = [new Date().toISOString(), row.supplier, row.statement_number, row.statement_date,
                row.period_start, row.period_end, row.due_date, row.total.toFixed(2),
                String(row.invoice_count), row.status, String(msg.getFrom() || ""), pdfUrl, msg.getId(),
                row.opening_balance.toFixed(2), row.payments.toFixed(2), row.charges.toFixed(2),
                row.account, String(row.line_count), sid];
  stmtAppend_(sheets.stmt, [values]);
  if (row.lines.length) {
    stmtAppend_(sheets.lines, row.lines.map(function (L) {
      return [sid, row.supplier, row.statement_date, L.line_date, L.reference, L.description,
              L.amount.toFixed(2), L.due_date, L.kind, L.account];
    }));
  }
}

/* Written in one setValues call rather than a loop: a 69-line statement would otherwise be 69
   round trips to the sheet. */
function stmtAppend_(sh, rows) {
  if (!rows.length) return;
  var r = sh.getLastRow() + 1;
  var rng = sh.getRange(r, 1, rows.length, rows[0].length);
  rng.setNumberFormat("@");        // dates and amounts must survive gviz as written
  rng.setValues(rows);
}

function stmtSavePdf_(att, row) {
  var C = (typeof CONFIG !== "undefined") ? CONFIG : {};
  if (C.SAVE_PDFS === false) return "";
  try {
    var it = DriveApp.getFoldersByName(STMT.DRIVE_FOLDER);
    var folder = it.hasNext() ? it.next() : DriveApp.createFolder(STMT.DRIVE_FOLDER);
    var name = [row.statement_date || "nodate", row.supplier || "unknown", "statement"]
      .join(" - ").replace(/[\/\\:*?"<>|]/g, "-") + ".pdf";
    return folder.createFile(att.copyBlob().setName(name)).getUrl();
  } catch (e) {
    return "";
  }
}

/* ---------- sheets ---------- */

function stmtSheets_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  return { stmt: stmtTab_(ss, STMT.SHEET, STMT.HEADER),
           lines: stmtTab_(ss, STMT.LINES_SHEET, STMT.LINES_HEADER),
           log: stmtTab_(ss, STMT.LOG_SHEET, STMT.LOG_HEADER) };
}

function stmtTab_(ss, name, header) {
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, sh.getMaxRows(), Math.max(header.length, sh.getMaxColumns())).setNumberFormat("@");
    sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight("bold");
    sh.setFrozenRows(1);
    return sh;
  }
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight("bold");
    return sh;
  }
  /* The tab may predate a column being added. Rewriting the header row silently would put
     old values under new labels, so only ever REBUILD when the existing header is still a
     prefix of the current one - i.e. columns were appended, never reordered or renamed. */
  var wide = Math.max(sh.getLastColumn(), header.length);
  var cur = sh.getRange(1, 1, 1, wide).getValues()[0].map(function (v) { return String(v || "").trim(); });
  var same = true;
  for (var i = 0; i < cur.length && i < header.length; i++) {
    if (cur[i] && cur[i] !== header[i]) { same = false; break; }
  }
  if (!same) {
    throw new Error("'" + name + "' has an unexpected header (" + cur.join(",") + "). "
      + "Rename or clear the tab rather than letting this overwrite it.");
  }
  if (cur.slice(0, header.length).join("|") !== header.join("|")) {
    sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight("bold");
  }
  return sh;
}

function stmtProcessedIds_(log) {
  var out = {};
  var n = log.getLastRow();
  if (n < 2) return out;
  log.getRange(2, 2, n - 1, 1).getValues().forEach(function (r) { if (r[0]) out[String(r[0])] = true; });
  return out;
}

/* Column positions are read from the header rather than hard-coded, so adding a column does
   not silently shift what dedupe compares. Superseded rows are ignored, which is what lets
   stmtRerun re-read a statement that was captured before a field existed. */
function stmtCol_(sh, name) {
  var hdr = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0];
  for (var i = 0; i < hdr.length; i++) if (String(hdr[i]).trim() === name) return i + 1;
  return -1;
}

function stmtExistingKeys_(sh) {
  var out = {};
  var n = sh.getLastRow();
  if (n < 2) return out;
  var w = Math.max(sh.getLastColumn(), STMT.HEADER.length);
  var vals = sh.getRange(2, 1, n - 1, w).getValues();
  var cSup = stmtCol_(sh, "supplier") - 1, cDate = stmtCol_(sh, "statement_date") - 1, cSt = stmtCol_(sh, "status") - 1;
  vals.forEach(function (r) {
    if (!r[cSup]) return;
    if (cSt > -1 && String(r[cSt]) === "SUPERSEDED") return;
    out[stmtNorm_(r[cSup]) + "|" + String(r[cDate])] = true;
  });
  return out;
}

/**
 * Re-read statements dated on or after sinceISO, e.g. stmtRerun("2026-08-01").
 *
 * Needed when a field is added: the nine statements captured before opening_balance existed
 * cannot be improved by a normal run, because both the message log and the supplier+date key
 * would skip them. This marks the old rows SUPERSEDED rather than deleting them (the invoice
 * processor uses the same convention) and clears their message ids from the log so the next
 * run re-reads those emails. The old rows stay on the sheet as history.
 *
 * This is the only function here that edits existing cells. It does not delete rows.
 */
function stmtRerun(sinceISO) {
  /* Runnable straight from the editor dropdown, which cannot pass arguments: with no date it
     re-reads every statement on the sheet. That is safe - nothing is deleted, and the cost is
     one API call per statement. A malformed date is still rejected, since "2026-8-1" or
     "01/08/2026" would compare wrongly against the yyyy-mm-dd values in the column. */
  if (sinceISO === undefined || sinceISO === null || sinceISO === "") sinceISO = "0000-01-01";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(sinceISO))) {
    throw new Error("pass a date like \"2026-08-01\", or no argument to re-read every statement");
  }
  var sheets = stmtSheets_();
  var sh = sheets.stmt, log = sheets.log;
  var n = sh.getLastRow();
  if (n < 2) { Logger.log("No statements to re-read."); return; }
  var cDate = stmtCol_(sh, "statement_date"), cStatus = stmtCol_(sh, "status"), cMsg = stmtCol_(sh, "message_id");
  var vals = sh.getRange(2, 1, n - 1, sh.getLastColumn()).getValues();
  var ids = {}, marked = 0;
  for (var i = 0; i < vals.length; i++) {
    var row = vals[i];
    if (String(row[cStatus - 1]) === "SUPERSEDED") continue;
    if (String(row[cDate - 1]) < sinceISO) continue;
    sh.getRange(i + 2, cStatus, 1, 1).setValue("SUPERSEDED");
    if (cMsg > -1 && row[cMsg - 1]) ids[String(row[cMsg - 1])] = true;
    marked++;
  }
  var ln = log.getLastRow(), cleared = 0;
  if (ln > 1) {
    var lv = log.getRange(2, 2, ln - 1, 1).getValues();
    for (var k = 0; k < lv.length; k++) {
      if (lv[k][0] && ids[String(lv[k][0])]) { log.getRange(k + 2, 2, 1, 1).setValue(""); cleared++; }
    }
  }
  Logger.log("Superseded " + marked + " statements dated on or after "
    + (sinceISO === "0000-01-01" ? "the beginning" : sinceISO)
    + ", cleared " + cleared + " log entries. Run processStatements() now to re-read them.");
  return { superseded: marked, cleared: cleared };
}

function stmtLog_(log, msg, status, notes) {
  var values = [new Date().toISOString(), msg.getId(), String(msg.getSubject() || "").slice(0, 200),
                String(msg.getFrom() || ""), status, String(notes || "").slice(0, 500)];
  var r = log.getLastRow() + 1;
  var rng = log.getRange(r, 1, 1, values.length);
  rng.setNumberFormat("@");
  rng.setValues([values]);
}

/* ---------- small helpers ---------- */

function stmtIsPdf_(att) {
  return /pdf/i.test(att.getContentType() || "") || /\.pdf$/i.test(att.getName() || "");
}
function stmtStr_(v, max) { return String(v == null ? "" : v).replace(/[\r\n\t]+/g, " ").trim().slice(0, max || 200); }
function stmtNum_(v) { var n = Number(String(v == null ? "" : v).replace(/[^0-9.\-]/g, "")); return isFinite(n) ? n : 0; }
function stmtNorm_(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }
function stmtISO_(d) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
function stmtParseISO_(s) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ""));
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
}
/* Accepts what the model was told to send, plus dd/mm/yyyy in case it ignores the instruction.
   Anything else is rejected rather than guessed at - a wrong statement date silently matches
   the wrong month's invoices. */
function stmtDate_(v) {
  var s = String(v == null ? "" : v).trim();
  if (!s) return "";
  var m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return m[1] + "-" + String(+m[2]).padStart(2, "0") + "-" + String(+m[3]).padStart(2, "0");
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m && +m[1] <= 31 && +m[2] <= 12) return m[3] + "-" + String(+m[2]).padStart(2, "0") + "-" + String(+m[1]).padStart(2, "0");
  return "";
}
