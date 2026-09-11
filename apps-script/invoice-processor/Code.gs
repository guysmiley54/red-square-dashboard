/**
 * INVOICE EMAIL PROCESSOR — B & G Fitness Pty Ltd  (label-free version)
 * Searches Gmail for supplier invoices, extracts data with Claude, writes to this spreadsheet.
 * Archives each invoice PDF to Drive ("Invoice PDFs" folder) and links it in the sheet.
 * Also handles body-only invoices (suppliers who send HTML emails with no PDF) via BODY_QUERY.
 *
 * Bound to the BG Ops Data spreadsheet. Note that the Sales Feed project has its own file
 * ALSO called Code.gs — Apps Script names the main file Code.gs in every project — so
 * always say which project a Code.gs belongs to. A handover once concluded this processor
 * "is not Code.gs" on the strength of that name alone and stopped looking.
 *
 * FUNCTIONS (pick in the toolbar dropdown, then Run):
 *   processInvoicesLocked  — RUN THIS (and point the hourly trigger at it). Lock-guarded
 *                            wrapper around processInvoices that prevents duplicate races.
 *   processInvoices        — the core job (called by processInvoicesLocked)
 *   dedupeInvoices         — one-off: remove existing exact-duplicate invoices
 *   backfillPdfs           — one-off: archive PDFs for rows processed before Drive archiving
 *   fixInvoiceNumberText   — one-off: convert invoice-number columns to text
 *
 * OVERHEADS: mail from energy, waste, rent and repairs suppliers is routed through
 * Overheads.gs (profiles, multi-site split, EnergyUsage). Its audit and reprocess entry
 * points are listed at the top of that file.
 *
 * RETRY a failed email: delete its row from the ProcessedEmails tab.
 */

var CONFIG = {
  // Lane 1: anything with a PDF attached, to accounts@ or labelled Supplier Invoices
  // Shell Energy and Scooter's Electrical bill adrian@/abeckitt@ without the label, so
  // before 11 Sep 2026 neither ever reached this query. Keep this list in step with the
  // senders in OH_PROFILES (Overheads.gs). Supagas is labelled already, and its pod@
  // dockets must NOT be added - they carry litres that reappear on the statement.
  SEARCH_QUERY: '(deliveredto:accounts@redsquarecafe.com.au OR to:accounts@redsquarecafe.com.au OR label:supplier-invoices OR from:(shellenergy.com.au OR scootz.cresswell@gmail.com)) filename:pdf newer_than:14d',
  // Lane 2: invoices that arrive as the EMAIL BODY with no PDF attached.
  // Matched three ways, so a missing label can't hide an invoice:
  //   1. label:supplier-invoices                — anything you file by hand
  //   2. from:(...)                             — known body-only senders
  //   3. deliveredto/to:accounts@               — anything else that lands in accounts@
  // NOTE on Southern Foodservice: their "Thank you for order XXXXXX" confirmations are
  // NOT sent from southernfood.com.au. They come from their ordering platform, Pepper,
  // as hello-aus+<random>@messages.usepepper.com — a DIFFERENT random address every
  // time — so only the domain can be matched, never a fixed address. Before this was
  // added, those orders only got in if they happened to carry the supplier-invoices
  // label, and any that weren't labelled were silently missed.
  // The -filename:pdf guard keeps lane 2 off anything lane 1 already handles.
  BODY_QUERY: '(label:supplier-invoices OR from:(southernfood.com.au OR usepepper.com) OR deliveredto:accounts@redsquarecafe.com.au OR to:accounts@redsquarecafe.com.au) -filename:pdf newer_than:14d',
  // Senders whose body-only emails are ALWAYS invoices. These bypass the lane 2
  // pre-filter entirely, so a wording change on their template can never cause a miss.
  // Match is a substring of the sender, so a bare domain covers every address under it.
  BODY_SENDERS: ["southernfood.com.au", "usepepper.com"],
  // Each lane gets its own MAX_EMAILS_PER_RUN budget (so the PDF backlog can't starve lane 2).
  // Cruising config (restore after backfill): change both after:2026/06/01 to newer_than:14d
  // and MAX_EMAILS_PER_RUN to 10.
  MODEL: "claude-haiku-4-5",         // default: cheap + fast, fine for most suppliers
  // Suppliers whose invoice LAYOUTS trip the cheap model get the stronger model instead.
  // Match is on the sender's email/domain. Add a domain here to upgrade that supplier.
  PREMIUM_MODEL: "claude-sonnet-4-6",
  PREMIUM_SENDERS: ["pdfoods.com.au", "bega.com.au"],  // PFD, BDD — worst CHECK rates
    MAX_EMAILS_PER_RUN: 10,       // per lane; restore to 10 for hourly cruising
  VENUES: {
    "luma": "Luma Kitchen",
    "glenorchy": "Red Square Glenorchy",
    "howrad": "Red Square Glenorchy",
    "goodwood": "Red Square Glenorchy",
    "cambridge": "Red Square Cambridge",
    "kennedy": "Red Square Cambridge"
  },
  DEFAULT_VENUE: "Red Square Glenorchy",
  SAVE_PDFS: true,
  DRIVE_FOLDER: "Invoice PDFs",
  // Email address to notify if any invoice FAILS in a run (leave "" to disable).
  ALERT_EMAIL: "accounts@redsquarecafe.com.au",
  // A message that has already FAILED this many times is left alone instead of being
  // retried. Deleting its ProcessedEmails rows resets the count and forces a fresh try.
  MAX_ATTEMPTS: 2
};

