/**
 * READ-ONLY. Follow-up to inspectDeputySalary().
 *
 * That run established two things: Timesheet carries an EmployeeAgreement id, and the
 * pay lines for an UNCOSTED timesheet carry a real Rate (32.4519 = $67,500 / 2080) plus a
 * PayRate label reading "DP_SAL Annual Salary $67,5...". So the money exists; Deputy just
 * never writes it into Timesheet.Cost for salaried people.
 *
 * What is still unknown, and what this asks:
 *   1. Is EmployeeAgreement.AnnualSalary actually POPULATED for current salaried staff?
 *      The only sample so far was agreement Id 1 - Adrian's own, inactive, from 2010,
 *      with AnnualSalary null. That proves nothing about the people we care about.
 *   2. Of the 24-in-60 uncosted timesheets, how many are salaried and how many are just
 *      hourly-not-yet-exported? They look identical on the timesheet. Getting this wrong
 *      means inventing a salary for a casual.
 *   3. Does this install use leave timesheets (IsLeave)? If it does, processDeputy is
 *      currently putting people on the floor while they are on holiday.
 *
 * Writes nothing. Log is deliberately compact - long pastes arrive empty.
 */
function inspectDeputySalaryRates() {
  var tz = Session.getScriptTimeZone();
  var to = new Date(), from = new Date(to.getTime() - 14 * 864e5);
  var f = Utilities.formatDate(from, tz, "yyyy-MM-dd"), t = Utilities.formatDate(to, tz, "yyyy-MM-dd");

  var ts;
  try {
    ts = dpPost_("/resource/Timesheet/QUERY", {
      search: { s1: { field: "Date", data: f, type: "ge" },
                s2: { field: "Date", data: t, type: "le" } },
      join: ["EmployeeObject"], max: 500
    });
  } catch (e) { Logger.log("FAILED: " + e); return; }
  if (!ts || !ts.length) { Logger.log("No timesheets " + f + " to " + t + "."); return; }

  var zero = ts.filter(function (x) { return !Number(x.Cost); });
  Logger.log("=== " + zero.length + " uncosted of " + ts.length + ", " + f + " to " + t + " ===");

  /* ---- 1. leave ------------------------------------------------------------------- */
  var leave = ts.filter(function (x) { return x.IsLeave; });
  Logger.log("IsLeave timesheets: " + leave.length +
             (leave.length ? "  <-- these are NOT shifts on the floor" : "  (feature unused here)"));
  if (leave.length) {
    var l = leave[0];
    Logger.log("  sample: " + ((l.EmployeeObject && l.EmployeeObject.DisplayName) || l.Employee) +
               "  " + l.Date + "  TotalTime " + l.TotalTime + "  Start " + l.StartTime +
               "  Cost " + l.Cost + "  LeaveRule " + l.LeaveRule);
  }

  /* ---- 2. agreements behind the uncosted shifts ------------------------------------ */
  var agIds = [], seenAg = {};
  zero.forEach(function (x) {
    var a = x.EmployeeAgreement;
    if (a && !seenAg[a]) { seenAg[a] = 1; agIds.push(a); }
  });
  Logger.log("\n=== EmployeeAgreement for the uncosted (" + agIds.length + " distinct) ===");
  var agById = {};
  for (var i = 0; i < agIds.length; i += 100) {
    try {
      var ags = dpPost_("/resource/EmployeeAgreement/QUERY", {
        search: { s1: { field: "Id", data: agIds.slice(i, i + 100), type: "in" } }, max: 200 });
      (ags || []).forEach(function (a) { agById[a.Id] = a; });
    } catch (e) { Logger.log("  agreement lookup failed: " + e); }
  }

  // One line per uncosted PERSON, not per shift - that is the whole question in one table.
  var byEmp = {};
  zero.forEach(function (x) {
    var name = (x.EmployeeObject && x.EmployeeObject.DisplayName) || String(x.Employee);
    var e = byEmp[name] || (byEmp[name] = { hours: 0, n: 0, ag: x.EmployeeAgreement,
                                            sample: { id: x.Id, who: name, h: x.TotalTime } });
    e.hours += Number(x.TotalTime) || 0; e.n++;
  });
  var salaried = 0, hourly = 0, unknown = 0, pick = {};
  Object.keys(byEmp).sort().forEach(function (name) {
    var e = byEmp[name], a = agById[e.ag] || {};
    var ann = a.AnnualSalary, spr = a.SalaryPayRule;
    /* Three outcomes, and they need different code downstream:
       - AnnualSalary on the agreement      -> read it straight, best case
       - SalaryPayRule set but AnnualSalary null -> salaried, but the figure is on the RULE,
         so we have to resolve PayRules or fall back to an override tab for these people
       - BaseRate set, no salary rule       -> ordinary hourly, just not exported yet */
    var verdict = (Number(ann) > 0) ? "SALARIED (on agreement)"
                : (Number(spr) > 0 && !Number(a.BaseRate)) ? "SALARIED (figure on rule only)"
                : (Number(a.BaseRate) > 0) ? "hourly (not exported)"
                : "?? undetermined";
    if (verdict.slice(0, 8) === "SALARIED") salaried++;
    else if (verdict.charAt(0) === "h") hourly++; else unknown++;
    if (!pick[verdict]) pick[verdict] = e.sample;      // one worked example of each
    Logger.log("  " + name + "  |  " + e.n + " shift(s), " + e.hours.toFixed(1) + "h" +
               "  |  ag " + e.ag +
               "  AnnualSalary " + ann + "  BaseRate " + a.BaseRate +
               "  SalaryPayRule " + spr + "  EmpType " + a.EmpType +
               "  Active " + a.Active + "  |  " + verdict);
  });
  Logger.log("  --> salaried " + salaried + ", hourly-unexported " + hourly + ", undetermined " + unknown);

  /* ---- 3. the pay lines, in full this time ----------------------------------------- */
  // The last run truncated PayReturnDetail at 600 chars, which cut off the rate label.
  Logger.log("\n=== pay lines, one worked example per category ===");
  var payRuleIds = [], seenPR = {};
  // One per verdict, not the first two. In testing the first two both landed on the same
  // kind of employee, which would have proved nothing.
  Object.keys(pick).forEach(function (verdict) {
    var s = pick[verdict];
    if (!s) return;
    try {
      var pr = dpPost_("/resource/TimesheetPayReturn/QUERY", {
        search: { s1: { field: "Timesheet", data: s.id, type: "eq" } }, max: 10 });
      Logger.log("  [" + verdict + "] " + s.who + " (ts " + s.id + ", " + s.h + "h):");
      (pr || []).forEach(function (p) {
        if (p.PayRule && !seenPR[p.PayRule]) { seenPR[p.PayRule] = 1; payRuleIds.push(p.PayRule); }
        Logger.log("     PayRule " + p.PayRule + "  Value " + p.Value + "  Cost " + p.Cost);
        (p.PayReturnDetail || []).forEach(function (d) {
          // Rate x Value is the figure Deputy's own wage report is built from.
          Logger.log("       Rate " + d.Rate + "  PayRate \"" + d.PayRate + "\"" +
                     "  => " + (Number(d.Rate) * Number(p.Value)).toFixed(2));
        });
      });
    } catch (err) { Logger.log("  " + s.who + " -> " + err); }
  });

  /* ---- 4. the pay rules themselves -------------------------------------------------- */
  Logger.log("\n=== PayRules referenced ===");
  if (payRuleIds.length) {
    try {
      var rules = dpPost_("/resource/PayRules/QUERY", {
        search: { s1: { field: "Id", data: payRuleIds, type: "in" } }, max: 50 });
      (rules || []).forEach(function (r) {
        Logger.log("  " + r.Id + "  \"" + r.PayTitle + "\"  RemunerationType " + r.RemunerationType +
                   "  RemunerationBy " + r.RemunerationBy +
                   "  AnnualSalary " + r.AnnualSalary + "  HourlyRate " + r.HourlyRate);
      });
    } catch (e) { Logger.log("  " + e); }
  }

  Logger.log("\nWhat this decides:");
  Logger.log("  - AnnualSalary populated on the SALARIED rows -> read salary from Deputy, no tab.");
  Logger.log("  - AnnualSalary null but PayRate carries the figure -> parse the rule, or fall");
  Logger.log("    back to a small SalaryStaff override tab for those people only.");
  Logger.log("  - IsLeave in use -> processDeputy must tag leave, not treat it as floor time.");
}
