/* Orders.gs with Apps Script stubbed: venue acceptance and the emailed order for each venue. */
const fs=require("fs"); let PASS=0,FAIL=0;
const ok=(n,c,x)=>{ if(c){PASS++;console.log("  ok   "+n);} else {FAIL++;console.log("  FAIL "+n+(x!==undefined?"  ["+JSON.stringify(x)+"]":""));} };
// in-memory sheet
const sheets={};
function sheet(name){ return sheets[name]=sheets[name]||{rows:[],getLastRow(){return this.rows.length;},getLastColumn(){return this.rows.length?this.rows[0].length:0;},
  appendRow(r){this.rows.push(r);}, setFrozenRows(){}, getRange(r,c,nr,nc){const self=this;return {setValues(v){for(let i=0;i<v.length;i++) self.rows[r-1+i]=v[i];return this;},setFontWeight(){return this;},clearContent(){return this;},getValues(){return self.rows.slice(r-1,r-1+(nr||1)).map(x=>x.slice(c-1,c-1+(nc||x.length)));},
  getDisplayValues(){return this.getValues().map(x=>x.map(String));}};}, getName(){return name;}, deleteRow(){},
  getDataRange(){const self=this;return {getValues(){return self.rows.map(r=>r.slice());}};}}; }
const book={getSheetByName:n=>sheets[n]||null, insertSheet:n=>sheet(n)};
global.SpreadsheetApp={openById:()=>book, getActive:()=>book};
global.PropertiesService={getScriptProperties:()=>({getProperty:k=>k==="ORDER_PIN"?"1234":null,setProperty(){}}),getUserProperties:()=>({getProperty:()=>null,setProperty(){}})};
global.CacheService={getScriptCache:()=>({get:()=>null,put(){}})};
global.LockService={getScriptLock:()=>({waitLock(){},releaseLock(){},tryLock:()=>true})};
global.ContentService={createTextOutput:s=>({setMimeType(){return {body:s};}}),MimeType:{JSON:"json"}};
const SENT=[]; global.MailApp={sendEmail:o=>SENT.push(o)};
global.Session={getActiveUser:()=>({getEmail:()=>"me@test"}),getScriptTimeZone:()=>"Australia/Hobart"};
global.Logger={log(){}}; global.Utilities={formatDate:()=>"20260916"};
// real code path: a rep email configured in SupplierSettings
sheet("SupplierSettings").rows.push(["supplier","rep_email","visible","portal_only","cc","note","updated_by","updated_at"],["Fresh Cut","rep@freshcut.example","yes","no","","","",""]);
const src=fs.readFileSync(process.argv[2]||"/home/claude/ghq/Orders.gs","utf8");
eval(src+"\n;global.__x={validateOrder_,favourite_,send_,place_,OB_STORES,OB_VENUE,OB_BUILD,supplierEmail_,tab_};");
const x=global.__x;
const order=(venue)=>({order_id:"o"+venue.replace(/\W/g,""),supplier:"Fresh Cut",venue,order_date:"2026-09-16",subtotal:80,gst:0,total:80,channel:"email",lines:[{item_code:"",description:"Bananas",unit:"kg",qty:8,unit_price:10,line_total:80}]});

ok("build bumped", /^gs-v10-/.test(x.OB_BUILD), x.OB_BUILD);
ok("OB_STORES has three venues", x.OB_STORES.length===3 && x.OB_STORES.indexOf("Red Square Glenorchy")>-1);
ok("every store has an OB_VENUE entry", x.OB_STORES.every(v=>x.OB_VENUE[v]&&x.OB_VENUE[v].addr&&x.OB_VENUE[v].signoff));
ok("validate: Glenorchy accepted", !x.validateOrder_(order("Red Square Glenorchy")).error, x.validateOrder_(order("Red Square Glenorchy")).error);
ok("validate: Cambridge still accepted", !x.validateOrder_(order("Red Square Cambridge")).error);
ok("validate: unknown venue rejected", /unknown venue/.test(x.validateOrder_(order("Red Square Hobart")).error||""));
ok("favourite: Glenorchy accepted", x.favourite_({fav_id:"f9",fav_name:"g",venue:"Red Square Glenorchy",supplier:"Fresh Cut",lines:[{item_key:"k",description:"Bananas",unit:"kg",qty:1}]},"tam").ok===true);
ok("favourite: unknown venue rejected", /unknown venue/.test(x.favourite_({fav_id:"f8",fav_name:"g",venue:"Nowhere",supplier:"Fresh Cut",lines:[]},"tam").error||""));

// send for each venue — check body
const r1=send_(order("Red Square Glenorchy"),"Tam");
ok("send: Glenorchy logged and sent", r1.ok&&r1.sent===true, r1);
const b1=SENT[SENT.length-1];
ok("send: Glenorchy subject", /Order — Red Square Glenorchy — 2026-09-16/.test(b1.subject), b1.subject);
ok("send: Glenorchy address in body", /Deliver to: 3\/2 Howard Road, Glenorchy TAS 7010/.test(b1.body));
ok("send: Glenorchy signoff, no Luma", /Red Square Cafe Glenorchy/.test(b1.body) && !/Luma/.test(b1.body), b1.body.split("\n").slice(-4));
ok("send: company and accounts lines kept", /B & G Fitness Pty Ltd\nRed Square Cafe Glenorchy\naccounts@redsquarecafe.com.au/.test(b1.body));
const r2=send_(order("Luma Kitchen"),"Ange"); const b2=SENT[SENT.length-1]; ok("send: Luma sent", r2.ok&&r2.sent===true&&SENT.length===2, r2);
ok("send: Luma keeps the Cambridge signoff", /Red Square Cafe \| Luma Kitchen/.test(b2.body) && /66 Kennedy Drive/.test(b2.body), b2.body.split("\n").slice(-6));
ok("send: rows written with venue", sheets.Orders.rows.filter(r=>r[3]==="Red Square Glenorchy").length===2 /* place + sent */, sheets.Orders.rows.map(r=>r[1]+"/"+r[3]));
console.log(`\n${PASS} passed, ${FAIL} failed`); process.exit(FAIL?1:0);
