/* eslint-disable @typescript-eslint/no-require-imports -- Electron checks an isolated synthetic web/PWA session. */
const {app,BrowserWindow,session}=require("electron");
const assert=require("node:assert/strict"),crypto=require("node:crypto"),fs=require("node:fs"),path=require("node:path"),{spawnSync}=require("node:child_process");
const {backendEnvironment,createConfig,createLocalOwnerSession,findFreePort,launchBackend,runInitializer,runtimePaths,stopBackendAndCloseConnections}=require("../desktop/runtime.js");
const root=path.resolve(__dirname,".."),directory=fs.mkdtempSync(path.join(root,"test-artifacts/workspace-ui-"));
app.setPath("userData",path.join(directory,"browser"));
const checks=[],windows=[];let child;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function evaluate(window,fn,...args){return window.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`);}
async function wait(window,fn,label){for(let attempt=0;attempt<250;attempt++){try{if(await evaluate(window,fn))return;}catch{}await delay(100);}const diagnostic=await evaluate(window,async()=>({body:document.body?.innerText.slice(0,2500),online:navigator.onLine,markerPresent:!!sessionStorage.getItem("ops-authenticated-cache-session"),tokenPresent:!!sessionStorage.getItem("ops-token"),controlled:!!navigator.serviceWorker.controller,assets:await Promise.all((await caches.keys()).map(async name=>({name,keys:(await(await caches.open(name)).keys()).map(row=>new URL(row.url).pathname)})))})).catch(()=>({pageUnavailable:true}));fs.writeFileSync(path.join(directory,"diagnostic.json"),JSON.stringify({label,...diagnostic},null,2));throw new Error("Web acceptance timeout: "+label);}
async function click(window,label){await evaluate(window,text=>{const button=[...document.querySelectorAll("button")].find(row=>row.textContent.trim()===text);if(!button)throw new Error("Missing action "+text);button.click();},label);}
function window(){const value=new BrowserWindow({show:false,width:1200,height:900,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});windows.push(value);return value;}
async function main(){
 const runtime=runtimePaths(path.join(root,"desktop/runtime")),userData=path.join(directory,"ledger"),config=createConfig(userData,"Synthetic-web-acceptance-key"),port=await findFreePort(),env=backendEnvironment(config,userData,port),base="http://127.0.0.1:"+port;
 await runInitializer(runtime,env);
 function quote(rate){const result=spawnSync(runtime.node,["-e",`const D=require('better-sqlite3');const d=new D(process.env.DB_FILE_NAME);const q=d.prepare('INSERT INTO fx_rate(currency_code,rate_to_usd,quote_date,source,fetched_at) VALUES(?,?,?,?,?) ON CONFLICT(currency_code) DO UPDATE SET rate_to_usd=excluded.rate_to_usd,quote_date=excluded.quote_date,source=excluded.source,fetched_at=excluded.fetched_at');q.run('USD','1','2026-10-13','synthetic',new Date().toISOString());q.run('CNY',${JSON.stringify(rate)},'2026-10-13','synthetic',new Date().toISOString());d.close();`],{cwd:runtime.directory,env,windowsHide:true,encoding:"utf8"});if(result.status!==0)throw new Error("Synthetic FX setup failed");}
 quote("0.14");child=await launchBackend(runtime,env);
 const ownerCookie="tam_session="+createLocalOwnerSession(config.authSecret).value;
 async function api(route,body){const r=await fetch(base+route,{method:body?"POST":"GET",headers:{Cookie:ownerCookie,Origin:base,...(body?{"Content-Type":"application/json"}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});const v=await r.json();assert(r.ok,v.error?.message||"Synthetic API failed");return v;}
 const command=(type,payload)=>api("/api/operations/commands",{id:crypto.randomUUID(),type,payload});
 const privateName="Synthetic private customer "+crypto.randomUUID().slice(0,8);
 let result=await command("customer.save",{name:privateName});const customer=result.snapshot.customers[0];
 result=await command("subscription.save",{name:"Synthetic CNY service",service:"Example",currency:"CNY",amountMinor:10000,period:{unit:"month",count:1},startDate:"2026-10-01",capacity:1});const subscription=result.snapshot.subscriptions[0];
 result=await command("bill.issue",{customerId:customer.id,subscriptionId:subscription.id,currency:"CNY",amountMinor:8000,startDate:"2026-10-01",endDate:"2026-11-01",dueDate:"2026-10-13"});const bill=result.snapshot.bills[0];
 await command("bill.void",{id:bill.id,expectedRevision:bill.revision,reason:"Synthetic no-receipt cancellation"});
 const credential=await api("/api/operations/access",{label:"Synthetic web member",role:"admin",expiresInDays:1});
 const a=window();await a.loadURL(base+"/workspace");await wait(a,()=>!!document.querySelector("input[type=password]"),"member login");
 await evaluate(a,token=>{const input=document.querySelector("input[type=password]");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,token);input.dispatchEvent(new Event("input",{bubbles:true}));input.dispatchEvent(new Event("change",{bubbles:true}));},credential.token);await click(a,"验证身份");
 await wait(a,()=>!!document.querySelector("nav[aria-label='运营功能']"),"authenticated workspace");
 await click(a,"收支对账");await wait(a,()=>document.querySelector("tbody tr")?.textContent.includes("已作废"),"void bill");
 const voidRow=await evaluate(a,()=>{const cells=document.querySelector("tbody tr").querySelectorAll("td");return {received:cells[2].innerText,state:cells[3].innerText};});
 assert(!voidRow.received.includes("80.00"));assert.equal((voidRow.received.match(/0\.00/g)||[]).length,2);assert(voidRow.state.includes("已作废"));assert(!voidRow.state.includes("已结清"));checks.push("void-bill-received-zero-and-void-state");
 await click(a,"经营分析");await wait(a,()=>!!document.querySelector(".metrics .metric strong"),"initial report");
 await wait(a,()=>[...document.querySelectorAll(".metrics .metric")].some(row=>row.textContent.includes("14.00")),"initial FX estimate");
 const initialFrom=await evaluate(a,()=>document.querySelector("input[type=date]").value);
 await evaluate(a,()=>{const input=document.querySelector("input[type=date]");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,"2025-01-01");input.dispatchEvent(new Event("input",{bubbles:true}));input.dispatchEvent(new Event("change",{bubbles:true}));});
 const reportRequests=[];a.webContents.session.webRequest.onBeforeRequest({urls:[base+"/api/operations/report*"]},(details,callback)=>{reportRequests.push(details.url);callback({});});
 quote("0.20");await click(a,"刷新");await wait(a,()=>[...document.querySelectorAll(".metrics .metric")].some(row=>row.textContent.includes("20.00")),"refreshed FX estimate");
 assert(reportRequests.some(url=>new URL(url).searchParams.get("from")===initialFrom));assert(reportRequests.every(url=>new URL(url).searchParams.get("from")!=="2025-01-01"));checks.push("report-refresh-uses-last-applied-filters-and-new-FX");
 a.webContents.session.webRequest.onBeforeRequest(null);
 await wait(a,()=>!!navigator.serviceWorker.controller,"PWA control");await evaluate(a,async()=>{await navigator.serviceWorker.ready;});await delay(1500);
 const cookies=await session.defaultSession.cookies.get({url:base,name:"tam_session"});assert.equal(cookies.length,0,"Member authentication must not leave an owner cookie");
 await evaluate(a,()=>{localStorage.setItem("ops-actor",sessionStorage.getItem("ops-actor"));});
 // Loopback bypasses Chromium network emulation on Windows. Actually stop the
 // owned synthetic service so reload and API fetch must use offline storage.
 await stopBackendAndCloseConnections(child,c=>c.kill(),async()=>{});child=null;a.webContents.reload();
 await wait(a,()=>document.body?.textContent.includes("离线显示最近一次账本"),"same-session offline snapshot");await click(a,"客户");await wait(a,()=>document.body.textContent.includes("Synthetic private customer"),"same-session private data");checks.push("authenticated-session-can-read-its-offline-snapshot");
 const b=window();await b.loadURL(base+"/workspace").catch(()=>{});await wait(b,()=>!!document.querySelector("input[type=password]"),"cold-tab requires credentials");a.destroy();
 const cold=await evaluate(b,()=>({privateVisible:document.body.textContent.includes("Synthetic private customer"),marker:sessionStorage.getItem("ops-authenticated-cache-session"),token:sessionStorage.getItem("ops-token"),persistentActor:localStorage.getItem("ops-actor")}));
 assert.equal(cold.privateVisible,false);assert.equal(cold.marker,null);assert.equal(cold.token,null);assert(cold.persistentActor);checks.push("cold-offline-tab-cannot-read-another-session-cache");
 const summary={status:"ok",visibleWindow:false,checks};fs.writeFileSync(path.join(directory,"result.json"),JSON.stringify(summary,null,2));process.stdout.write(JSON.stringify(summary)+"\n");
}
app.whenReady().then(async()=>{let code=0;try{await main();}catch(error){const failure={status:"failed",checks,error:String(error.message).slice(0,500)};fs.writeFileSync(path.join(directory,"result.json"),JSON.stringify(failure,null,2));process.stderr.write(failure.error+"\n");code=1;}finally{process.stdout.write(JSON.stringify({resultFile:path.join(directory,"result.json"),status:code===0?"ok":"failed"})+"\n");session.defaultSession.disableNetworkEmulation();for(const value of windows)if(!value.isDestroyed())value.destroy();if(child)await stopBackendAndCloseConnections(child,c=>c.kill(),async()=>{}).catch(()=>{});app.exit(code);}});
