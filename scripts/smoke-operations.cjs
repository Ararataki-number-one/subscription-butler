/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");
const { backendEnvironment, createConfig, findFreePort, launchBackend, runInitializer, runtimePaths } = require("../desktop/runtime.js");
const root = path.resolve(__dirname,"..");
fs.mkdirSync(path.join(root,"test-artifacts"),{recursive:true});
const userData = fs.mkdtempSync(path.join(root,"test-artifacts","operations-smoke-"));
async function main() {
  const runtime = runtimePaths(path.join(root,"desktop/runtime"));
  const config = createConfig(userData,"Synthetic-acceptance-login");
  const port = await findFreePort();
  const environment = backendEnvironment(config,userData,port);
  await runInitializer(runtime,environment);
  const db = new Database(path.join(userData,"data/app.db"));
  const at = new Date().toISOString();
  const quote = db.prepare("INSERT INTO fx_rate(currency_code,rate_to_usd,quote_date,source,fetched_at) VALUES(?,?,?,?,?) ON CONFLICT(currency_code) DO UPDATE SET rate_to_usd=excluded.rate_to_usd,quote_date=excluded.quote_date,source=excluded.source,fetched_at=excluded.fetched_at");
  quote.run("CNY","0.14","2026-10-13","synthetic",at);quote.run("USD","1","2026-10-13","synthetic",at);
  const payload = "v1."+(Date.now()+3600000)+"."+crypto.randomUUID();
  const cookie = "tam_session="+payload+"."+crypto.createHmac("sha256",config.authSecret).update(payload).digest("hex");
  const child = await launchBackend(runtime,environment);
  const base="http://127.0.0.1:"+port;
  let requests=0;
  async function api(route,body,options={}) {
    requests++;
    const response=await fetch(base+route,{method:options.method??(body===undefined?"GET":"POST"),headers:{...(options.public?{}:options.token?{Authorization:"Bearer "+options.token}:{Cookie:cookie}),Origin:options.origin??base,...(body===undefined?{}:{"Content-Type":"application/json"})},body:body===undefined?undefined:JSON.stringify(body),redirect:"manual",signal:AbortSignal.timeout(30000)});
    const value=await response.json();
    assert.equal(response.status,options.status??200,JSON.stringify({route,status:response.status,error:value.error}));
    return value;
  }
  async function command(type,payload,id=crypto.randomUUID(),options={}) {return api("/api/operations/commands",{id,type,payload},options);}
  try {
    await api("/api/operations/snapshot",undefined,{public:true,status:401});
    let result=await command("customer.save",{name:"Synthetic Customer A",contact:"example-contact-a"});
    const customerA=result.snapshot.customers.find(row=>row.data.name==="Synthetic Customer A");
    result=await command("customer.save",{name:"Synthetic Customer B",contact:"example-contact-b"});
    const customerB=result.snapshot.customers.find(row=>row.data.name==="Synthetic Customer B");
    result=await command("subscription.save",{name:"Synthetic shared account",service:"Example Service",planName:"Shared",currency:"USD",amountMinor:1000,feePercent:"2",period:{unit:"month",count:1},startDate:"2026-10-01",capacity:3});
    const subscription=result.snapshot.subscriptions.find(row=>row.data.name==="Synthetic shared account");
    const slots=result.snapshot.slots.filter(row=>row.data.subscriptionId===subscription.id);
    assert.equal(slots.length,3);
    result=await command("rental.join",{slotId:slots[0].id,customerId:customerA.id,usage:"rented",startDate:"2026-10-01",amountMinor:8000,currency:"CNY",period:{unit:"month",count:1}});
    let rental=result.snapshot.rentals.find(row=>row.data.customerId===customerA.id);
    const bill=result.snapshot.bills.find(row=>row.data.rentalId===rental.id);
    result=await command("rental.join",{slotId:slots[1].id,customerId:customerB.id,usage:"rented",startDate:"2026-10-01",amountMinor:9000,currency:"CNY",period:{unit:"month",count:1}});
    const renewId=crypto.randomUUID();
    const renew={id:rental.id,expectedRevision:rental.revision,expectedPeriod:rental.data.periodVersion};
    result=await command("rental.renew",renew,renewId);
    const period=result.snapshot.rentals.find(row=>row.id===rental.id).data.periodVersion;
    const duplicate=await command("rental.renew",renew,renewId);assert.equal(duplicate.replayed,true);
    assert.equal(duplicate.snapshot.rentals.find(row=>row.id===rental.id).data.periodVersion,period);
    await command("rental.renew",renew,crypto.randomUUID(),{status:409});
    result=await command("entry.receive",{billId:bill.id,amountMinor:4000,currency:"CNY",date:"2026-10-02",note:"Partial payment"});
    const receipt=result.snapshot.entries.find(row=>row.data.type==="receipt"&&row.data.billId===bill.id);
    await command("entry.refund",{sourceEntryId:receipt.id,amountMinor:1000,currency:"CNY",date:"2026-10-03",reason:"Partial refund"});
    await command("entry.cost",{subscriptionId:subscription.id,amountMinor:1000,currency:"USD",feePercent:"2",date:"2026-10-01",periodStart:"2026-10-01",periodEnd:"2026-11-01"});
    const original=(await api("/api/operations/snapshot")).snapshot.entries;
    quote.run("CNY","0.15","2026-10-14","synthetic",new Date().toISOString());
    const changed=(await api("/api/operations/snapshot")).snapshot.entries;
    assert.deepEqual(changed,original,"Historical entries changed after updating FX");
    const report=(await api("/api/operations/report?from=2026-10-01&to=2026-11-01")).report;
    assert.equal(report.receivables.bills.find(row=>row.billId===bill.id).outstandingMinor,5000);
    assert.equal(report.cash.netUsd,report.cash.incomeUsd-report.cash.costUsd);
    const invite=await api("/api/operations/access",{label:"Synthetic customer portal",role:"customer",customerId:customerA.id,expiresInDays:30},{status:201});
    const own=await api("/api/operations/snapshot",undefined,{token:invite.token});
    assert.equal(own.snapshot.customers.length,1);assert.equal(own.snapshot.customers[0].id,customerA.id);
    assert.equal(own.snapshot.subscriptions.length,0);assert.equal(own.snapshot.channels.length,0);
    assert(own.snapshot.bills.every(row=>row.data.customerId===customerA.id));
    await api("/api/operations/report?customerId="+encodeURIComponent(customerB.id),undefined,{token:invite.token,status:403});
    await command("customer.save",{name:"Forbidden"},crypto.randomUUID(),{token:invite.token,status:403});
    await api("/api/operations/access/"+invite.credential.id,undefined,{method:"DELETE"});
    await api("/api/operations/snapshot",undefined,{token:invite.token,status:401});
    await command("customer.save",{name:"CSRF should fail"},crypto.randomUUID(),{origin:"https://example.invalid",status:403});
    result=await api("/api/operations/snapshot");rental=result.snapshot.rentals.find(row=>row.id===rental.id);
    result=await command("rental.switch",{id:rental.id,expectedRevision:rental.revision,toSlotId:slots[2].id,date:"2026-10-15",reason:"Account replacement"});
    rental=result.snapshot.rentals.find(row=>row.id===rental.id);
    result=await command("rental.exit",{id:rental.id,expectedRevision:rental.revision,date:"2026-10-20",reason:"Contract ended"});
    rental=result.snapshot.rentals.find(row=>row.id===rental.id);
    assert.equal(rental.data.status,"ended");assert(rental.data.history.some(event=>event.type==="join"));assert(rental.data.history.some(event=>event.type==="renew"));assert(rental.data.history.some(event=>event.type==="switch"));assert(rental.data.history.some(event=>event.type==="exit"));
    for(const headers of [{},{Cookie:cookie}]) {
      const page=await fetch(base+"/workspace",{headers,signal:AbortSignal.timeout(30000)});assert.equal(page.status,200);
      const html=await page.text();assert(!html.includes("Synthetic Customer A"),"Public shell rendered private customer data");
    }
    console.log(JSON.stringify({operationsSmoke:"passed",requests,customerRentalLifecycle:true,retryIdempotency:true,partialRefundReconciles:true,historicalFxFrozen:true,customerIsolationAndRevocation:true,publicShellContainsNoLedger:true}));
  } finally {db.close();child.kill();if(child.exitCode===null)await new Promise(resolve=>child.once("exit",resolve));}
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
