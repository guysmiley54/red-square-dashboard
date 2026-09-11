/** Reports which copy of the salary code Apps Script is actually running.
 *  Duplicate function names across .gs files are legal JavaScript - the last one loaded
 *  wins, with no warning - so the editor can show you new code while the project runs old
 *  code. This asks the live function object rather than trusting what is on screen. */
function whichBuild() {
  var src = String(dpAllocateSalary_);
  Logger.log(src.indexOf("SALARY_DAYS") > -1
    ? "LIVE: NEW build - salary split into equal days, rate column written."
    : "LIVE: OLD build - salary split by hours. A stale copy is shadowing Code.gs.");
  Logger.log("DP.SALARY_DAYS = " + DP.SALARY_DAYS +
             "   (undefined means the old build is winning)");
  Logger.log("Files in this project: check the left panel. Anything other than Code.gs " +
             "holding a processDeputy_ or dpAllocateSalary_ must be deleted.");
}