var EXTRACT_PROMPT = [
  "You are reading a supplier invoice for a hospitality business in Tasmania, Australia.",
  "",
  "Extract the invoice data and respond with ONLY minified JSON on a single line - no markdown fences, no explanation, no line breaks. Use this exact structure:",
  "",
  '{"doc_type":"invoice or credit_note","supplier":"string","invoice_number":"string","invoice_date":"YYYY-MM-DD","subtotal":number,"gst":number,"total":number,"freight":number,"cdl":number,"deliver_to":"string or null","order_ref":"string or null","category_guess":"Food|Beverage|Coffee|Packaging|Cleaning|Equipment|Other","items":[["description",qty,"unit",unit_price,line_total,"item_code or null",line_cdl]]}',
  "",
  "Each item is a 7-element array: [description, qty, unit, unit_price, line_total, item_code, line_cdl]. item_code is the supplier's product/SKU code from the invoice line (e.g. \"018050\", \"LAC-MOZ-MLSK\") - null if the invoice doesn't show codes. line_cdl is that line's container deposit amount - 0 if the invoice has no per-line deposit column.",
  "",
  "CRITICAL: output the JSON object and NOTHING else. Do not explain, do not show working, do not add up columns in your reply, do not write any text before or after the JSON. Any arithmetic you need is done by the system from the per-line values you report - just transcribe what is printed on each line.",
  "",
  'doc_type: use "credit_note" if the document is a credit note / adjustment note / credit adjustment (returned or credited goods); otherwise "invoice". For credit notes, report all amounts as POSITIVE numbers as printed - the system applies the sign. Use the credit note number as invoice_number.',
  "",
  'order_ref: the CUSTOMER order number / order reference printed on the invoice, if it shows one. Southern Foodservice tax invoices print the Pepper order code (6 alphanumeric characters, e.g. RXUUDE, 6WCGX5), usually labelled Order, Order No, Customer Order or Your Order. This is NOT the invoice number and NOT a delivery docket number. Return null if no such reference appears.',
  "",
  "Rules:",
  "- Amounts in dollars as plain numbers (no $ signs, no strings, no thousands separators).",
  "- Keep descriptions short - trim pack-size codes if the item name is still clear.",
  '- "freight" = delivery, freight and fuel-levy charges only, 0 if none. Do NOT include these in items.',
  '- "cdl" = container deposit levy (CDL/CDS) TOTAL for the invoice, 0 if none. If the invoice shows a per-line container deposit column, do NOT add it up yourself and do NOT include it in the line totals: use the ex-CDL line totals for items, put each line\'s own deposit in the 7th slot of that item, and set "cdl" to the invoice\'s printed CDL total if one is shown, otherwise 0. The system adds up the per-line values.',
  "- If GST is not itemised: basic foods (eggs, milk, fresh produce, plain bread, raw meat) are GST-free in Australia, so use 0 for those; otherwise calculate gst as total/11 rounded to 2dp.",
  "- If a field is genuinely not on the invoice, use null. If the document shows an order/reference code but no invoice number, use that code as invoice_number.",
  "- Dates: Australian invoices use DD/MM/YYYY - convert to YYYY-MM-DD. If the year is shown as 2 digits (e.g. 26/07/26), the year is 2026 - do NOT read the day as the year. The invoice year is almost always the current year or the one just before; if your converted year is more than 2 years in the past (e.g. 2021, 2019, 2015), you have mis-read it - it should be the current year. If your converted date lands in the future by more than a week AND both day and month are 12 or less, you probably swapped day and month - swap them back. An order/delivery confirmation can legitimately show a near-future delivery date - keep those. Never output a null date if any date is visible.",
  "- line_total must be the amount ACTUALLY CHARGED for that line - the column whose values sum to the subtotal. Wholesaler invoices (e.g. liquor warehouses) often also show informational per-case prices or RRP columns alongside; ignore any cost column that does not sum to the subtotal.",
  "- Composite quantities: some wholesalers write qty as cases.units (e.g. '.1' = 0 cases + 1 single unit, '2.3' = 2 cases + 3 units). Report the real quantity delivered: a single-unit line is qty 1 with unit 'ea' (or 'btl'), and unit_price = line_total / qty.",
  "- Include EVERY product line item. items totals + freight should equal the subtotal (small rounding rows can be ignored).",
  "- A delivery confirmation WITH line items, quantities and amounts from a supplier counts as an invoice - extract it.",
  // A remittance advice is the single most dangerous look-alike in this inbox: it carries a
  // supplier name, a document number, a date, a list of amounts and a total, so every
  // content-based test reads it as an invoice. Five were booked as bills before this rule
  // existed, worth $23,254.12. The distinguishing feature is WHAT THE LINES ARE — other
  // invoice numbers being settled, not goods with quantities and unit prices.
  '- A REMITTANCE ADVICE is NOT an invoice and must never be extracted as one. It is a notice that a payment HAS ALREADY BEEN MADE, and may be titled Remittance Advice, Payment Advice, EFT Advice, Creditor Transfer, Payment Notification or similar. Tell it apart by its line items: a remittance lists OTHER INVOICE NUMBERS being paid off, with amounts paid and often a payment or EFT date, rather than goods or services with quantities and unit prices. It frequently says "Amount Paid", "Payment Total", "Remittance Total" or "This is not a tax invoice". Respond with exactly: {"not_invoice":true,"reason":"remittance advice"}. This applies even when the document otherwise looks complete, with a supplier name, a document number, a date and a total - a remittance always has all of those, and having them is not evidence that it is a bill.',
  "- If the document is NOT an invoice, credit note, or priced delivery confirmation (e.g. a monthly STATEMENT listing multiple invoices, a REMITTANCE ADVICE, marketing, an order acknowledgement with no amounts), respond with exactly: {\"not_invoice\":true,\"reason\":\"statement\" or brief reason}. Statements and remittance advices must always be skipped - never extract them as invoices."
].join("\n");

// ---------------------------------------------------------------- main

function processInvoices() {
  var apiKey = PropertiesService.getScriptProperties().getProperty("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("Set ANTHROPIC_API_KEY in Project Settings > Script Properties first.");

  var sheets = getSheets_();
  var processedIds = processedMessageIds_(sheets.log);
  var failedCounts = failedAttemptCounts_(sheets.log);
  var existing = existingInvoiceKeys_(sheets.inv);
  var PAGE = 50;
  var runStart = new Date();

  // ---- Lane 1: PDF attachments (own budget) ----
  runLane_(CONFIG.SEARCH_QUERY, PAGE, { handled: 0 }, function (msg) {
    if (givenUp_(failedCounts, msg, sheets.log)) return;
    var atts = msg.getAttachments();
    var hasCandidate = atts.some(function (a) {
      return isPdfAtt_(a) || /^image\/(jpeg|png|gif|webp)$/.test(a.getContentType());
    });
    if (!atts.length || !hasCandidate) {
      logProcessed_(sheets.log, msg, "SKIPPED", "no PDF/image attachments");
      return;
    }
    var notes = [];
    var status = "OK";
    try {
      processAttachments_(apiKey, sheets, existing, msg, notes, 1);
    } catch (e) {
      status = "FAILED";
      notes.push(String(e && e.message ? e.message : e));
    }
    logProcessed_(sheets.log, msg, status, notes.join("; "));
  }, processedIds);

  // ---- Lane 2: body-only invoice senders (own budget) ----
  if (CONFIG.BODY_QUERY) {
    runLane_(CONFIG.BODY_QUERY, PAGE, { handled: 0 }, function (msg) {
      if (givenUp_(failedCounts, msg, sheets.log)) return;
      var notes = [];
      var status = "OK";
      try {
        var atts = msg.getAttachments();
        var hasPdf = atts.some(isPdfAtt_);
        if (hasPdf) {
          processAttachments_(apiKey, sheets, existing, msg, notes, 2);
        } else {
          // Lane 2 has no filename to test, so the subject carries the same guard.
          // looksLikeInvoiceBody_ below would pass a remittance happily - it has money
          // figures and the word "invoice" all over it, because it lists the invoices
          // being paid.
          if (looksLikeRemittance_(msg.getSubject())) {
            logProcessed_(sheets.log, msg, "SKIPPED", "remittance advice, not a bill");
            return;
          }
          var html = msg.getBody() || msg.getPlainBody() || "";
          html = html.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<script[\s\S]*?<\/script>/gi, "");
          if (!looksLikeInvoiceBody_(msg, html)) {
            logProcessed_(sheets.log, msg, "SKIPPED", "body has no invoice signals");
            return;
          }
          if (html.length > 150000) html = html.slice(0, 150000);
          var result = extractFromContent_(apiKey, [
            { type: "text", text: "Below is the HTML body of a supplier email with no PDF attached. It is a priced order/delivery confirmation that serves as the invoice. Determine the supplier from the email content, sender, or letterhead; if it is clearly a Southern Foodservice order confirmation, use supplier \"Southern Foodservice Pty Ltd\". Use the order code as invoice_number. IMPORTANT: these order confirmations write dates in US MONTH/DAY/YEAR format (e.g. 6/12/26 means 12 June 2026, 7/15/26 means 15 July 2026), NOT Australian day/month. The delivery date shown next to a weekday (e.g. \"for Friday, 6/12/26\") is the invoice_date - convert it from M/D/Y and keep it even if it is in the near future.\n\n" + html }
          ], modelForSender_(msg.getFrom()));
          if (result.not_invoice) {
            notes.push("skipped (" + (result.reason || "not an invoice") + ")");
          } else if (isDupInvoice_(existing, result)) {
            notes.push("duplicate " + result.invoice_number + ", skipped");
          } else {
            if (!result.supplier || !String(result.supplier).trim()) {
              var frm = String(msg.getFrom() || "").toLowerCase();
              if (frm.indexOf("southernfood") !== -1) result.supplier = "Southern Foodservice Pty Ltd";
            }
            fixInvoiceDate_(result, msg.getDate(), notes);
            markInvoice_(existing, result);
            writeInvoice_(sheets, result, msg.getFrom(), "email body", "", msg.getDate(), route_(msg, 2));
            notes.push("added " + result.invoice_number + " (from email body)");
          }
        }
      } catch (e) {
        status = "FAILED";
        notes.push(String(e && e.message ? e.message : e));
      }
      logProcessed_(sheets.log, msg, status, notes.join("; "));
    }, processedIds);
  }

  notifyFailures_(sheets.log, runStart);
}

