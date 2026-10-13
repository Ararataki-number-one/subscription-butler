"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { logout } from "@/actions/auth";
import type { OperationsSnapshot, OpsActor, OpsCommand, OpsRecord, OperationsReport, RentalData, BillData, EntryData, FxQuote } from "@/lib/operations/types";
import { CURRENCIES } from "@/lib/currencies";
import { formatMinor, parseToMinor, convertCurrencyMinor } from "@/lib/money";
import { paymentFee } from "@/lib/payment-fees";
import { previewCsv, writeCsv, type CsvPreview } from "@/lib/workspace/csv";
import { cachedSnapshot, cacheSnapshot, clearOfflineData, clearSnapshotCache, dequeue, enqueue, queued } from "@/lib/workspace/offline";
import { calendarDays, dueCategory, outstandingMinor, shanghaiToday, workbench } from "@/lib/workspace/view-model";
import { IdentityScope, StaleIdentityError } from "@/lib/workspace/identity";
import "./workspace.css";

type Tab = "today"|"customers"|"subscriptions"|"rentals"|"ledger"|"reports"|"calendar"|"exchange"|"sync";
type Envelope = {actor:OpsActor;snapshot:OperationsSnapshot;quotes?:FxQuote[]};
type Field = {key:string;label:string;type?:string;options?:{value:string;label:string;feePercent?:string}[];value?:string|number;required?:boolean;wide?:boolean};
type Editor = {title:string;type:string;fields:Field[];base?:Record<string,unknown>;transform?:(values:Record<string,string>)=>Record<string,unknown>};
type AccessCredential = {id:string;label:string;role:string;customerId?:string;createdAt:string;expiresAt:string;revokedAt?:string};
type SyncStatus = {deviceId:string;connected:boolean;url?:string;pending:number;conflicts:number};
type Conflict = {id:string;commandId:string;local:unknown;remote:unknown;reason:string;createdAt:string};
const tabs:{id:Tab;name:string}[] = [{id:"today",name:"今日工作台"},{id:"customers",name:"客户"},{id:"subscriptions",name:"订阅与位置"},{id:"rentals",name:"租期"},{id:"ledger",name:"收支对账"},{id:"reports",name:"经营分析"},{id:"calendar",name:"续费日历"},{id:"exchange",name:"导入导出"},{id:"sync",name:"设备与权限"}];
const currencyOptions = CURRENCIES.map(row=>({value:row.code,label:row.code + " · " + row.name}));
const exponent = (currency:string) => CURRENCIES.find(row=>row.code === currency)?.minorUnit ?? 2;
const money = (value:number|null,currency="CNY") => value == null ? "待补充汇率" : `${currency === "CNY" ? "¥" : currency === "USD" ? "$" : currency + " "}${formatMinor(value,exponent(currency))}`;
const dateField = (key:string,label:string,value=shanghaiToday()):Field => ({key,label,type:"date",value,required:true});
const option = (key:string,label:string,rows:{id:string;data:{name?:string;label?:string}}[],value?:string):Field => ({key,label,type:"select",options:rows.map(row=>({value:row.id,label:row.data.name ?? row.data.label ?? row.id})),value,required:true});
const amountField = (value=0,currency="CNY"):Field => ({key:"amount",label:"金额（原币）",value:formatMinor(value,exponent(currency)),required:true,type:"text"});
const periodFields = (period={unit:"month",count:1}):Field[] => [{key:"periodUnit",label:"周期单位",type:"select",value:period.unit,options:[{value:"day",label:"天"},{value:"month",label:"月"},{value:"quarter",label:"季度"},{value:"year",label:"年"}]},{key:"periodCount",label:"周期数量",type:"number",value:period.count,required:true}];
const billingTransform = (values:Record<string,string>) => ({amountMinor:parseToMinor(values.amount,exponent(values.currency)),currency:values.currency,period:{unit:values.periodUnit,count:Number(values.periodCount)}});

