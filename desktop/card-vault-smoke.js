/* eslint-disable @typescript-eslint/no-require-imports -- Native UI acceptance uses a fresh synthetic profile only. */
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
async function runCardVaultSmoke({ BrowserWindow, url, userData, preload, onWindow }) {
  const w = new BrowserWindow({ show: false, width: 1400, height: 1100, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload } });
  onWindow(w);
  const evaluate = (fn, ...args) => w.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`);
  const wait = async fn => { for (let i=0;i<150;i++) { if(await evaluate(fn))return;await new Promise(r=>setTimeout(r,100)); }throw Error("Synthetic card UI did not become ready"); };
  const steps = [];
  try {
    await w.loadURL(new URL("/reference-data/channels", url).href);
    await wait(() => !!window.teamAccountManagerDesktop?.cardVault && document.querySelector("h1")?.textContent === "支付渠道");
    const actionManifest = JSON.parse(fs.readFileSync(path.join(process.resourcesPath, "runtime/.next/server/server-reference-manifest.json")));
    const actionId = Object.entries(actionManifest.node).find(([,v])=>v.exportedName==="addChannel")?.[0];
    assert.ok(actionId);
    await evaluate(async id => {
      const result = await fetch("/reference-data/channels", { method:"POST",headers:{"Next-Action":id,"Content-Type":"text/plain;charset=UTF-8","Accept":"text/x-component"},body:JSON.stringify([{name:"Synthetic private card",channelType:"card",feePercent:"2"}]) });
      if (!result.ok || !(await result.text()).includes('"ok":true'))throw Error("Synthetic channel creation failed");
    }, actionId);
    await w.loadURL(new URL("/reference-data/channels", url).href);
    await wait(() => !!document.querySelector('button[aria-label="卡片资料 Synthetic private card"]'));
    await evaluate(() => document.querySelector('button[aria-label="卡片资料 Synthetic private card"]').click());
    await wait(() => !!document.querySelector('#card-cardNumber') && !document.querySelector('#card-cardNumber').disabled);
    await evaluate(() => {
      const fields = {cardNumber:"4111111111111111",cvc:"012",expiryMonth:"08",expiryYear:"2028",cardholder:"Synthetic Holder",billingAddress:"Synthetic address",postalCode:"12345",country:"US",note:"Synthetic private memo"};
      for(const [name,value]of Object.entries(fields)){const el=document.querySelector(`#card-${name}`);Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(el,value);el.dispatchEvent(new Event("input",{bubbles:true}));}
    });
    await evaluate(() => [...document.querySelectorAll('button')].find(b=>b.textContent.trim()==="加密保存").click());
    await wait(() => document.querySelector('[role=dialog]')?.textContent.includes("最近保存："));
    const hidden = await evaluate(() => document.querySelector('#card-cardNumber').type === "password" && document.querySelector('#card-cvc').type === "password" && !document.querySelector('[role=alert]'));
    assert.equal(hidden,true);steps.push("native-form-save-default-masked");
    const disk = fs.readFileSync(path.join(userData,"card-vault.bin"));
    assert.equal(disk.includes(Buffer.from("4111111111111111")),false);assert.equal(disk.includes(Buffer.from("Synthetic Holder")),false);
    await evaluate(() => [...document.querySelectorAll('button')].find(b=>b.textContent.trim()==="显示资料").click());
    assert.equal(await evaluate(() => document.querySelector('#card-cvc').type === "text" && document.querySelector('#card-cvc').value === "012"),true);
    await evaluate(() => window.dispatchEvent(new Event("blur")));
    await wait(() => document.querySelector('#card-cvc').type === "password");steps.push("reveal-and-window-blur-auto-hide");
    await w.loadURL(new URL("/reference-data/channels", url).href);
    await wait(() => !!document.querySelector('button[aria-label="卡片资料 Synthetic private card"]'));
    await evaluate(() => document.querySelector('button[aria-label="卡片资料 Synthetic private card"]').click());
    await wait(() => document.querySelector('#card-cvc')?.value === "012");
    const snapshotText=await evaluate(async()=>JSON.stringify(await(await fetch('/api/operations/snapshot',{cache:'no-store'})).json()));
    for(const secret of ["4111111111111111","Synthetic Holder","Synthetic private memo"])assert.equal(snapshotText.includes(secret),false);
    steps.push("reload-persistence-and-no-snapshot-leak");
    const result={status:"ok",steps,synthetic:true};fs.writeFileSync(path.join(userData,"card-vault-smoke-result.json"),JSON.stringify(result,null,2));return result;
  } finally { w.destroy(); }
}
module.exports={runCardVaultSmoke};