/**
 * After a run, email a summary of any FAILED rows logged during this run, so failures
 * don't sit silently in the sheet. No failures -> no email.
 */
function notifyFailures_(logSheet, since) {
  if (!CONFIG.ALERT_EMAIL) return;
  var last = logSheet.getLastRow();
  if (last < 2) return;
  var rows = logSheet.getRange(2, 1, last - 1, 6).getValues();
  var fails = rows.filter(function (r) {
    return String(r[4]) === "FAILED" && r[1] instanceof Date && r[1] >= since;
  });
  if (!fails.length) return;
  var body = fails.length + " invoice(s) failed to process in the latest run:\n\n" +
    fails.map(function (r) {
      return "• " + (r[2] || "(unknown sender)") + "\n  " + (r[3] || "") + "\n  " + (r[5] || "");
    }).join("\n\n") +
    "\n\nTo retry: delete each failed row from the ProcessedEmails tab, then run processInvoicesLocked again.";
  try {
    MailApp.sendEmail(CONFIG.ALERT_EMAIL, "\u26a0\ufe0f " + fails.length + " invoice(s) failed to process", body);
  } catch (e) { /* never let alerting break the run */ }
}

function runLane_(query, PAGE, state, handleMsg, processedIds) {
  var start = 0;
  while (state.handled < CONFIG.MAX_EMAILS_PER_RUN) {
    var threads = GmailApp.search(query, start, PAGE);
    if (threads.length === 0) break;
    for (var t = 0; t < threads.length && state.handled < CONFIG.MAX_EMAILS_PER_RUN; t++) {
      var messages = threads[t].getMessages();
      for (var m = 0; m < messages.length && state.handled < CONFIG.MAX_EMAILS_PER_RUN; m++) {
        var msg = messages[m];
        var msgId = msg.getId();
        if (processedIds[msgId]) continue;
        handleMsg(msg);
        processedIds[msgId] = true;
        state.handled++;
      }
    }
    start += PAGE;
  }
}

function processAttachments_(apiKey, sheets, existing, msg, notes, lane) {
  // Overhead suppliers (Overheads.gs). typeof-guarded so invoice ingestion carries on
  // exactly as before if that file is ever removed.
  var OHX = typeof ohProfileForMessage_ === "function";
  var prof = OHX ? ohProfileForMessage_(msg.getFrom(), msg.getSubject()) : null;
  if (prof && ohSkipMessage_(prof, msg.getSubject(), "")) {
    notes.push("skipped (" + prof.id + " notice, not a bill)");
    return;
  }
  msg.getAttachments().forEach(function (att) {
    var ct = att.getContentType();
    var isPdf = isPdfAtt_(att);
    var isImg = !isPdf && /^image\/(jpeg|png|gif|webp)$/.test(ct);
    if (!isPdf && !isImg) return;
    if (isImg && att.getSize() < 50 * 1024) return;
    if (att.getSize() > 20 * 1024 * 1024) { notes.push(att.getName() + ": too large, skipped"); return; }

    // Checked BEFORE the API call, on purpose: it costs nothing, it cannot be talked out
    // of it the way a prompt rule can, and all five remittance advices that got through
    // announced themselves in the filename. See looksLikeRemittance_.
    if (looksLikeRemittance_(att.getName())) {
      notes.push(att.getName() + ": skipped (remittance advice, not a bill)");
      return;
    }
    if (prof && ohSkipMessage_(prof, "", att.getName())) {
      notes.push(att.getName() + ": skipped (" + prof.id + " notice, not a bill)");
      return;
    }
    var ohCtx = prof ? ohContext_(msg, att, lane) : null;
    if (prof && prof.statementLines && isPdf) {
      var sl;
      try { sl = ohStatementLines_(apiKey, sheets, existing, msg, att, prof, ohCtx); }
      catch (e) { throw new Error(att.getName() + ": " + (e && e.message ? e.message : e)); }
      notes.push(att.getName() + ": " + sl.note);
      return;
    }

    var b64 = Utilities.base64Encode(att.getBytes());
    var block = isPdf
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } }
      : { type: "image", source: { type: "base64", media_type: ct, data: b64 } };
    // Attribute any extraction failure to THIS attachment - without this the outer
    // handler logs a bare parser error with no clue which file caused it.
    var result;
    try {
      result = extractFromContent_(apiKey, [block],
        (prof && prof.model) || modelForSender_(msg.getFrom()),
        prof ? ohPromptFor_(prof) : "");
    } catch (e) {
      throw new Error(att.getName() + " (" + Math.round(att.getSize() / 1024) + "KB): " +
        (e && e.message ? e.message : e));
    }
    if (result.not_invoice) { notes.push(att.getName() + ": skipped (" + (result.reason || "not an invoice") + ")"); return; }

    fixInvoiceDate_(result, msg.getDate(), notes);

    // A profile can also be recognised from the supplier the model read, which catches an
    // overhead bill forwarded from somewhere its sender list doesn't cover.
    var prof2 = prof || (OHX ? ohProfileForSupplier_(result.supplier) : null);
    if (prof2) {
      var ctx = ohCtx || ohContext_(msg, att, lane);
      ctx.savePdf = function () { return savePdf_(att, result); };
      var ow = ohWriteInvoice_(sheets, result, prof2, existing, ctx);
      notes.push(att.getName() + ": " + ow.note);
      return;
    }

    if (isDupInvoice_(existing, result)) { notes.push(att.getName() + ": duplicate " + result.invoice_number + ", skipped"); return; }
    markInvoice_(existing, result);

    var pdfUrl = savePdf_(att, result);
    writeInvoice_(sheets, result, msg.getFrom(), att.getName(), pdfUrl, msg.getDate(), route_(msg, lane || 1));
    notes.push(att.getName() + ": added " + result.invoice_number);
  });
}