function download(name:string,content:string,type="text/csv;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([content],{type}));
  const anchor = document.createElement("a"); anchor.href=url; anchor.download=name; anchor.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function Rows({headers,children}:{headers:string[];children:ReactNode}) { return <div className="table-wrap"><table><thead><tr>{headers.map(text=><th key={text}>{text}</th>)}</tr></thead><tbody>{children}</tbody></table></div>; }
function Empty({cols=1}:{cols?:number}) { return <tr><td colSpan={cols} className="muted">暂无记录</td></tr>; }
function EditorDialog({editor,busy,onClose,onSubmit}:{editor:Editor;busy:boolean;onClose:()=>void;onSubmit:(command:OpsCommand)=>Promise<void>}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(()=>{ref.current?.showModal();},[]);
  const [error,setError] = useState("");
  const commandId = useRef(crypto.randomUUID());
  async function submit(event:FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError("");
    const values = Object.fromEntries(new FormData(event.currentTarget).entries()) as Record<string,string>;
    try {
      const payload = {...editor.base,...values,...editor.transform?.(values)};
      if(values.channelId==="")delete payload.channelId;
      await onSubmit({id:commandId.current,type:editor.type,payload});
      onClose();
    } catch(error) { setError(error instanceof Error ? error.message : "保存失败。"); }
  }
  return <dialog ref={ref} onCancel={onClose}><form onSubmit={submit}><div className="bar end"><h2 style={{margin:0}}>{editor.title}</h2><button type="button" onClick={onClose}>关闭</button></div><div className="fields">{editor.fields.map(field=><label key={field.key} className={field.wide?"wide":""}>{field.label}{field.type === "select" ? <select name={field.key} defaultValue={field.value ?? ""} required={field.required} onChange={event=>{if(field.key==="channelId"){const fee=field.options?.find(row=>row.value===event.target.value)?.feePercent;const input=event.currentTarget.form?.elements.namedItem("feePercent") as HTMLInputElement|null;if(input&&fee!==undefined)input.value=fee;}}}><option value="">请选择</option>{field.options?.map(item=><option value={item.value} key={item.value}>{item.label}</option>)}</select> : field.type === "textarea" ? <textarea name={field.key} defaultValue={field.value} rows={3}/> : <input name={field.key} type={field.type ?? "text"} defaultValue={field.value} required={field.required} min={field.type === "number"?0:undefined}/>}</label>)}</div>{error && <p role="alert" className="notice error">{error}</p>}<p className="muted">{editor.type.includes("renew") ? "续租生成新账期，实际收款请另行登记。" : "金额和日期按表单保存，操作记录可在历史中查看。"}</p><div className="bar" style={{justifyContent:"flex-end",marginTop:16}}><button type="button" onClick={onClose}>取消</button><button className="primary" disabled={busy}>保存</button></div></form></dialog>;
}

export function Workspace() {
  const router=useRouter();
  const [envelope,setEnvelope] = useState<Envelope|null>(null);
  const [tab,setTab] = useState<Tab>("today");
  const [search,setSearch] = useState("");
  const [view,setView] = useState("all");
  const [message,setMessage] = useState("");
  const [error,setError] = useState("");
  const [busy,setBusy] = useState(false);
  const [offline,setOffline] = useState(false);
  const [desktopMode,setDesktopMode] = useState(false);
  const [pending,setPending] = useState(0);
  const [pendingCommands,setPendingCommands] = useState<Awaited<ReturnType<typeof queued>>>([]);
  const [token,setToken] = useState("");
  const [tokenInput,setTokenInput] = useState("");
  const [editor,setEditor] = useState<Editor|null>(null);
  const [selected,setSelected] = useState<OpsRecord|null>(null);
  const [selectedRentals,setSelectedRentals] = useState<string[]>([]);
  const [selectedSlots,setSelectedSlots] = useState<string[]>([]);
  const [calendarMonth,setCalendarMonth] = useState(shanghaiToday().slice(0,7));
  const [report,setReport] = useState<OperationsReport|null>(null);
  const [range,setRange] = useState({from:shanghaiToday().slice(0,7)+"-01",to:shanghaiToday()});
  const [reportSubscription,setReportSubscription] = useState("");
  const [reportCustomer,setReportCustomer] = useState("");
  const [reportChannel,setReportChannel] = useState("");
  const [csvKind,setCsvKind] = useState("customers");
  const [csvText,setCsvText] = useState("");
  const [csvPreview,setCsvPreview] = useState<CsvPreview|null>(null);
  const [credentials,setCredentials] = useState<AccessCredential[]>([]);
  const [newToken,setNewToken] = useState("");
  const [syncStatus,setSyncStatus] = useState<SyncStatus|null>(null);
  const [conflicts,setConflicts] = useState<Conflict[]>([]);
  const [audit,setAudit] = useState<unknown[]>([]);
  const snapshot = envelope?.snapshot;
  const actor = envelope?.actor;
  const writable = actor?.role === "admin" || actor?.role === "operator";
  const owner = actor?.role === "admin";
  const [today,setToday] = useState("");
  const inflight = useRef(false);
  const initialized = useRef(false);
  const activeToken = useRef("");
  const quoteCache = useRef<FxQuote[]>([]);
  const identity=useRef(new IdentityScope());
  const identityTransition=useRef(false);
  const resetIdentityViews=useCallback(()=>{setEnvelope(null);setSelected(null);setEditor(null);setReport(null);setCredentials([]);setNewToken("");setAudit([]);setConflicts([]);setSyncStatus(null);setSelectedRentals([]);setSelectedSlots([]);setPendingCommands([]);setTab("today");setSearch("");setCsvText("");setCsvPreview(null);setReportSubscription("");setReportCustomer("");setReportChannel("");quoteCache.current=[];},[]);
  const headers = useCallback(():Record<string,string>=>activeToken.current ? {Authorization:"Bearer " + activeToken.current} : {},[]);

  const request = useCallback(async (url:string,body?:unknown,method?:string) => {
    if(identityTransition.current)throw new StaleIdentityError();
    return identity.current.guard(async()=>{
    const response = await fetch(url,{method:method ?? (body===undefined ? "GET":"POST"),headers:{...headers(),...(body===undefined?{}:{"Content-Type":"application/json"})},body:body===undefined?undefined:JSON.stringify(body),cache:"no-store",signal:AbortSignal.timeout(20000)});
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error?.message ?? data.error ?? data.message ?? "请求失败，请重试。"),{status:response.status,code:data.error?.code});
    return data;
    });
  },[headers]);
  const accept = useCallback(async (value:Envelope) => {
    if(value.quotes!==undefined) quoteCache.current=value.quotes;
    value={...value,quotes:quoteCache.current};
    setEnvelope(value); setOffline(false);
    sessionStorage.setItem("ops-actor",value.actor.id);
    localStorage.setItem("ops-actor",value.actor.id);
    sessionStorage.setItem("ops-role",value.actor.role);
    await cacheSnapshot(value.actor.id,value).catch(()=>undefined);
    setPending((await queued(value.actor.id).catch(()=>[])).length);
  },[]);
  const refresh = useCallback(async () => {
    setToday(shanghaiToday());
    try { await accept(await request("/api/operations/snapshot")); setError(""); }
    catch (failure) {
      if(failure instanceof StaleIdentityError)return;
      if(failure instanceof Error && "status" in failure && failure.status===401){
        identity.current.advance();resetIdentityViews();setPending(0);
        await clearSnapshotCache().catch(()=>undefined);
        sessionStorage.removeItem("ops-actor");localStorage.removeItem("ops-actor");
      }
      const actorId = sessionStorage.getItem("ops-actor") ?? localStorage.getItem("ops-actor");
      if (actorId && (!navigator.onLine || failure instanceof TypeError || failure instanceof DOMException && ["AbortError","TimeoutError"].includes(failure.name))) {
        const cached = await cachedSnapshot(actorId).catch(()=>undefined);
        if (cached) {const value=cached.value as Envelope;quoteCache.current=value.quotes??[];setEnvelope(value);setOffline(true);setPending((await queued(actorId)).length);setMessage("离线显示最近一次账本，操作将在重新连接并验证身份后提交。");return;}
      }
      setError(failure instanceof Error ? failure.message : "无法读取账本。");
    }
  },[accept,request,resetIdentityViews]);
  const flush = useCallback(async () => {
    if (inflight.current) return;
    const checkIdentity=identity.current.checkpoint();
    const value:Envelope = await request("/api/operations/snapshot");
    await accept(value);
    const commands = await queued(value.actor.id);
    checkIdentity();
    inflight.current=true;
    try {
      for (const item of commands) {
        checkIdentity();
        const result = await request(item.command.type==="import.commit"?"/api/operations/import":"/api/operations/commands",item.command);
        await dequeue(item.id); await accept(result);
      }
      setPending((await queued(value.actor.id)).length);setMessage("待提交操作已处理。");
    } finally {inflight.current=false;}
  },[accept,request]);
  useEffect(()=>{
    if (initialized.current) return;
    initialized.current=true;
    setDesktopMode(windowDesktop());
    activeToken.current=sessionStorage.getItem("ops-token") ?? "";setToken(activeToken.current);
    void refresh();
    if ("serviceWorker" in navigator && !windowDesktop()) void navigator.serviceWorker.register("/operations-sw.js",{scope:"/workspace"}).catch(()=>undefined);
  },[refresh]);
  useEffect(()=>{
    const online = ()=>{setOffline(false);void flush().catch(failure=>setError(failure.message));};
    const off = ()=>setOffline(true);
    window.addEventListener("online",online);window.addEventListener("offline",off);
    const timer=setInterval(()=>{if(navigator.onLine && !inflight.current) void refresh();},300000);
    return ()=>{window.removeEventListener("online",online);window.removeEventListener("offline",off);clearInterval(timer);};
  },[flush,refresh]);
  useEffect(()=>{if(actor)void queued(actor.id).then(setPendingCommands).catch(()=>setPendingCommands([]));},[actor,pending]);
  async function run(command:OpsCommand) {
    if (!actor || !writable) throw new Error("当前身份没有写入权限。");
    if (inflight.current) throw new Error("请等待当前操作完成。");
    setBusy(true);setError("");inflight.current=true;
    const checkIdentity=identity.current.checkpoint();
    try {
      // A desktop's loopback service remains reachable without Internet. Try
      // the service first; only a failed connection goes into browser storage.
      try {const result=await request(command.type==="import.commit"?"/api/operations/import":"/api/operations/commands",command);checkIdentity();await accept(result);checkIdentity();setMessage(result.queued?"同步服务暂不可用，操作已保存在本机待上传队列，尚未计入账本。":"已保存。续租与实际收款分别记录。");}
      catch(failure) {
        if (failure instanceof TypeError || failure instanceof DOMException && ["AbortError","TimeoutError"].includes(failure.name)) {await enqueue(actor.id,command);setPending((await queued(actor.id)).length);setOffline(true);setMessage("连接中断，操作已保留，将使用相同编号重试。");return;}
        throw failure;
      }
    } finally {inflight.current=false;setBusy(false);}
  }
  function execute(type:string,payload:Record<string,unknown>) {void run({id:crypto.randomUUID(),type,payload}).catch(failure=>setError(failure.message));}
  function matches(record:OpsRecord) {return !search || JSON.stringify(record.data).toLowerCase().includes(search.toLowerCase()) || record.id.toLowerCase().includes(search.toLowerCase());}
  const name = (id:string|undefined) => !snapshot ? "—" : snapshot.customers.find(row=>row.id === id)?.data.name ?? snapshot.subscriptions.find(row=>row.id === id)?.data.name ?? snapshot.slots.find(row=>row.id === id)?.data.label ?? id ?? "—";
  function fieldsBase(record?:OpsRecord) {return record ? {id:record.id,expectedRevision:record.revision}:{};}
  function customerEditor(record?:OperationsSnapshot["customers"][number]) {
    setEditor({title:record?"编辑客户":"新增客户",type:"customer.save",base:fieldsBase(record),fields:[{key:"name",label:"客户名称",required:true,value:record?.data.name},{key:"contact",label:"联系方式",value:record?.data.contact},{key:"email",label:"联系邮箱",type:"email",value:record?.data.email},{key:"group",label:"分组",value:record?.data.group},{key:"tagsText",label:"标签（逗号分隔）",value:record?.data.tags.join(",")},{key:"note",label:"备注",type:"textarea",wide:true,value:record?.data.note}],transform:values=>({tags:values.tagsText.split(/[,，]/).map(value=>value.trim()).filter(Boolean)})});
  }
  function subscriptionEditor(record?:OperationsSnapshot["subscriptions"][number],templateId?:string) {
    const template=snapshot?.templates.find(row=>row.id===templateId)?.data;
    const data=record?.data ?? template;
    setEditor({title:record?"编辑订阅":"新增订阅",type:"subscription.save",base:{...fieldsBase(record),...(templateId?{templateId}:{}),status:record?.data.status??"active"},fields:[{key:"name",label:"订阅名称",required:true,value:data?.name},{key:"service",label:"服务名称",required:true,value:data?.service??"ChatGPT"},{key:"planName",label:"套餐名称",value:data?.planName??""},{key:"account",label:"登录邮箱 / 账号",value:record?.data.account},{key:"currency",label:"原币",type:"select",options:currencyOptions,value:data?.currency??"CNY",required:true},amountField(data?.amountMinor,data?.currency),{key:"channelId",label:"支付渠道（可选）",type:"select",value:record?.data.channelId??"",options:(snapshot?.channels??[]).filter(row=>row.isActive||row.id===record?.data.channelId).map(row=>({value:String(row.id),label:row.name,feePercent:row.feePercent}))},{key:"feePercent",label:"支付手续费（%）",value:data?.feePercent??"0"},...periodFields(data?.period),dateField("startDate","本期开始日",record?.data.startDate??today),{key:"capacity",label:"可用位置数量（新建时）",type:"number",value:template?.capacity??1},{key:"allocation",label:"成本归属",type:"select",options:[{value:"daily",label:"按账期天数"},{value:"fixed",label:"按固定位置份额"},{value:"fixed-amount",label:"按固定金额"}],value:data?.allocation??"daily"},{key:"group",label:"分组",value:data?.group},{key:"tagsText",label:"标签（逗号分隔）",value:data?.tags.join(",")},{key:"note",label:"备注",type:"textarea",value:data?.note,wide:true}],transform:values=>({...billingTransform(values),capacity:Number(values.capacity),tags:values.tagsText.split(/[,，]/).map(value=>value.trim()).filter(Boolean)})});
  }
  function templateEditor(record?:OperationsSnapshot["templates"][number]) {
    setEditor({title:record?"编辑套餐模板":"新增套餐模板",type:"template.save",base:fieldsBase(record),fields:[{key:"name",label:"模板名称",required:true,value:record?.data.name},{key:"service",label:"服务名称",required:true,value:record?.data.service??"ChatGPT"},{key:"planName",label:"套餐名称",value:record?.data.planName},{key:"capacity",label:"默认位置数",type:"number",value:record?.data.capacity??1},{key:"currency",label:"原币",type:"select",value:record?.data.currency??"CNY",options:currencyOptions},amountField(record?.data.amountMinor,record?.data.currency),{key:"feePercent",label:"手续费（%）",value:record?.data.feePercent??"0"},...periodFields(record?.data.period),{key:"allocation",label:"成本归属",type:"select",value:record?.data.allocation??"daily",options:[{value:"daily",label:"按天分摊"},{value:"fixed",label:"按固定位置份额"},{value:"fixed-amount",label:"按固定金额"}]}],transform:values=>({...billingTransform(values),capacity:Number(values.capacity)})});
  }
  function slotEditor(record?:OperationsSnapshot["slots"][number]) {
    setEditor({title:record?"编辑位置":"新增可用位置",type:"slot.save",base:fieldsBase(record),fields:[option("subscriptionId","所属订阅",snapshot?.subscriptions??[],record?.data.subscriptionId),{key:"label",label:"位置名称",required:true,value:record?.data.label},{key:"account",label:"登录邮箱 / 使用账号",value:record?.data.account},{key:"kind",label:"位置类别",type:"select",value:record?.data.kind??"generic",options:[{value:"mother",label:"母号"},{value:"child",label:"子账号"},{value:"member",label:"拼车成员"},{value:"generic",label:"通用位置"}]},{key:"weight",label:"成本分摊权重",type:"number",value:record?.data.weight??1},{key:"fixedAmount",label:"固定分摊额（订阅原币 / 每周期）",value:formatMinor(record?.data.fixedCostMinor??0,exponent(snapshot?.subscriptions.find(row=>row.id===record?.data.subscriptionId)?.data.currency??"CNY"))},{key:"status",label:"状态",type:"select",value:record?.data.status??"available",options:[{value:"available",label:"可用"},{value:"disabled",label:"停用"}]}],transform:values=>({weight:Number(values.weight),fixedCostMinor:parseToMinor(values.fixedAmount,exponent(snapshot?.subscriptions.find(row=>row.id===values.subscriptionId)?.data.currency??"CNY"))})});
  }
  function joinEditor(slotId?:string) {
    if (!snapshot) return;
    const free=workbench(snapshot,today).vacant;
    setEditor({title:"分配账号 / 位置",type:"rental.join",fields:[option("slotId","可用位置",free.map(row=>({...row,data:{label:name(row.data.subscriptionId)+" · "+row.data.label}})),slotId),{...option("customerId","客户",snapshot.customers.filter(row=>!row.data.archived)),required:false},{key:"usage",label:"使用方式",type:"select",value:"rented",options:[{value:"rented",label:"出租"},{value:"self",label:"自用"}]},dateField("startDate","加入日期"),{key:"currency",label:"约定收费币种",type:"select",value:"CNY",options:currencyOptions},amountField(),...periodFields(),{key:"note",label:"备注",type:"textarea",wide:true}],transform:billingTransform});
  }
  function rentalEditor(record:OpsRecord<RentalData>,action:"renew"|"exit"|"switch") {
    if (!snapshot) return;
    setEditor({title:action==="renew"?"续租（不登记收款）":action==="exit"?"退出租赁":"更换使用账号",type:"rental."+action,base:{...fieldsBase(record),expectedPeriod:record.data.periodVersion},fields:action==="renew"?[...periodFields(record.data.billing.period),{key:"currency",label:"本期收费币种",type:"select",value:record.data.billing.currency,options:currencyOptions},amountField(record.data.billing.amountMinor,record.data.billing.currency)]:[dateField("date",action==="exit"?"退出日期":"换号日期"),...(action==="switch"?[option("toSlotId","更换到",workbench(snapshot,today).vacant.map(row=>({...row,data:{label:name(row.data.subscriptionId)+" · "+row.data.label}})))]:[]),{key:"reason",label:"原因",required:true}],transform:action==="renew"?billingTransform:undefined});
  }
  function billEditor() {
    setEditor({title:"登记应收账期",type:"bill.issue",fields:[option("subscriptionId","订阅",snapshot?.subscriptions??[]),{...option("rentalId","租赁（可选）",(snapshot?.rentals??[]).map(row=>({...row,data:{label:name(row.data.customerId)+" · "+name(row.data.slotId)}}))),required:false},dateField("startDate","账期开始日"),dateField("endDate","账期截止日",""),dateField("dueDate","应付款日"),{key:"currency",label:"币种",type:"select",value:"CNY",options:currencyOptions},amountField(),{key:"note",label:"备注",type:"textarea",wide:true}],transform:values=>({amountMinor:parseToMinor(values.amount,exponent(values.currency))})});
  }
  function receiveEditor(bill:OpsRecord<BillData>) {
    setEditor({title:"登记实际收款",type:"entry.receive",base:{billId:bill.id},fields:[{key:"currency",label:"实际收到的币种",type:"select",value:bill.data.currency,options:currencyOptions},amountField(snapshot?outstandingMinor(snapshot,bill.id):0,bill.data.currency),dateField("date","收款日期"),{key:"note",label:"收款说明",type:"textarea",wide:true}],transform:values=>({amountMinor:parseToMinor(values.amount,exponent(values.currency))})});
  }
  function costEditor() {
    setEditor({title:"登记购买 / 续费支出",type:"entry.cost",fields:[option("subscriptionId","订阅",snapshot?.subscriptions??[]),{key:"currency",label:"原币",type:"select",value:"CNY",options:currencyOptions},amountField(),{key:"feePercent",label:"支付手续费（%）",value:"0"},dateField("date","付款日期"),dateField("periodStart","归属账期开始日"),dateField("periodEnd","归属账期截止日",""),{key:"note",label:"说明",type:"textarea",wide:true}],transform:values=>({amountMinor:parseToMinor(values.amount,exponent(values.currency))})});
  }
  function adjustmentEditor(record:OpsRecord<BillData>|OpsRecord<EntryData>,action:"discount"|"refund"|"void") {
    const currency=record.data.currency;
    setEditor({title:action==="discount"?"调整优惠":action==="refund"?"登记退款":"作废记录",type:action==="discount"?"bill.discount":action==="refund"?"entry.refund":record.kind+".void",base:action==="refund"?{sourceEntryId:record.id}:fieldsBase(record),fields:[...(action==="void"?[]:[amountField(0,currency)]),...(action==="refund"?[dateField("date","退款日期")]:[]),{key:"reason",label:"调整原因",required:true}],transform:action==="void"?undefined:values=>({amountMinor:parseToMinor(values.amount,exponent(currency)),currency})});
  }
  async function loginMember(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();setError("");
    identity.current.advance();resetIdentityViews();
    const checkIdentity=identity.current.checkpoint();
    const previous=activeToken.current;activeToken.current=tokenInput.trim();
    try {const value=await request("/api/operations/snapshot");await clearOfflineData();checkIdentity();sessionStorage.setItem("ops-token",activeToken.current);setToken(activeToken.current);setTokenInput("");await accept(value);}
    catch(failure) {if(failure instanceof StaleIdentityError)return;activeToken.current=previous;setError(failure instanceof Error?failure.message:"身份验证失败。");}
  }
  async function signOut() {
    if(pending>0){setError("还有未确认的离线操作，请先提交，或逐项移除本机重试后再退出身份。");return;}
    identity.current.advance();identityTransition.current=true;resetIdentityViews();
    const member=!!activeToken.current;
    try {
    await clearOfflineData();sessionStorage.removeItem("ops-token");sessionStorage.removeItem("ops-actor");sessionStorage.removeItem("ops-role");localStorage.removeItem("ops-actor");activeToken.current="";setToken("");setEnvelope(null);setPending(0);
    if (!member) await logout();
    }finally{identityTransition.current=false;}
  }
  async function loadReport() {
    setError("");try {const to=new Date(Date.parse(range.to+"T00:00:00Z")+86400000).toISOString().slice(0,10);setReport((await request("/api/operations/report?"+new URLSearchParams({...range,to,...(reportSubscription?{subscriptionId:reportSubscription}:{}),...(reportCustomer?{customerId:reportCustomer}:{}),...(reportChannel?{channelId:reportChannel}:{})}))).report);}catch(failure){setError((failure as Error).message);}
  }
  async function loadSecurity() {
    try {setSyncStatus(await request("/api/sync/status"));setConflicts((await request("/api/sync/conflicts")).conflicts);if(owner)setCredentials((await request("/api/operations/access")).credentials);if(writable)setAudit((await request("/api/operations/audit")).audit??[]);}catch(failure){setError((failure as Error).message);}
  }
  function previewImport() {
    try {
      const required=csvKind==="customers"?["name"]:csvKind==="subscriptions"?["name","service","currency","amount","startDate"]:["billId","currency","amount","date"];
      const result=previewCsv(csvText,required);
      result.rows.forEach((row,index)=>{
        if(row.amount) try {const minor=parseToMinor(row.amount,exponent(row.currency));if(minor<0)throw new Error();}catch{result.errors.push({line:index+2,message:"金额格式无效或为负数。"});}
        for(const key of ["date","startDate"]) if(row[key]&&!/^\d{4}-\d{2}-\d{2}$/.test(row[key]))result.errors.push({line:index+2,message:key+" 日期格式须为 YYYY-MM-DD。"});
      });
      setCsvPreview(result);setError("");
    }catch(failure){setError((failure as Error).message);setCsvPreview(null);}
  }
  async function commitImport() {
    if(!csvPreview || csvPreview.errors.length)return;
    const rows=csvPreview.rows.map(row=>({type:csvKind==="customers"?"customer.save":csvKind==="subscriptions"?"subscription.save":"entry.receive",payload:csvKind==="customers"?row:csvKind==="subscriptions"?{...row,amountMinor:parseToMinor(row.amount,exponent(row.currency)),period:{unit:row.periodUnit||"month",count:Number(row.periodCount||1)},feePercent:row.feePercent||"0",capacity:Number(row.capacity||1)}:{...row,amountMinor:parseToMinor(row.amount,exponent(row.currency))}}));
    const bytes=new TextEncoder().encode(csvKind+"\n"+csvText);const hash=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes)),byte=>byte.toString(16).padStart(2,"0")).join("");
    try {await run({id:"csv:"+hash,type:"import.commit",payload:{rows,sourceName:csvKind}});setCsvPreview(null);}catch(failure){setError((failure as Error).message);}
  }
  function exportLedger() {
    if(!snapshot)return;
    const kinds=[...snapshot.customers,...snapshot.subscriptions,...snapshot.slots,...snapshot.rentals,...snapshot.bills,...snapshot.entries];
    download(`订阅管家-明细-${today}.csv`,writeCsv([["id","kind","revision","updatedAt","data"],...kinds.map(row=>[row.id,row.kind,row.revision,row.updatedAt,JSON.stringify(row.data)])]));
  }
  function inspect(record:OpsRecord) {setSelected(record);}
  const currentMoney = (amount:number,currency:string) => { const source=envelope?.quotes?.find(row=>row.currency===currency);const cny=envelope?.quotes?.find(row=>row.currency==="CNY");return <>{money(source&&cny?convertCurrencyMinor(amount,source.minorUnit,source.rateToUsd,cny.minorUnit,cny.rateToUsd):null)}<small>{money(amount,currency)}{source?" · "+money(convertCurrencyMinor(amount,source.minorUnit,source.rateToUsd,2,"1"),"USD"):""}</small></>; };
  const risks = snapshot ? workbench(snapshot,today) : null;
  const rentalRows = snapshot?.rentals.filter(row=>matches(row)&&(view==="all"||row.data.usage===view))??[];
  const globalResults = search&&snapshot ? [...snapshot.customers,...snapshot.subscriptions,...snapshot.slots,...snapshot.rentals,...snapshot.bills,...snapshot.entries].filter(matches).slice(0,20):[];
  const rentalTable = (records:OpsRecord<RentalData>[]) => <Rows headers={["选择","客户 / 位置","租期","收费","状态","操作"]}>{records.length?records.map(row=><tr key={row.id}><td><input style={{width:16}} type="checkbox" aria-label={"选择租赁 "+row.id} checked={selectedRentals.includes(row.id)} onChange={event=>setSelectedRentals(event.target.checked?[...selectedRentals,row.id]:selectedRentals.filter(id=>id!==row.id))}/></td><td><button onClick={()=>inspect(row)}>{name(row.data.customerId)} · {name(row.data.slotId)}</button><small>{name(row.data.subscriptionId)} · {row.data.usage==="self"?"自用":"出租"}</small></td><td>{row.data.startDate} → {row.data.endDate}<small>{dueCategory(row.data.endDate,today)}</small></td><td>{currentMoney(row.data.billing.amountMinor,row.data.billing.currency)}<small>每 {row.data.billing.period.count} {row.data.billing.period.unit}</small></td><td>{row.data.status==="active"?"使用中":"已退出"}</td><td><div className="actions"><button onClick={()=>inspect(row)}>历史</button>{writable&&row.data.status==="active"&&<><button disabled={busy} onClick={()=>rentalEditor(row,"renew")}>续租</button><button onClick={()=>rentalEditor(row,"switch")}>换号</button><button className="danger" onClick={()=>rentalEditor(row,"exit")}>退出</button></>}</div></td></tr>):<Empty cols={6}/>}</Rows>;
  const billTable = (records:OpsRecord<BillData>[]) => <Rows headers={["客户 / 账期","应收","已收 / 未收","付款日","操作"]}>{records.length?records.map(row=>{const unpaid=snapshot?outstandingMinor(snapshot,row.id):0;return <tr key={row.id}><td><button onClick={()=>inspect(row)}>{name(row.data.customerId)}</button><small>{row.data.startDate} → {row.data.endDate} · {name(row.data.subscriptionId)}</small></td><td>{money(row.data.amountMinor-row.data.discountMinor,row.data.currency)}<small>{row.data.status==="void"?"已作废":row.data.discountMinor?"已含优惠":""}</small></td><td>{money(row.data.amountMinor-row.data.discountMinor-unpaid,row.data.currency)} / {money(unpaid,row.data.currency)}</td><td>{row.data.dueDate}<small>{unpaid?dueCategory(row.data.dueDate,today):"已结清"}</small></td><td><div className="actions"><button onClick={()=>inspect(row)}>来源</button>{writable&&row.data.status!=="void"&&<><button disabled={busy||unpaid===0} onClick={()=>receiveEditor(row)}>收款</button><button onClick={()=>adjustmentEditor(row,"discount")}>优惠</button><button onClick={()=>adjustmentEditor(row,"void")}>作废</button></>}</div></td></tr>;}):<Empty cols={5}/>}</Rows>;

  return <div className="ops"><header className="bar end"><div><h1>订阅管家</h1><p className="muted">{today} · {actor?actor.role==="customer"?"我的账期与付款":actor.role==="read-only"?"只读工作区":"运营工作区":"本地订阅与经营账本"}</p></div><div className="bar">{actor&&<><span className="badge">{offline?"离线账本":"已连接"}</span><button disabled={busy} onClick={()=>void refresh()}>刷新</button>{(!desktopMode||!!token)&&<button onClick={()=>void signOut()}>退出身份</button>}</>}{!actor&&!desktopMode&&!token&&<Link href="/login">网页登录</Link>}{owner&&<Link href="/spaces">原账号详情</Link>}</div></header>
    {error&&<div className="notice error" role="alert">{error}</div>}{message&&<div className="notice" role="status">{message}</div>}
    {pending>0&&<div className="notice bar end"><span>{pending} 个操作保存在本机，提交成功前不会计入账本。</span><button disabled={busy||offline} onClick={()=>void flush().catch(failure=>setError(failure.message))}>验证身份并提交</button></div>}
    {pendingCommands.length>0&&<details className="detail"><summary>检查待提交操作（发生冲突时可保留或移除重试）</summary>{pendingCommands.map(item=><div className="detail" key={item.id}><p>{item.command.type} · {item.createdAt}</p><pre>{JSON.stringify(item.command.payload,null,2)}</pre><button onClick={()=>void dequeue(item.id).then(async()=>{setPending((await queued(item.actorId)).length);setMessage("已移除本机重试；如果服务端已经收到该操作，账本记录仍然保留。");})}>移除本机重试</button></div>)}</details>}{!actor?<section className="detail"><h2>{desktopMode?"正在连接本机工作区":"进入工作区"}</h2><p>{desktopMode?"桌面版无需输入密钥。若连接未恢复，可从“应用”菜单选择“重新进入本机工作区”。":"网页管理员使用访问密钥登录；协作成员或客户填写管理员分配的访问凭证。"}</p><form onSubmit={loginMember} className="inline"><label>成员访问凭证<input autoComplete="off" type="password" value={tokenInput} onChange={event=>setTokenInput(event.target.value)} required/></label><button className="primary">验证身份</button></form><p className="muted">退出身份前先处理待提交操作；退出后清除本机账本缓存。凭证不写入账本、不放在分享网址中。</p>{token&&<button onClick={()=>{sessionStorage.removeItem("ops-token");activeToken.current="";setToken("");router.push("/login");}}>切换到本机密钥登录</button>}</section>:<>
    <nav className="nav" aria-label="运营功能">{tabs.filter(item=>actor.role!=="customer"||item.id==="ledger").map(item=><button className={tab===item.id?"active":""} key={item.id} onClick={()=>{setTab(item.id);setSelected(null);if(item.id==="reports")void loadReport();if(item.id==="sync")void loadSecurity();}}>{item.name}</button>)}</nav>
    <div className="bar"><input className="search" type="search" aria-label="全局搜索" placeholder="搜索客户、联系方式、服务、账号、标签或记录编号" value={search} onChange={event=>setSearch(event.target.value)}/><span className="muted">当前估算每 5 分钟更新；历史收支使用记账时汇率。</span></div>
    {globalResults.length>0&&<details className="detail" open><summary>全局搜索 · 前 {globalResults.length} 条</summary><div className="toolbar">{globalResults.map(row=><button key={row.id} onClick={()=>inspect(row)}>{row.kind} · {"name" in row.data?String(row.data.name):"label" in row.data?String(row.data.label):row.id}</button>)}</div></details>}
    {snapshot&&risks&&<>
    {actor.role==="customer"&&<><h2>我的账期</h2>{billTable(snapshot.bills)}</>}
    {actor.role!=="customer"&&tab==="today"&&<><div className="metrics">{[["待续租",risks.renewals.length],["订阅待续费",risks.subscriptions.length],["未结清账期",risks.receivables.length],["闲置位置",risks.vacant.length]].map(([label,count])=><div className="metric" key={label}><small>{label}</small><strong>{count}</strong></div>)}</div><div className="toolbar">{writable&&<><button className="primary" onClick={()=>customerEditor()}>新增客户</button><button onClick={()=>joinEditor()}>分配账号</button><button onClick={()=>billEditor()}>登记应收</button></>}</div><h2>今日与近期续租</h2>{rentalTable(risks.renewals.filter(matches))}<h2>订阅续费</h2><Rows headers={["订阅","到期日","操作"]}>{risks.subscriptions.length?risks.subscriptions.filter(matches).map(row=><tr key={row.id}><td>{row.data.name}</td><td>{row.data.endDate} · {dueCategory(row.data.endDate,today)}</td><td>{writable&&<button disabled={busy} onClick={()=>execute("subscription.renew",{...fieldsBase(row),expectedEndDate:row.data.endDate})}>续费并记支出</button>}</td></tr>):<Empty cols={3}/>}</Rows><h2>待收款</h2>{billTable(risks.receivables.filter(matches))}<h2>闲置位置</h2><Rows headers={["订阅 / 位置","账号","操作"]}>{risks.vacant.length?risks.vacant.filter(matches).map(row=><tr key={row.id}><td>{name(row.data.subscriptionId)} · {row.data.label}</td><td>{row.data.account||"—"}</td><td>{writable&&<button onClick={()=>joinEditor(row.id)}>分配</button>}</td></tr>):<Empty cols={3}/>}</Rows></>}
    {tab==="customers"&&<><h2>客户档案</h2>{writable&&<div className="toolbar"><button className="primary" onClick={()=>customerEditor()}>新增客户</button></div>}<Rows headers={["客户","联系方式","使用与历史","标签 / 分组","操作"]}>{snapshot.customers.filter(matches).map(row=><tr key={row.id}><td><button onClick={()=>inspect(row)}>{row.data.name}</button><small>{row.data.archived?"已归档":""}</small></td><td>{row.data.contact||row.data.email||"—"}</td><td>{snapshot.rentals.filter(item=>item.data.customerId===row.id&&item.data.status==="active").length} 使用中 · {snapshot.rentals.filter(item=>item.data.customerId===row.id).length} 次租赁</td><td>{row.data.group} {row.data.tags.join("、")}</td><td><div className="actions"><button onClick={()=>inspect(row)}>全部租赁</button>{writable&&<><button onClick={()=>customerEditor(row)}>编辑</button><button onClick={()=>execute("customer.archive",fieldsBase(row))}>归档</button></>}</div></td></tr>)}</Rows></>}
    {tab==="subscriptions"&&<><h2>通用订阅</h2><div className="toolbar">{writable&&<><button className="primary" onClick={()=>subscriptionEditor()}>新增订阅</button><button onClick={()=>templateEditor()}>新增套餐模板</button><button onClick={()=>slotEditor()}>新增位置</button></>}<select aria-label="自用出租筛选" value={view} onChange={event=>setView(event.target.value)}><option value="all">全部使用方式</option><option value="rented">出租</option><option value="self">自用</option></select></div><Rows headers={["订阅 / 服务","套餐 / 分组","本期","原币成本 / 手续费","操作"]}>{snapshot.subscriptions.filter(row=>matches(row)&&(view==="all"||snapshot.rentals.some(rental=>rental.data.subscriptionId===row.id&&rental.data.usage===view&&rental.data.status==="active"))).map(row=><tr key={row.id}><td><button onClick={()=>inspect(row)}>{row.data.name}</button><small>{row.data.service} · {row.data.account}</small></td><td>{row.data.planName} · {row.data.group}<small>{row.data.tags.join("、")}</small></td><td>{row.data.startDate} → {row.data.endDate}<small>{row.data.status==="disabled"?"停用":dueCategory(row.data.endDate,today)}</small></td><td>{currentMoney(paymentFee(row.data.amountMinor,row.data.feePercent).totalAmountMinor,row.data.currency)}<small>手续费 {row.data.feePercent}%</small></td><td><div className="actions"><button onClick={()=>inspect(row)}>明细</button>{writable&&<><button onClick={()=>subscriptionEditor(row)}>编辑</button><button disabled={busy||row.data.status!=="active"} onClick={()=>execute("subscription.renew",{...fieldsBase(row),expectedEndDate:row.data.endDate})}>续费</button><button onClick={()=>setEditor({title:"停用订阅",type:"subscription.disable",base:fieldsBase(row),fields:[{key:"reason",label:"停用原因",required:true}]})}>停用</button></>}</div></td></tr>)}</Rows><h2>套餐模板</h2><div className="toolbar">{snapshot.templates.map(row=><span className="bar" key={row.id}><button onClick={()=>writable&&subscriptionEditor(undefined,row.id)}>{row.data.name} · {row.data.capacity} 位</button>{writable&&<button onClick={()=>templateEditor(row)}>编辑</button>}</span>)}</div><h2>账号与位置</h2>{writable&&selectedSlots.length>0&&<div className="toolbar"><button onClick={()=>execute("status.batch",{items:selectedSlots.map(id=>{const row=snapshot.slots.find(item=>item.id===id)!;return {...fieldsBase(row),kind:"slot",status:"disabled"};}),reason:"工作台批量停用"})}>批量停用所选位置</button></div>}<Rows headers={["选择","所属订阅","位置 / 账号","分摊权重","状态","操作"]}>{snapshot.slots.filter(matches).map(row=><tr key={row.id}><td><input style={{width:16}} type="checkbox" checked={selectedSlots.includes(row.id)} aria-label={"选择位置 "+row.id} onChange={event=>setSelectedSlots(event.target.checked?[...selectedSlots,row.id]:selectedSlots.filter(id=>id!==row.id))}/></td><td>{name(row.data.subscriptionId)}</td><td>{row.data.label}<small>{row.data.account}</small></td><td>{row.data.weight}</td><td>{row.data.status==="disabled"?"已停用":snapshot.rentals.some(rental=>rental.data.slotId===row.id&&rental.data.status==="active")?"使用中":"闲置"}</td><td>{writable&&<div className="actions"><button onClick={()=>slotEditor(row)}>编辑</button><button disabled={!risks.vacant.some(item=>item.id===row.id)} onClick={()=>joinEditor(row.id)}>分配</button></div>}</td></tr>)}</Rows></>}
    {tab==="rentals"&&<><h2>租期与操作历史</h2><div className="toolbar">{writable&&<><button className="primary" onClick={()=>joinEditor()}>加入 / 分配</button><button disabled={busy||!selectedRentals.length} onClick={()=>execute("renewal.batch",{items:selectedRentals.map(id=>{const row=snapshot.rentals.find(item=>item.id===id)!;return {...fieldsBase(row),expectedPeriod:row.data.periodVersion};})})}>批量续租 {selectedRentals.length||""}</button></>}<select value={view} onChange={event=>setView(event.target.value)} aria-label="租赁使用方式"><option value="all">全部</option><option value="rented">出租</option><option value="self">自用</option></select></div>{rentalTable(rentalRows)}<p className="muted">重复点击会校验当前租期版本；退出保留历史，并释放位置。续租后另行登记实际收款。</p></>}
    {tab==="ledger"&&actor.role!=="customer"&&<><h2>应收与实收</h2><div className="toolbar">{writable&&<><button className="primary" onClick={()=>billEditor()}>登记账期</button><button onClick={()=>costEditor()}>登记支出</button></>}<button onClick={exportLedger}>导出明细 CSV</button></div>{billTable(snapshot.bills.filter(matches))}<h2>实际收支</h2><Rows headers={["发生日期 / 类型","客户 / 订阅","原币金额","记账金额","操作"]}>{snapshot.entries.filter(matches).map(row=><tr key={row.id}><td>{row.data.date}<small>{row.data.type==="receipt"?"收款":row.data.type==="refund"?"退款":"支出"} · {row.data.status==="void"?"已作废":"已记账"}</small></td><td>{name(row.data.customerId)}<small>{name(row.data.subscriptionId)}</small></td><td>{money(row.data.totalMinor,row.data.currency)}<small>{row.data.feePercent!=="0"?"含手续费 "+row.data.feePercent+"%":""}</small></td><td>{money(row.data.cnyMinor)}<small>{money(row.data.usdMinor,"USD")} · {row.data.fx.quoteDate}</small></td><td><div className="actions"><button onClick={()=>inspect(row)}>来源 / 汇率</button>{writable&&row.data.status==="posted"&&<>{row.data.type==="receipt"&&<button onClick={()=>adjustmentEditor(row,"refund")}>退款</button>}<button onClick={()=>adjustmentEditor(row,"void")}>作废</button></>}</div></td></tr>)}</Rows></>}
    {tab==="reports"&&<><h2>经营口径与来源</h2><div className="toolbar"><input type="date" aria-label="报表开始日期" value={range.from} onChange={event=>setRange({...range,from:event.target.value})}/><input type="date" aria-label="报表结束日期" value={range.to} onChange={event=>setRange({...range,to:event.target.value})}/><select value={reportSubscription} onChange={event=>setReportSubscription(event.target.value)} aria-label="报表订阅"><option value="">所有订阅</option>{snapshot.subscriptions.map(row=><option key={row.id} value={row.id}>{row.data.name}</option>)}</select><select value={reportCustomer} onChange={event=>setReportCustomer(event.target.value)} aria-label="报表客户"><option value="">所有客户</option>{snapshot.customers.map(row=><option key={row.id} value={row.id}>{row.data.name}</option>)}</select><select value={reportChannel} onChange={event=>setReportChannel(event.target.value)} aria-label="报表支付渠道"><option value="">所有支付渠道</option>{snapshot.channels.map(channel=><option key={channel.id} value={channel.id}>{channel.name}</option>)}</select><button onClick={()=>void loadReport()}>计算</button></div><p className="muted">预计收益跟随当前汇率。现金结余按实际收付日期，按期收益按收入与成本的所属账期。历史使用冻结汇率。</p>{report&&<><div className="metrics">{[{label:"预计每月收益",value:report.estimates.netUsd,lines:report.estimates.lines},{label:"现金结余",value:report.cash.netUsd,lines:report.cash.lines},{label:"按期经营收益",value:report.accrual.netUsd,lines:report.accrual.lines}].map(item=>{const hasAll=item.lines.every(line=>line.cnyMinor!==null);const total=hasAll&&item.value!==null?item.lines.reduce((sum,line)=>sum+(line.type==="cost"||line.type==="estimated-cost"?-1:1)*line.cnyMinor!,0):null;return <div className="metric" key={item.label}><small>{item.label}</small><strong>{money(total)}</strong><small>{money(item.value,"USD")}</small></div>;})}<div className="metric"><small>未收款（冻结美元）</small><strong>{money(report.receivables.outstandingUsd,"USD")}</strong></div></div>{report.warnings.map(text=><p className="notice" key={text}>{text}</p>)}{[{name:"预计收益来源",lines:report.estimates.lines},{name:"实际现金来源",lines:report.cash.lines},{name:"账期收益来源",lines:report.accrual.lines}].map(group=><details key={group.name} className="detail"><summary>{group.name} · {group.lines.length} 条</summary><Rows headers={["来源","日期","类型","人民币 / 美元"]}>{group.lines.map((line,index)=><tr key={index}><td><button onClick={()=>{const row=[...snapshot.entries,...snapshot.bills,...snapshot.subscriptions,...snapshot.rentals].find(item=>item.id===line.sourceId);if(row)inspect(row);}}>{line.sourceId}</button></td><td>{line.date}</td><td>{line.type}</td><td>{money(line.cnyMinor)} / {money(line.usdMinor,"USD")}</td></tr>)}</Rows></details>)}</>}<Pricing subscriptions={snapshot.subscriptions} rentals={snapshot.rentals} slots={snapshot.slots}/></>}
    {tab==="calendar"&&<><h2>续费日历</h2><div className="toolbar"><input type="month" aria-label="日历月份" value={calendarMonth} onChange={event=>setCalendarMonth(event.target.value)}/></div><div style={{overflow:"auto"}}><div className="calendar">{["周一","周二","周三","周四","周五","周六","周日"].map(day=><strong key={day}>{day}</strong>)}{Array.from({length:(new Date(calendarMonth+"-01T00:00:00Z").getUTCDay()+6)%7},(_,index)=><div key={"blank"+index}/>)}{calendarDays(calendarMonth).map(day=><div className={"day "+(day===today?"today":"")} key={day}><strong>{Number(day.slice(-2))} 日</strong>{snapshot.subscriptions.filter(row=>row.data.status==="active"&&row.data.endDate===day).map(row=><button key={row.id} onClick={()=>inspect(row)}>续费 · {row.data.name}</button>)}{snapshot.rentals.filter(row=>row.data.status==="active"&&row.data.endDate===day).map(row=><button key={row.id} onClick={()=>inspect(row)}>续租 · {name(row.data.customerId)}</button>)}{snapshot.bills.filter(row=>row.data.dueDate===day&&outstandingMinor(snapshot,row.id)>0).map(row=><button key={row.id} onClick={()=>writable?receiveEditor(row):inspect(row)}>待收 · {name(row.data.customerId)}</button>)}</div>)}</div></div></>}
    {tab==="exchange"&&<><h2>CSV 导入与导出</h2><div className="toolbar"><button onClick={exportLedger}>导出全部明细 CSV</button><select value={csvKind} onChange={event=>{setCsvKind(event.target.value);setCsvPreview(null);}} aria-label="导入类型"><option value="customers">客户</option><option value="subscriptions">订阅</option><option value="receipts">实际收款</option></select><button onClick={()=>download("导入模板-"+csvKind+".csv",writeCsv([csvKind==="customers"?["name","contact","email","note"]:csvKind==="subscriptions"?["name","service","planName","currency","amount","startDate","periodUnit","periodCount","feePercent","capacity"]:["billId","currency","amount","date","note"]]))}>下载导入模板</button></div><p className="muted">原币金额填元，例如 80.00；日期格式 YYYY-MM-DD。先预览和核对，确认后整批保存；相同文件重复提交不会重复记账。</p><label>选择 CSV 文件<input type="file" accept=".csv,text/csv" onChange={event=>{const file=event.target.files?.[0];if(file&&file.size<=2*1024*1024)void file.text().then(setCsvText);else setError("CSV 文件不得超过 2 MB。");setCsvPreview(null);}}/></label><label style={{marginTop:12}}>CSV 内容<textarea rows={7} value={csvText} onChange={event=>{setCsvText(event.target.value);setCsvPreview(null);}}/></label><div className="toolbar"><button onClick={previewImport}>预览与检查</button>{owner&&<button className="primary" disabled={!csvPreview||!!csvPreview.errors.length||busy} onClick={()=>void commitImport()}>确认导入</button>}</div>{csvPreview&&<><p>可导入 {csvPreview.rows.length} 行 · 文件内重复 {csvPreview.duplicates} 行 · 错误 {csvPreview.errors.length} 行</p>{csvPreview.errors.length>0&&<><pre>{csvPreview.errors.map(row=>`第 ${row.line} 行：${row.message}`).join("\n")}</pre><button onClick={()=>download("导入错误.csv",writeCsv([["行号","错误"],...csvPreview.errors.map(row=>[row.line,row.message])]))}>下载错误报告</button></>}<Rows headers={Object.keys(csvPreview.rows[0]??{})}>{csvPreview.rows.slice(0,50).map((row,index)=><tr key={index}>{Object.values(row).map((value,i)=><td key={i}>{value}</td>)}</tr>)}</Rows></>}</>}
    {tab==="sync"&&<><h2>设备同步</h2><p className="muted">连接你自行运行的 HTTPS 同步服务。只同步业务记录与变更；访问密钥、SMTP 配置和本机安全配置留在本机。</p><div className="notice">设备：{syncStatus?.deviceId??"读取中"} · {syncStatus?.connected?"已连接 "+syncStatus.url:"未连接"} · 待上传 {syncStatus?.pending??0} · 冲突 {syncStatus?.conflicts??0}</div>{owner&&<form className="inline" onSubmit={event=>{event.preventDefault();const values=Object.fromEntries(new FormData(event.currentTarget));void request("/api/sync/connect",values).then(()=>loadSecurity()).catch(failure=>setError(failure.message));event.currentTarget.reset();}}><label>同步服务网址<input name="url" type="url" required placeholder="https://你的服务地址"/></label><label>服务分配的设备凭证<input name="token" type="password" required autoComplete="off"/></label><button>连接</button></form>}<div className="toolbar"><button disabled={busy} onClick={()=>void request("/api/sync/flush",{}).then(value=>{if(value.snapshot)void accept(value);void loadSecurity();}).catch(failure=>setError(failure.message))}>上传并拉取</button><button onClick={()=>void request("/api/sync/pull",{}).then(value=>{if(value.snapshot)void accept(value);void loadSecurity();}).catch(failure=>setError(failure.message))}>拉取变更</button><button onClick={()=>void loadSecurity()}>检查状态</button>{owner&&<><button onClick={()=>void request("/api/sync/bootstrap",{direction:"upload"}).then(value=>{if(value.snapshot)void accept(value);void loadSecurity();}).catch(failure=>setError(failure.message))}>首次上传本机账本</button><button onClick={()=>void request("/api/sync/bootstrap",{direction:"download"}).then(value=>{if(value.snapshot)void accept(value);void loadSecurity();}).catch(failure=>setError(failure.message))}>首次下载服务端账本</button></>}{owner&&windowDesktop()&&<><button onClick={()=>void window.teamAccountManagerDesktop?.maintenance?.createBackup().then(value=>setMessage(value?.cancelled?"已取消备份。":"备份已完成。")).catch(failure=>setError(failure.message))}>备份账本</button><button onClick={()=>void window.teamAccountManagerDesktop?.maintenance?.restoreBackup().then(value=>setMessage(value?.cancelled?"已取消恢复。":"恢复操作已处理。")).catch(failure=>setError(failure.message))}>恢复账本</button></>}</div>{conflicts.map(conflict=><details className="detail" key={conflict.id}><summary>同步冲突 · {conflict.reason}</summary><h3>本机操作</h3><pre>{JSON.stringify(conflict.local,null,2)}</pre><h3>服务端记录</h3><pre>{JSON.stringify(conflict.remote,null,2)}</pre>{owner&&<div className="toolbar">{["local","remote"].map(choice=><button key={choice} onClick={()=>void request(`/api/sync/conflicts/${encodeURIComponent(conflict.id)}/resolve`,{choice}).then(value=>{if(value.snapshot)void accept(value);void loadSecurity();}).catch(failure=>setError(failure.message))}>{choice==="local"?"使用本机操作":"保留服务端记录"}</button>)}</div>}</details>)}
    {owner&&<><h2>协作与客户凭证</h2><form className="inline" onSubmit={event=>{event.preventDefault();const values=Object.fromEntries(new FormData(event.currentTarget));void request("/api/operations/access",{...values,expiresInDays:Number(values.expiresInDays)}).then(value=>{setNewToken(value.token);void loadSecurity();}).catch(failure=>setError(failure.message));}}><label>名称<input name="label" required/></label><label>权限<select name="role"><option value="operator">运营人员</option><option value="read-only">只读人员</option><option value="customer">客户（仅自己账期）</option><option value="admin">管理员</option></select></label><label>绑定客户<select name="customerId"><option value="">无需绑定</option>{snapshot.customers.map(row=><option key={row.id} value={row.id}>{row.data.name}</option>)}</select></label><label>有效天数<input name="expiresInDays" type="number" defaultValue={30} min={1} max={365}/></label><button>生成凭证</button></form>{newToken&&<div className="notice"><p>凭证仅显示这一次，请交给指定使用者。</p><p className="token">{newToken}</p><button onClick={()=>void navigator.clipboard.writeText(newToken)}>复制</button><button onClick={()=>setNewToken("")}>隐藏</button></div>}<Rows headers={["名称","权限 / 客户","有效期","操作"]}>{credentials.map(row=><tr key={row.id}><td>{row.label}</td><td>{row.role} · {name(row.customerId)}</td><td>{row.revokedAt?"已撤销":row.expiresAt}</td><td><button disabled={!!row.revokedAt} onClick={()=>void request("/api/operations/access/"+encodeURIComponent(row.id),undefined,"DELETE").then(()=>loadSecurity()).catch(failure=>setError(failure.message))}>撤销</button></td></tr>)}</Rows></>}<h2>操作追溯</h2><details className="detail"><summary>最近操作 · {audit.length} 条</summary><pre>{JSON.stringify(audit,null,2)}</pre></details></>}
    {selected&&<section className="detail"><div className="bar end"><h2 style={{margin:0}}>记录详情与来源</h2><button onClick={()=>setSelected(null)}>收起</button></div><p className="muted">{selected.id} · 修订 {selected.revision} · {selected.updatedAt}</p>{selected.kind==="customer"&&rentalTable(snapshot.rentals.filter(row=>row.data.customerId===selected.id))}{selected.kind==="rental"&&<Rows headers={["操作","日期","期次","原因 / 来源"]}>{(selected.data as RentalData).history.map((event,index)=><tr key={index}><td>{event.type}</td><td>{event.date}</td><td>{event.periodVersion}</td><td>{event.reason||event.commandId}</td></tr>)}</Rows>}{(selected.kind==="customer"||selected.kind==="subscription"||selected.kind==="rental")&&<>{billTable(snapshot.bills.filter(row=>selected.kind==="customer"?row.data.customerId===selected.id:selected.kind==="subscription"?row.data.subscriptionId===selected.id:row.data.rentalId===selected.id))}</>}<details><summary>原始资料、历史汇率与迁移来源</summary><pre>{JSON.stringify(selected.data,null,2)}</pre></details></section>}
    </>}
    </>}{editor&&<EditorDialog key={editor.type+JSON.stringify(editor.base)} editor={editor} busy={busy} onClose={()=>setEditor(null)} onSubmit={run}/>}</div>;
}
function windowDesktop(){return typeof window!=="undefined"&&!!window.teamAccountManagerDesktop?.maintenance;}
function Pricing({subscriptions,rentals,slots}:{subscriptions:OperationsSnapshot["subscriptions"];rentals:OperationsSnapshot["rentals"];slots:OperationsSnapshot["slots"]}) {
  const [subscriptionId,setSubscriptionId]=useState("");const [price,setPrice]=useState("80");const [members,setMembers]=useState("1");
  const subscription=subscriptions.find(row=>row.id===subscriptionId);const data=subscription?.data;
  const nativeCost=data ? paymentFee(data.amountMinor,data.feePercent).totalAmountMinor:0;
  const months=data?data.period.unit==="year"?data.period.count*12:data.period.unit==="quarter"?data.period.count*3:data.period.unit==="day"?data.period.count*12/365.2425:data.period.count:1;
  const monthlyCost=nativeCost/months;const rate=Number(price)*(10**exponent(data?.currency??"CNY"));const count=Number(members);const capacity=slots.filter(row=>row.data.subscriptionId===subscriptionId&&row.data.status==="available").length;
  return <section className="detail"><h2>定价与空闲位置测算</h2><p className="muted">按该订阅原币计算。填写每人每月收费，比较不同人数；此测算不会修改账本。</p><div className="inline"><label>订阅<select value={subscriptionId} onChange={event=>setSubscriptionId(event.target.value)}><option value="">请选择</option>{subscriptions.map(row=><option key={row.id} value={row.id}>{row.data.name}</option>)}</select></label><label>每人每月收费（{data?.currency??"原币"}）<input type="number" min={0} step="0.01" value={price} onChange={event=>setPrice(event.target.value)}/></label><label>成员数<input type="number" min={1} value={members} onChange={event=>setMembers(event.target.value)}/></label></div>{data&&<div className="metrics"><div className="metric"><small>按月成本</small><strong>{money(Math.round(monthlyCost),data.currency)}</strong></div><div className="metric"><small>预计月收益</small><strong>{money(Math.round(rate*count-monthlyCost),data.currency)}</strong></div><div className="metric"><small>保本人数</small><strong>{rate>0?Math.ceil(monthlyCost/rate):"—"}</strong></div><div className="metric"><small>{count} 人保本单价</small><strong>{count>0?money(Math.ceil(monthlyCost/count),data.currency):"—"}</strong></div><div className="metric"><small>位置 / 当前使用人数</small><strong>{capacity} / {rentals.filter(row=>row.data.subscriptionId===subscriptionId&&row.data.status==="active").length}</strong></div></div>}</section>;
}