// ---------------------------------------------------------------- claude

function modelForSender_(fromEmail) {
  var f = String(fromEmail || "").toLowerCase();
  for (var i = 0; i < CONFIG.PREMIUM_SENDERS.length; i++) {
    if (f.indexOf(CONFIG.PREMIUM_SENDERS[i]) !== -1) return CONFIG.PREMIUM_MODEL;
  }
  return CONFIG.MODEL;
}

/**
 * True if this document name is a remittance advice — someone telling US they have paid.
 *
 * A remittance is the worst look-alike in this inbox. It carries a supplier name, a
 * document number, a date, a list of amounts and a total, so the model reads it as an
 * invoice and looksLikeInvoiceBody_ passes it without hesitation. Five were booked as
 * bills: Coca-Cola $9,142.22, A.H. Beard $4,248.75, RISSAFETY $4,125.00, Australian
 * Therapeutic Proteins $4,033.15, SD Packaging $1,705.00 — $23,254.12 of spend that was
 * never spent, all landing at the DEFAULT_VENUE because a remittance has no deliver_to.
 *
 * Checked on the FILENAME (lane 1) or the SUBJECT (lane 2), before any API call. Tested
 * against all 1,226 rows of the live Invoices tab on 9 Sep 2026: it fires on exactly
 * those five and on nothing else.
 *
 * The second test is the important half. Some suppliers attach a combined document —
 * "Invoice 12345 and remittance slip" — that IS a bill. If an invoice word appears too,
 * this defers to the model rather than dropping real money. Dropping a real invoice is
 * the expensive mistake here; letting one remittance through to the prompt rule is not.
 */
function looksLikeRemittance_(name) {
  var n = String(name || "");
  // Separators are [\s_\-.]* throughout, not \s*: these names are filenames, and a
  // filename writes a space as a hyphen or underscore as often as a space
  // ("payment-advice.pdf", "REM_ADV2138525.pdf"). A \s*-only test missed those.
  if (!/rem[_\-\s.]*adv|remittance|payment[\s_\-.]*advice|creditor[\s_\-.]*transfer|eft[\s_\-.]*advice/i.test(n)) return false;
  return !/tax\s*invoice|invoice|credit\s*note|adjustment/i.test(n);
}

// Describe HOW this email qualified as an invoice, so the `source` column tells you
// whether it came in because it was delivered to accounts@, because it carried the
// supplier-invoices label, or because it's a known body-only sender. The query uses an
// OR of these, and Gmail doesn't report which arm matched, so we re-check the message
// itself: its labels (definitive) and its To/Delivered-To (from the raw headers). More
// than one can be true - e.g. a labelled email that also went to accounts@ - so all that
// apply are listed. `lane` is 1 for a PDF attachment, 2 for body-only.
function route_(msg, lane) {
  var tags = [];
  try {
    var labelled = msg.getThread().getLabels().some(function (l) {
      return /supplier[- ]?invoices/i.test(l.getName());
    });
    if (labelled) tags.push("label");
  } catch (e) { /* label read can fail on odd threads - ignore */ }
  var to = "";
  try { to = (msg.getTo() + " " + (msg.getHeader ? msg.getHeader("Delivered-To") : "")).toLowerCase(); }
  catch (e) { to = String(msg.getTo() || "").toLowerCase(); }
  if (to.indexOf("accounts@redsquarecafe.com.au") !== -1) tags.push("accounts@");
  var from = String(msg.getFrom() || "").toLowerCase();
  for (var i = 0; i < CONFIG.BODY_SENDERS.length; i++) {
    if (from.indexOf(CONFIG.BODY_SENDERS[i]) !== -1) { tags.push("known-sender"); break; }
  }
  if (!tags.length) tags.push("other");
  return "lane" + lane + ":" + tags.join("+");
}

// extraPrompt: appended after EXTRACT_PROMPT. Used by Overheads.gs to admit invoice /
// statement hybrids and multi-site bills for overhead suppliers only - COGS suppliers get
// the base prompt, unchanged, so their statements are still skipped.
function extractFromContent_(apiKey, contentBlocks, model, extraPrompt) {
  var payload = {
    model: model || CONFIG.MODEL,
    max_tokens: 8000,
    messages: [{ role: "user", content: contentBlocks.concat([{ type: "text", text: EXTRACT_PROMPT + (extraPrompt || "") }]) }]
  };

  var resp = UrlFetchApp.fetch("https://api.anthropic.com/v1/messages", {
    method: "post",
    contentType: "application/json",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  var code = resp.getResponseCode();
  var body = JSON.parse(resp.getContentText());
  if (code !== 200) throw new Error("API " + code + ": " + (body.error && body.error.message ? body.error.message : resp.getContentText().slice(0, 200)));

  var text = body.content.filter(function (b) { return b.type === "text"; })
    .map(function (b) { return b.text; }).join("\n")
    .replace(/```json|```/g, "").trim();
  // If the model answered in prose instead of JSON (e.g. "I need to see the document"),
  // there is nothing to repair - the input was unusable. Surface what it actually said
  // so the ProcessedEmails note is diagnosable instead of "Unexpected token 'I'".
  if (!/^[\[{]/.test(text)) {
    var stopReason = body.stop_reason || "";
    var hint = stopReason === "max_tokens"
      ? "response hit max_tokens - invoice may be too long"
      : "model returned prose, not JSON";
    throw new Error(hint + ': "' + text.slice(0, 200).replace(/\s+/g, " ") + '"');
  }

  try {
    return JSON.parse(text);
  } catch (e) {
    // Model occasionally slips a $ sign or a thousands-comma into a numeric field,
    // breaking JSON. Repair the common cases and retry once before giving up.
    var repaired = text
      .replace(/:\s*\$/g, ":")                              // "price": $32.25  -> "price": 32.25
      .replace(/,\s*\$/g, ",")                              // ,$32.25          -> ,32.25
      .replace(/(\d),(\d{3}\b)/g, "$1$2")                  // 1,234.00         -> 1234.00 (thousands)
      .replace(/\bNaN\b|\bInfinity\b/g, "null");
    try {
      return JSON.parse(repaired);
    } catch (e2) {
      // Still broken - report the payload, not just the parser's complaint, and flag
      // truncation (the usual cause of a JSON reply that starts valid and stops mid-field).
      var trunc = (body.stop_reason === "max_tokens") ? " [truncated at max_tokens]" : "";
      throw new Error("could not parse model JSON" + trunc + ': "' +
        repaired.slice(0, 200).replace(/\s+/g, " ") + '"');
    }
  }
}

// ---------------------------------------------------------------- sheets

function getSheets_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var inv = ss.getSheetByName("Invoices") || ss.insertSheet("Invoices");
  var lin = ss.getSheetByName("InvoiceLines") || ss.insertSheet("InvoiceLines");
  var log = ss.getSheetByName("ProcessedEmails") || ss.insertSheet("ProcessedEmails");
  if (inv.getLastRow() === 0) inv.appendRow(["scanned", "venue", "supplier", "invoice_number", "invoice_date", "subtotal", "gst", "freight", "total", "category", "type", "status", "source", "pdf_url", "cdl"]);
  else if (String(inv.getRange(1, 14).getValue()) !== "pdf_url") inv.getRange(1, 14).setValue("pdf_url");
  // CDL (container deposit levy) is appended as column 15 rather than inserted next to
  // freight on purpose: existing rows and the explorer read columns 3-9 by POSITION, so
  // inserting mid-table would silently shift supplier..total on 500+ rows.
  if (inv.getLastRow() >= 1 && String(inv.getRange(1, 15).getValue()) !== "cdl") inv.getRange(1, 15).setValue("cdl");
  // Column 16: the customer order reference printed on the invoice, used to retire the
  // earlier order-confirmation row. Appended, not inserted, for the same reason as cdl.
  if (inv.getLastRow() >= 1 && String(inv.getRange(1, 16).getValue()) !== "order_ref") inv.getRange(1, 16).setValue("order_ref");
  if (lin.getLastRow() === 0) lin.appendRow(["invoice_number", "supplier", "venue", "item_code", "description", "qty", "unit", "unit_price", "line_total"]);
  if (log.getLastRow() === 0) log.appendRow(["message_id", "processed_at", "from", "subject", "status", "notes"]);
  return { inv: inv, lin: lin, log: log };
}

function processedMessageIds_(logSheet) {
  var ids = {};
  var last = logSheet.getLastRow();
  if (last < 2) return ids;
  logSheet.getRange(2, 1, last - 1, 1).getValues().forEach(function (r) { ids[r[0]] = true; });
  return ids;
}

// How many times each message has already been logged FAILED. Used to stop a
// permanently-bad email being re-extracted (and re-billed) every time its row is cleared.
function failedAttemptCounts_(logSheet) {
  var counts = {};
  var last = logSheet.getLastRow();
  if (last < 2) return counts;
  logSheet.getRange(2, 1, last - 1, 5).getValues().forEach(function (r) {
    if (String(r[4]) === "FAILED") counts[r[0]] = (counts[r[0]] || 0) + 1;
  });
  return counts;
}

function logProcessed_(logSheet, msg, status, notes) {
  logSheet.appendRow([msg.getId(), new Date(), msg.getFrom(), msg.getSubject(), status, notes || ""]);
}

// Cheap pre-screen for lane 2. Lane 2 now sweeps everything delivered to accounts@,
// which includes plenty of ordinary mail, and every body sent for extraction costs an
// API call. Known invoice senders always pass; everything else must show both a money
// figure and an invoice-ish word before we spend a call on it.
function looksLikeInvoiceBody_(msg, html) {
  var from = String(msg.getFrom() || "").toLowerCase();
  for (var i = 0; i < CONFIG.BODY_SENDERS.length; i++) {
    if (from.indexOf(CONFIG.BODY_SENDERS[i]) !== -1) return true;
  }
  var text = String(html || "").replace(/<[^>]+>/g, " ");
  var hay = (String(msg.getSubject() || "") + " " + text).toLowerCase();
  var hasMoney = /\$\s*\d/.test(hay) || /\b\d+\.\d{2}\b/.test(hay);
  var hasWord = /\b(invoice|tax invoice|credit note|adjustment|order|delivery docket|statement|amount due|total due|qty|quantity)\b/.test(hay);
  return hasMoney && hasWord;
}

// True if this message has already failed MAX_ATTEMPTS times. Logs one GAVE_UP row so
// the tab shows why it stopped, and does not count that row as another failure.
function givenUp_(failedCounts, msg, logSheet) {
  var id = msg.getId();
  if ((failedCounts[id] || 0) < CONFIG.MAX_ATTEMPTS) return false;
  logProcessed_(logSheet, msg, "GAVE_UP",
    "failed " + failedCounts[id] + "x - needs manual entry; delete its rows to retry");
  failedCounts[id] = 0; // don't re-log on a later lane in the same run
  return true;
}

function existingInvoiceKeys_(invSheet) {
  // Two nets: supplier+number, and number+total (catches supplier-name drift on re-extraction)
  var keys = { sn: {}, nt: {} };
  var last = invSheet.getLastRow();
  if (last < 2) return keys;
  var vals = invSheet.getRange(2, 3, last - 1, 7).getValues(); // supplier..total
  vals.forEach(function (r) {
    keys.sn[normKey_(r[0]) + "|" + normKey_(r[1])] = true;
    if (r[1] !== "" && r[1] !== null) keys.nt[normKey_(r[1]) + "|" + Math.round((Number(r[6]) || 0) * 100)] = true;
  });
  return keys;
}

function isDupInvoice_(existing, result) {
  var sn = normKey_(result.supplier) + "|" + normKey_(result.invoice_number);
  if (existing.sn[sn]) return true;
  var n = normKey_(result.invoice_number);
  if (n && existing.nt[n + "|" + Math.round((Number(result.total) || 0) * 100)]) return true;
  return false;
}

function markInvoice_(existing, result) {
  existing.sn[normKey_(result.supplier) + "|" + normKey_(result.invoice_number)] = true;
  existing.nt[normKey_(result.invoice_number) + "|" + Math.round((Number(result.total) || 0) * 100)] = true;
}

function writeInvoice_(sheets, j, fromEmail, fileName, pdfUrl, emailDate, route) {
  // venue_override: set by Overheads.gs from the supplier's own site ID. Address matching
  // cannot do this job - Cambridge and Luma share a building on Kennedy Drive, and each
  // supplier numbers its units differently.
  var venue = j.venue_override || detectVenue_(j.deliver_to);
  var isCredit = j.doc_type === "credit_note";
  // The prompt asks for credit notes as POSITIVE amounts and the sign is applied here. The
  // model does not always comply: on 11 Sep 2026, 7 of 53 credit notes in the live tab had
  // been reported negative and flipped positive by this line - $3,074.75 of credits counted
  // as spend, $2,554 of it one Supagas credit. If the model already made the total
  // negative, keep its signs as they are.
  var sign = isCredit ? ((Number(j.total) || 0) < 0 ? 1 : -1) : 1;
  var invNo = String(j.invoice_number || "");
  var items = (j.items || []).map(function (li) {
    return Array.isArray(li)
      ? { d: li[0] || "", q: li[1], u: li[2] || "", p: li[3], t: li[4], c: li[5] || "", cd: Number(li[6]) || 0 }
      : { d: li.description || "", q: li.qty, u: li.unit || "", p: li.unit_price, t: li.line_total, c: li.item_code || "", cd: Number(li.line_cdl) || 0 };
  });

  var lineSum = items.reduce(function (s, l) { return s + (Number(l.t) || 0); }, 0);
  var freight = Number(j.freight) || 0;
  // CDL: prefer the sum of the per-line deposits (the model only transcribes those, it
  // never adds them up), and fall back to a printed invoice-level total if there were
  // no per-line values. Doing the arithmetic here is what stops the model narrating.
  var lineCdl = items.reduce(function (s, l) { return s + (Number(l.cd) || 0); }, 0);
  var cdl = lineCdl > 0 ? lineCdl : (Number(j.cdl) || 0);
  cdl = Math.round(cdl * 100) / 100;
  var sub = j.subtotal === null || j.subtotal === undefined ? null : Number(j.subtotal);
  // Reconciliation accepts every legitimate invoice layout we've seen, so CHECK only
  // fires on GENUINE mismatches (a misread or missing line), not on formatting conventions:
  //   lines = subtotal            (standard: ex-GST lines sum to subtotal)
  //   lines + freight = subtotal  (freight billed separately)
  //   lines = total               (BDD/PFD: line totals already GST-inclusive)
  //   lines + freight - gst = sub (freight-shown-inc-GST convention)
  //   any of the above + cdl      (BDD: per-line container deposits sit outside the
  //                                ex-CDL line totals and are included in the subtotal)
  var tot = Number(j.total) || 0;
  var gstV = Number(j.gst) || 0;
  var reconciled = sub !== null && (
    Math.abs(lineSum - sub) <= 0.06 ||
    Math.abs(lineSum + freight - sub) <= 0.06 ||
    Math.abs(lineSum - tot) <= 0.06 ||
    Math.abs(lineSum + freight - gstV - sub) <= 0.06 ||
    Math.abs(lineSum - gstV - sub) <= 0.06 ||
    Math.abs(lineSum + cdl - sub) <= 0.06 ||
    Math.abs(lineSum + freight + cdl - sub) <= 0.06 ||
    Math.abs(lineSum + freight + cdl - tot) <= 0.06 ||
    Math.abs(lineSum + cdl - tot) <= 0.06
  );

  // Deterministic date sanity: a date can't be scrambled back to truth by a prompt (the
  // day/month/year info is lost once jumbled), so instead of guessing, flag clearly-wrong
  // dates as CHECK so they surface in the explorer and get fixed against the PDF.
  var dateOk = true;
  var dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(j.invoice_date || ""));
  if (!dm) {
    dateOk = false; // unparseable / missing
  } else {
    var dObj = new Date(+dm[1], +dm[2] - 1, +dm[3]);
    // HARD CEILING: an invoice cannot be dated after the email that delivered it (plus a
    // few days slack for order/delivery confirmations). This works at ANY point in history,
    // so it stays valid when backfilling old mail — unlike a fixed "recent window" check.
    var ceiling = emailDate ? new Date(emailDate.getTime() + 21 * 864e5) : new Date(Date.now() + 21 * 864e5);
    // FLOOR: an invoice emailed now shouldn't be dated years before that email. Allow ~1
    // year back from the email date (invoices are sent within weeks; a year is generous).
    var floor = emailDate ? new Date(emailDate.getTime() - 400 * 864e5) : new Date("2020-01-01");
    if (dObj > ceiling || dObj < floor) dateOk = false;
  }

  // force_check: Overheads.gs sets it when a venue had to be defaulted, when site totals
  // don't add up to the bill, or when the row comes off a statement line.
  var status = (reconciled && dateOk && !j.force_check) ? "OK" : "CHECK";

  // Leading apostrophe keeps invoice numbers as text so the data feed
  // never nulls alphanumeric ones (SAV59701, CR632518, ADVS8Y).
  sheets.inv.appendRow([
    new Date(), venue, j.supplier || "", "'" + invNo, j.invoice_date || "",
    sign * (Number(j.subtotal) || 0), sign * (Number(j.gst) || 0), sign * freight, sign * (Number(j.total) || 0),
    j.category_override || j.category_guess || "Other", isCredit ? "credit_note" : "invoice",
    status, "email: " + fromEmail + " / " + fileName + (route ? " [" + route + "]" : ""), pdfUrl || "", sign * cdl,
    j.order_ref ? "'" + String(j.order_ref).trim() : ""
  ]);

  // If this tax invoice names the order it came from, retire that order row. Dedupe always
  // resolves in favour of the INVOICE: the invoice prints the order code, never the reverse.
  // An order with no matching invoice is left alone and keeps counting as spend.
  if (!isCredit && j.order_ref) {
    try { supersedeOrderRow_(sheets.inv, j.supplier, j.order_ref); } catch (e) {}
  }

  if (items.length) {
    var rows = items.map(function (l) {
      // Credit notes: qty and line_total go negative; unit_price stays positive so price history is clean
      return ["'" + invNo, j.supplier || "", venue, l.c, l.d, sign * (Number(l.q) || 0), l.u, l.p, sign * (Number(l.t) || 0)];
    });
    sheets.lin.getRange(sheets.lin.getLastRow() + 1, 1, rows.length, 9).setValues(rows);
  }
}

// ---------------------------------------------------------------- helpers

function savePdf_(att, j) {
  if (!CONFIG.SAVE_PDFS) return "";
  try {
    var it = DriveApp.getFoldersByName(CONFIG.DRIVE_FOLDER);
    var folder = it.hasNext() ? it.next() : DriveApp.createFolder(CONFIG.DRIVE_FOLDER);
    var name = [(j.invoice_date || "nodate"), (j.supplier || "unknown"), (j.invoice_number || att.getName())]
      .join(" - ").replace(/[\/\\:*?"<>|]/g, "-") + ".pdf";
    var file = folder.createFile(att.copyBlob().setName(name));
    return file.getUrl();
  } catch (e) {
    return "";
  }
}

function detectVenue_(deliverTo) {
  var hint = String(deliverTo || "").toLowerCase();
  for (var k in CONFIG.VENUES) {
    if (hint.indexOf(k) !== -1) return CONFIG.VENUES[k];
  }
  return CONFIG.DEFAULT_VENUE;
}

function isPdfAtt_(a) {
  return a.getContentType() === "application/pdf" || /\.pdf$/i.test(a.getName() || "");
}

function normKey_(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Normalise a unit label for duplicate matching only. The extractor transcribes the same
// physical unit inconsistently between passes ("units" / "each" / "ea" / "6-pack" /
// "4-pack" ...). Any "N-pack" and every each-synonym collapse to "ea"; weight/volume
// units keep their real distinction (kg vs g matters). Used solely inside dedupeInvoices
// so a re-read with a different unit word is recognised as the same line - it does NOT
// change what gets stored.
function unitKey_(u) {
  var n = normKey_(u);
  if (!n) return "";
  if (/^\d+pack$/.test(n)) return "ea";          // 6pack, 4pack, 10pack, 12pack -> ea
  var EA = { units: 1, unit: 1, each: 1, ea: 1, ctn: 1, carton: 1, pack: 1, pkt: 1, packet: 1 };
  if (EA[n]) return "ea";
  var KG = { kg: 1, kilogram: 1, kilograms: 1, kilo: 1 };
  if (KG[n]) return "kg";
  var G = { g: 1, gram: 1, grams: 1, gm: 1 };
  if (G[n]) return "g";
  var L = { l: 1, litre: 1, litres: 1, liter: 1, liters: 1, lt: 1 };
  if (L[n]) return "l";
  return n;
}

// ---------------------------------------------------------------- one-off repairs

/** One-off: remove the confirmed double-extraction on invoice 633422 (Doppio Foods).
 *  Verified against the PDF: real invoice total $2,103.54, but the sheet held $4,175.90 -
 *  every one of the 15 lines was written twice (once with a "-1KG"/"(6)" style suffix and
 *  once without, from two extraction passes). This keeps ONE row per distinct
 *  stockcode+line_total and deletes the rest. Safe to run more than once - if the dupes
 *  are already gone it deletes nothing. Run manually from the editor, then delete this
 *  function if you like. */
function fix633422Duplicate() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var lin = ss.getSheetByName("InvoiceLines");
  if (!lin || lin.getLastRow() < 2) return;
  var vals = lin.getRange(2, 1, lin.getLastRow() - 1, 9).getValues();
  var keep = {}, toDelete = [];
  for (var i = 0; i < vals.length; i++) {
    var r = vals[i];
    if (normKey_(r[0]) !== normKey_("633422")) continue;
    var code = String(r[3] || "").replace(/\.0$/, "");
    var sig = code + "|" + Math.round((Number(r[8]) || 0) * 100); // stockcode + line_total
    if (keep[sig]) toDelete.push(i + 2); else keep[sig] = true;
  }
  toDelete.sort(function (a, b) { return b - a; }).forEach(function (row) { lin.deleteRow(row); });
  Logger.log("633422: kept " + Object.keys(keep).length + " lines, deleted " + toDelete.length + " duplicate rows.");
  // Also collapse the doubled HEADER row for 633422, keeping the first.
  var inv = ss.getSheetByName("Invoices");
  var iv = inv.getRange(2, 1, inv.getLastRow() - 1, 9).getValues();
  var seenHdr = false, hdrDel = [];
  for (var k = 0; k < iv.length; k++) {
    if (normKey_(iv[k][3]) !== normKey_("633422")) continue;
    if (seenHdr) hdrDel.push(k + 2); else seenHdr = true;
  }
  hdrDel.sort(function (a, b) { return b - a; }).forEach(function (row) { inv.deleteRow(row); });
  if (hdrDel.length) Logger.log("633422: deleted " + hdrDel.length + " duplicate header row(s).");
}

/** One-off: convert existing invoice-number columns to text (fixes alphanumeric numbers vanishing in the explorer). */
function fixInvoiceNumberText() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  [["Invoices", 4], ["InvoiceLines", 1]].forEach(function (t) {
    var sh = ss.getSheetByName(t[0]);
    if (!sh || sh.getLastRow() < 2) return;
    var rng = sh.getRange(2, t[1], sh.getLastRow() - 1, 1);
    rng.setNumberFormat("@");
    var vals = rng.getValues().map(function (r) {
      var v = String(r[0] === null || r[0] === undefined ? "" : r[0]).trim();
      return ["'" + v];
    });
    rng.setValues(vals);
  });
  Logger.log("Invoice number columns converted to text");
}

/** One-off: archive PDFs for existing rows by finding the original emails. No API credits used. */
/** One-off pair, same shape as auditOrderDuplicates / applyOrderDuplicates.
 *  Credit notes the model reported NEGATIVE were flipped positive by writeInvoice_ before
 *  11 Sep 2026, so they count as spend. Found live that day: 7 of 53, $3,074.75, the
 *  largest a $2,554 Supagas credit. audit... logs them; apply... negates the money columns
 *  on those Invoices rows and on their InvoiceLines rows. Only rows of type credit_note
 *  with a POSITIVE total are touched, so running either twice changes nothing. */
function auditCreditNoteSigns() { creditSignCore_(false); }
function applyCreditNoteSigns() { creditSignCore_(true); }
function creditSignCore_(apply) {
  var sh = getSheets_();
  var inv = sh.inv, lin = sh.lin;
  var n = inv.getLastRow();
  if (n < 2) return;
  var iv = inv.getRange(2, 1, n - 1, 15).getValues();
  var keys = {}, hits = 0, sum = 0;
  for (var i = 0; i < iv.length; i++) {
    if (String(iv[i][10]) !== "credit_note" || !(Number(iv[i][8]) > 0)) continue;
    hits++; sum += Number(iv[i][8]);
    keys[normKey_(iv[i][2]) + "|" + normKey_(iv[i][3])] = true;
    Logger.log("row " + (i + 2) + " " + iv[i][2] + " " + String(iv[i][3]).replace(/^'/, "") + " " + iv[i][4] + " total " + iv[i][8]);
    if (apply) {
      [6, 7, 8, 9, 15].forEach(function (c) {
        var v = Number(iv[i][c - 1]) || 0;
        if (v) inv.getRange(i + 2, c).setValue(-Math.abs(v));
      });
    }
  }
  var ln = lin.getLastRow(), lines = 0;
  if (ln > 1) {
    var lv = lin.getRange(2, 1, ln - 1, 9).getValues();
    for (var k = 0; k < lv.length; k++) {
      if (!keys[normKey_(lv[k][1]) + "|" + normKey_(lv[k][0])]) continue;
      if (!(Number(lv[k][8]) > 0)) continue;
      lines++;
      if (apply) {
        lin.getRange(k + 2, 9).setValue(-Math.abs(Number(lv[k][8])));
        if (Number(lv[k][5]) > 0) lin.getRange(k + 2, 6).setValue(-Math.abs(Number(lv[k][5])));
      }
    }
  }
  Logger.log((apply ? "Fixed " : "Would fix ") + hits + " credit note(s), $" + sum.toFixed(2) + ", and " + lines + " line row(s).");
}

function backfillPdfs() {
  var sheets = getSheets_();
  var inv = sheets.inv;
  var last = inv.getLastRow();
  if (last < 2) return;
  var data = inv.getRange(2, 1, last - 1, 14).getValues();
  var fixed = 0;
  for (var i = 0; i < data.length; i++) {
    if (data[i][13]) continue;
    var m = /\/ (.+)$/.exec(String(data[i][12] || ""));
    if (!m) continue;
    var fileName = m[1].trim();
    if (fileName === "email body") continue;
    var d = data[i][4];
    var dateStr = (d instanceof Date) ? Utilities.formatDate(d, Session.getScriptTimeZone(), "yyyy-MM-dd") : String(d || "nodate");
    var threads = GmailApp.search('filename:"' + fileName + '"', 0, 5);
    var url = "";
    for (var t = 0; t < threads.length && !url; t++) {
      var msgs = threads[t].getMessages();
      for (var g = 0; g < msgs.length && !url; g++) {
        var atts = msgs[g].getAttachments();
        for (var a = 0; a < atts.length && !url; a++) {
          if (atts[a].getName() === fileName) {
            url = savePdf_(atts[a], { invoice_date: dateStr, supplier: data[i][2], invoice_number: data[i][3] });
          }
        }
      }
    }
    if (url) { inv.getRange(i + 2, 14).setValue(url); fixed++; }
  }
  Logger.log("Archived " + fixed + " PDFs");
}


// ================================================================
// CONCURRENCY + CLEANUP  (formerly invoice-processor-additions.gs)
// ================================================================

/**
 * processInvoicesLocked — run THIS from the hourly trigger and for manual runs.
 * A lock stops a manual run and the trigger from overlapping (which was the cause
 * of duplicate invoices). If a run is already going, this one steps aside.
 */
function processInvoicesLocked() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    Logger.log("Another run is already in progress — skipping.");
    return;
  }
  try {
    processInvoices();
  } finally {
    lock.releaseLock();
  }
}

/**
 * dedupeInvoices — one-off cleanup for existing exact-duplicate invoices.
 * Removes the extra Invoices row and its doubled block of InvoiceLines only when
 * supplier + number + total match exactly AND the two line sets are identical.
 * Anything ambiguous is skipped and logged for you to clean by hand. Run once,
 * read the execution log, done.
 */
function dedupeInvoices() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var inv = ss.getSheetByName("Invoices");
  var lin = ss.getSheetByName("InvoiceLines");
  if (!inv || inv.getLastRow() < 3) return;

  var iVals = inv.getRange(2, 1, inv.getLastRow() - 1, 14).getValues();
  var seen = {}, invRowsToDelete = [];
  for (var i = 0; i < iVals.length; i++) {
    var r = iVals[i];
    var numKey = normKey_(r[3]);
    // Match on invoice_number + total ONLY (ignore supplier name), so the same invoice
    // under different name spellings (ALM ON-PREMISE vs ALM TAS vs Metcash - ALM) is
    // caught. Keep the FIRST occurrence; delete later ones.
    var key = numKey + "|" + Math.round((Number(r[8]) || 0) * 100);
    if (!numKey) { continue; } // never dedupe number-less rows (e.g. some credit notes)
    if (seen[key] !== undefined) {
      invRowsToDelete.push(i + 2);
      Logger.log("Duplicate invoice: " + r[2] + " #" + r[3] + " $" + r[8] + " (row " + (i + 2) + ", keeping row " + (seen[key] + 2) + ")");
    } else { seen[key] = i; }
  }

  // Remove duplicated line rows created by double-extraction, without ever touching
  // legitimate repeat charges. Verified against live data, there are TWO dup shapes and
  // one look-alike that must be preserved:
  //
  //   1. Unit-drift re-read (633960): the invoice was extracted twice and each physical
  //      line was transcribed with a different unit label each pass ("6-pack" then
  //      "units"). Within a content-group the RAW units differ -> unambiguous, collapse.
  //
  //   2. Uniform replication (633422): the whole invoice was written twice with identical
  //      rows. Every distinct line then appears exactly the same number of times (x2).
  //      Safe to collapse ONLY when the whole invoice is a clean Nx multiple.
  //
  //   3. Legitimate repeats (waste invoice 8101251175): the same weekly service line is
  //      billed many times, and DIFFERENT lines repeat different numbers of times (25x,
  //      22x, 7x, plus singletons). Not a uniform multiple -> leave completely alone.
  //      Collapsing these would delete hundreds of dollars of real charges.
  var lVals = lin.getRange(2, 1, lin.getLastRow() - 1, 9).getValues();
  var lineRowsToDelete = [];
  var flaggedForReview = [];
  var byNum = {};
  for (var j = 0; j < lVals.length; j++) {
    var nk = normKey_(lVals[j][0]);
    if (!nk) continue;
    (byNum[nk] = byNum[nk] || []).push(j);
  }
  function contentSig_(j) {
    var r = lVals[j];
    var ident = (r[3] === "" || r[3] == null) ? normKey_(r[4]) : normKey_(r[3]);
    return [ident, normKey_(r[4]), r[5], unitKey_(r[6]), Math.round((Number(r[8]) || 0) * 100)].join("|");
  }
  Object.keys(byNum).forEach(function (numKey) {
    var idx = byNum[numKey];
    if (idx.length < 2) return;
    var buckets = {};
    idx.forEach(function (j) { (buckets[contentSig_(j)] = buckets[contentSig_(j)] || []).push(j); });
    var sigs = Object.keys(buckets);
    var removedForNum = 0;

    // Shape 1: unit-drift. A content-group whose RAW unit labels differ is a re-extraction
    // of the same physical lines; keep one copy per physical line.
    var unitDriftHandled = {};
    sigs.forEach(function (sig) {
      var group = buckets[sig];
      if (group.length < 2) return;
      var byRaw = {};
      group.forEach(function (j) { var ru = normKey_(lVals[j][6]); (byRaw[ru] = byRaw[ru] || []).push(j); });
      if (Object.keys(byRaw).length < 2) return;
      unitDriftHandled[sig] = true;
      var physical = Math.max.apply(null, Object.keys(byRaw).map(function (ru) { return byRaw[ru].length; }));
      var order = Object.keys(byRaw).sort(function (a, b) { return a === "units" ? 1 : b === "units" ? -1 : 0; });
      var keep = [];
      order.forEach(function (ru) { byRaw[ru].forEach(function (j) { if (keep.length < physical) keep.push(j); }); });
      var keepSet = {}; keep.forEach(function (j) { keepSet[j] = true; });
      group.forEach(function (j) { if (!keepSet[j]) { lineRowsToDelete.push(j + 2); removedForNum++; } });
    });

    // Shape 2: uniform whole-invoice replication. Only if EVERY not-already-handled
    // content-group repeats the SAME number of times (>=2). Uneven repeats (shape 3, the
    // waste invoice) fail this test and are left untouched.
    var rem = sigs.filter(function (sig) { return !unitDriftHandled[sig]; });
    if (rem.length) {
      var mult = buckets[rem[0]].length;
      var uniform = mult >= 2 && rem.every(function (sig) { return buckets[sig].length === mult; });
      if (uniform) {
        rem.forEach(function (sig) {
          buckets[sig].forEach(function (j, k) { if (k > 0) { lineRowsToDelete.push(j + 2); removedForNum++; } });
        });
      } else {
        // Some but not all lines repeat (e.g. 633422: 12 lines twice, 8 once, several of
        // the singletons being description-variant pairs like "...Blend" / "...Blend-1KG").
        // This is NOT a clean double-extraction and NOT clearly legitimate - deleting on a
        // guess could destroy a real four-figure coffee line. Flag it, don't touch it.
        var dupSigs = rem.filter(function (sig) { return buckets[sig].length > 1; });
        if (dupSigs.length && !removedForNum) {
          flaggedForReview.push(numKey + " (" + dupSigs.length + " repeated line(s) among " +
            rem.length + " distinct) - review manually");
        }
      }
    }
    if (removedForNum) Logger.log("Removed " + removedForNum + " duplicate line(s) for #" + numKey);
  });

  if (flaggedForReview.length) {
    Logger.log("NEEDS REVIEW - ambiguous partial duplicates, left untouched:\n  " + flaggedForReview.join("\n  "));
  }

  lineRowsToDelete.sort(function (a, b) { return b - a; }).forEach(function (row) { lin.deleteRow(row); });
  invRowsToDelete.sort(function (a, b) { return b - a; }).forEach(function (row) { inv.deleteRow(row); });
  Logger.log("Deleted " + invRowsToDelete.length + " duplicate invoice rows and " + lineRowsToDelete.length + " duplicate line rows.");
}
