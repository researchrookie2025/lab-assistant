import {planningWeek, planningOutlook, beijingToday, mondayOf, shiftDate} from './cloud-model.js';
import {createConfirmationUI} from './readonly-ui.js';
import {createUsageUI, ratioHTML} from './readonly-ui.js';
import {createResearchUI} from './readonly-ui.js';
import {createHCWorkspace} from './hc-readonly.js';
import {completionForGroup, recordsForGroup, actualSummary, recordBody, recordId} from './cloud-records.js';

// Plan details are read from the database; local confirmations use an audited endpoint.
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const arrow = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg>';
const flask = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3h6M10 3v6l-5.1 8.5A2.3 2.3 0 0 0 6.9 21h10.2a2.3 2.3 0 0 0 2-3.5L14 9V3M8 14h8"/></svg>';
const diagonal = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 18 18 6M6 6h12v12"/></svg>';
const closeIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';
const app = document.getElementById('app');
const key = task => JSON.stringify([task.planId,task.id]);
const dateLabel = date => `${Number(date.slice(5,7))}月${Number(date.slice(8,10))}日`;
const weekdayLabel = date => ['日','一','二','三','四','五','六'][new Date(`${date}T00:00:00Z`).getUTCDay()];
const dateOkay = date => /^\d{4}-\d{2}-\d{2}$/.test(date || '') && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0,10) === date;
const state = {snapshot:null,week:mondayOf(beijingToday()),selected:null,error:false,fetching:false,renderDay:'',initialized:false,filter:'all',view:'week'};
const confirmUI = createConfirmationUI({getSnapshot:()=>state.snapshot,onChange:()=>render(),onSaved:()=>refresh()});
const usageUI = createUsageUI({getSnapshot:()=>state.snapshot,onChange:()=>render(),onSaved:()=>refresh()});
const researchUI = createResearchUI({onChange:()=>render()});
const hcWorkspace = createHCWorkspace();
const recordSelections = new Map();
const groupSelections = new Map();
const statusKey = task => JSON.stringify([task.planId,task.id,task.groupIndex ?? null]);
const recordFolds = new Set();
const inlineEditors = new Map();
const acknowledgedRecords = new Map();
const inlineNotices = new Map();
let mountRequests=[];

const statusRequests=new Map();
const statusAcknowledgements=new Map();
function acknowledgeStatus(result) {
  if(!result?.experiment_status || result.database_id!==state.snapshot.database_id)return;
  const row={id:result.record_id,project_id:result.experiment_status.project_id,_revision:result.data_revision,experiment_status:result.experiment_status};
  statusAcknowledgements.set(row.id,{databaseId:result.database_id,row});
  const requestKey=JSON.stringify([result.experiment_status.plan_id,result.experiment_status.task_id,result.experiment_status.group_index ?? null]);
  if(!statusRequests.get(requestKey)?.saving && !statusRequests.get(requestKey)?.uncertain)statusRequests.delete(requestKey);
  if(!state.snapshot.feedback.some(item=>item.id===row.id))state.snapshot.feedback.push(row);
}
function statusControls(task,detail=false) {
  if(task.groupIndex===undefined && task.recipe?.formulations?.length) return detail?'':`<div class="task-status-actions"><button data-action="task" data-plan="${escape(task.planId)}" data-task="${escape(task.id)}">查看实验</button></div>`;
  const done=task.completionStatus==='completed', request=statusRequests.get(statusKey(task));
  if(!usageUI.isEnabled() || task.futureOnly)return '';
  const attrs=`data-status-plan="${escape(task.planId)}" data-status-task="${escape(task.id)}" ${Number.isInteger(task.groupIndex)?`data-status-group="${task.groupIndex}"`:""}`;
  return `<div class="task-status-actions">${done?`${task.groupIndex===undefined?`<button ${attrs} data-experiment-action="edit">修改记录</button>`:""}${detail?`<button ${attrs} data-experiment-action="incomplete">设为未完成</button>`:''}`:`<button ${attrs} data-experiment-action="completed">完成实验</button>`}${request?.uncertain?`<button ${attrs} data-experiment-action="retry">重试核对状态</button>`:''}${request?.saving?'<span role="status">正在保存…</span>':''}${request?.error?`<p role="alert">${escape(request.error)}</p>`:''}</div>`;
}
function experimentEditors(plan,task,groupIndex) {
  return [...new Set([...inlineEditors].filter(([id])=>{const group=JSON.parse(JSON.parse(id)[1]);return group[0]===plan && group[1]===task && (groupIndex===undefined || group[2]===groupIndex);}).map(([,editor])=>editor))];
}
async function changeStatus(){throw new Error('只读页面');}

function applyDeletion(receipt,groupKey) {
  if(receipt.database_id!==state.snapshot.database_id)return;
  const row={id:receipt.deletion_id,project_id:receipt.deletion.project_id,_revision:receipt.data_revision,actual_usage_deletion:receipt.deletion};
  statusAcknowledgements.set(row.id,{databaseId:receipt.database_id,row});
  if(!state.snapshot.feedback.some(r=>r.id===row.id))state.snapshot.feedback.push(row);
  const deleted=new Set(receipt.deletion.record_ids);
  for(const [id] of inlineEditors)if(deleted.has(JSON.parse(id)[2]))inlineEditors.delete(id);
  for(const [id,value] of acknowledgedRecords)if(deleted.has(recordId(value.record)))acknowledgedRecords.delete(id);
  for(const [id,value] of recordSelections)if(deleted.has(value))recordSelections.delete(id);
  inlineNotices.set(groupKey,'记录已删除');render();
}
function futureView(outlook) {
  return `<section class="future-list" data-testid="planning-future"><p class="section-note">已排期和待安排的实验</p>${outlook.tasks.length?outlook.tasks.map((task,index)=>`<div class="future-item"><span class="future-date">${task.targetDate?dateLabel(task.targetDate):task.futureOnly?'前序完成后':'待安排'}</span>${taskView(task,index)}</div>`).join(''):'<p class="empty-plan">暂无后续实验安排。</p>'}${outlook.directions.length?`<h3 class="future-direction-heading">后续研究</h3>${outlook.directions.map(item=>`<details class="future-direction"><summary><span>${escape(item.title)}</span><small>${escape(item.label)}</small></summary><p>${escape(Array.isArray(item.when)?item.when.join('；'):item.when)}</p></details>`).join('')}`:''}</section>`;
}

function readLocation() {
  const params = new URLSearchParams(location.search);
  state.view=['future','hc'].includes(params.get('view'))?params.get('view'):'week';
  state.week = dateOkay(params.get('week')) ? mondayOf(params.get('week')) : state.snapshot?.default_week || mondayOf(beijingToday());
  state.selected = params.get('plan') && params.get('task') ? JSON.stringify([params.get('plan'),params.get('task')]) : null;
  if(state.selected && /^\d+$/.test(params.get('group')||''))groupSelections.set(state.selected,Number(params.get('group')));
  if (state.selected && state.snapshot && !params.has('week')) {
    const task = state.snapshot.plans.find(plan => plan.id === params.get('plan'))?.tasks?.find(item => item.id === params.get('task'));
    if (dateOkay(task?.target_date)) state.week = mondayOf(task.target_date);
  }
}
function writeLocation(replace=false) {
  const params = new URLSearchParams({week:state.week});
  if(state.view!=='week')params.set('view',state.view);
  if (state.selected) {const [plan,task]=JSON.parse(state.selected);params.set('plan',plan);params.set('task',task);params.set('group',String(groupSelections.get(state.selected)||0));}
  const url=location.pathname+'?'+params;
  if (location.pathname+location.search+location.hash!==url) history[replace?'replaceState':'pushState']({},'',url);
}
function planOptions(task,group,groupIndex,groupKey) {
  return `<details class="record-fold record-plan-options" data-record-fold="${escape(groupKey+'-plan')}" ${recordFolds.has(groupKey+'-plan')?'open':''}><summary>计划详情</summary>
    ${group.ratio?`<p class="record-plan-ratio"><span data-recipe-ratio>${escape(group.ratio)}</span>${confirmUI.addon(task,groupIndex,'ratio',null,group.ratio,group.name)}</p>`:''}
    <div class="record-plan-fields">${group.ingredients.map((item,ingredientIndex)=>`<div class="record-plan-field"><div><span data-full-recipe-name>${escape(item.name)}</span>${confirmUI.addon(task,groupIndex,'name',ingredientIndex,item.name,item.name)}</div><div><span data-full-recipe-amount>${escape(item.amount)}</span>${confirmUI.addon(task,groupIndex,'amount',ingredientIndex,item.amount,item.name)}</div></div>`).join('')}</div>${confirmUI.editor(task,groupIndex)}</details>`;
}
function recordGroup(task,group,groupIndex) {
  const groupKey=JSON.stringify([task.planId,task.id,groupIndex]);
  let records=recordsForGroup(state.snapshot,task,groupIndex);
  const acknowledged=acknowledgedRecords.get(groupKey);
  if(acknowledged?.databaseId===state.snapshot.database_id && acknowledged.record.saved_revision>state.snapshot.data_revision) {
    records=[acknowledged.record,...records.filter(item=>recordId(item)!==acknowledged.record.record_id && recordId(item)!==acknowledged.record.corrects_id)];
  }
  const selected=recordSelections.get(groupKey);
  const record=selected==='__new__'?null:records.find(item=>recordId(item)===selected) || records[0] || null;
  const rows=actualSummary(group,record);
  const savedGroup=recordBody(record).design_group;
  const aligned=savedGroup?.ingredients?.length===group.ingredients.length && savedGroup.ingredients.every((item,index)=>item.name===group.ingredients[index].name);
  const ratioGroup=savedGroup?.ratio?{...savedGroup,ingredients:group.ingredients}:aligned?savedGroup:group;
  const inline=usageUI.isEnabled() && !task.futureOnly;
  const completionStatus=completionForGroup(state.snapshot,task,groupIndex);
  if(inline)mountRequests.push({task:{...task,completionStatus},groupIndex,groupKey,record});
  const groupName=group.name.replace(/\s*·\s*(?:原始投料配方|投料配方)$/,'');
  const batch=recordBody(record).batch_label;
  return `<section class="record-group" data-record-group="${groupIndex}"><h4>${escape(groupName)}</h4><div class="group-status" data-group-status="${completionStatus}"><strong>${completionStatus==='completed'?'✓ 已完成':'未完成'}</strong>${statusControls({...task,groupIndex,completionStatus},true)}</div>
    ${records.length>0?`<div class="record-batch"><label>批次<select data-record-select="${escape(groupKey)}" data-focus="${escape('batch-'+groupKey)}" aria-label="${escape(groupName+'的记录批次')}">${records.map(item=>`<option value="${escape(recordId(item))}" ${recordId(item)===recordId(record)?'selected':''}>${escape(recordBody(item).batch_label || '未命名批次')}</option>`).join('')}</select></label></div>`:batch?`<p class="record-batch">批次：${escape(batch)}</p>`:''}
    ${ratioHTML(ratioGroup)}
    ${inline?`<div data-usage-inline="${escape(groupKey)}"></div>${inlineNotices.has(groupKey)?`<p class="inline-saved-notice" role="status">${escape(inlineNotices.get(groupKey))}</p>`:''}`:`<table class="record-table"><thead><tr><th scope="col">原料</th><th scope="col">实际用量</th></tr></thead><tbody>${rows.map(row=>`<tr><td><span data-recipe-name>${escape(row.name)}</span></td><td data-actual-amount>${escape(row.actual).replaceAll('；','<br>')}</td></tr>`).join('')}</tbody></table>`}
    ${planOptions(task,group,groupIndex,groupKey)}
  </section>`;
}
function recipeView(task) {
  const recipe=task.recipe;
  if(task.futureOnly)return '<div class="task-recipe"><p class="empty-recipe">后续实验，具体时间与操作条件待安排。</p></div>';
  if (!recipe) return '<div class="task-recipe"><p class="empty-recipe">配方与做法待补充。</p></div>';
  const selected=Math.min(groupSelections.get(key(task)) || 0,recipe.formulations.length-1);
  return `<div class="task-recipe" data-testid="planning-recipe">
    ${recipe.formulations.length>1?`<nav class="group-tabs" aria-label="选择实验组">${recipe.formulations.map((group,index)=>`<button data-select-group="${index}" aria-pressed="${selected===index}">${escape(group.name)} · ${completionForGroup(state.snapshot,task,index)==='completed'?'已完成':'未完成'}</button>`).join('')}</nav>`:''}
    <div class="recipe-materials single-experiment">${recordGroup(task,recipe.formulations[selected],selected)}</div>
    <details class="record-fold record-steps" data-record-fold="${escape(key(task)+'-steps')}" ${recordFolds.has(key(task)+'-steps')?'open':''}><summary>操作步骤</summary><ol>${recipe.steps.map(step=>`<li>${escape(step)}</li>`).join('')}</ol></details>
  </div>`;
}
function completionLabel(task) {
  const groups=task.recipe?.formulations || [];
  if(groups.length>1){const count=groups.filter((_,i)=>completionForGroup(state.snapshot,task,i)==='completed').length;return count===groups.length?'已完成':count?`已完成 ${count}/${groups.length} 组`:'未完成';}
  return task.completionStatus==='completed'?'已完成':'未完成';
}
const projectLabel = task => task.tone==='hc'?'硬碳负极':task.tone==='phd'?'博士课题':task.projectLabel;
function taskView(task,index) {
  const selected=state.selected===key(task);
  return `<article class="experiment ${['hc','phd'].includes(task.tone)?task.tone:'other'} ${selected?'expanded':''} ${task.completionStatus==='completed'?'experiment-completed':''}" data-testid="planning-task" data-plan-id="${escape(task.planId)}" data-task-id="${escape(task.id)}">
    <button class="experiment-title" data-action="task" data-plan="${escape(task.planId)}" data-task="${escape(task.id)}" data-focus="${escape(key(task))}" aria-expanded="${selected}" aria-controls="planning-detail">
      <span class="project-label">${escape(projectLabel(task))}</span><span class="experiment-index" aria-hidden="true">${String(index+1).padStart(2,'0')}</span><span class="experiment-name"><span class="completion-badge ${task.completionStatus==='completed'?'done':'pending'}">${completionLabel(task)}</span>${escape(task.title)}</span><span class="experiment-link">${selected?'收起配方':'配方与做法'}</span><span class="expand-indicator" aria-hidden="true">${diagonal}</span>
    </button>${statusControls(task)}
  </article>`;
}
function detailView(task) {
  if(!task)return '<section id="planning-detail" hidden></section>';
  return `<section id="planning-detail" data-testid="planning-detail" data-plan-id="${escape(task.planId)}" data-task-id="${escape(task.id)}" class="protocol-detail ${['hc','phd'].includes(task.tone)?task.tone:'other'}" aria-labelledby="protocol-title">
    <header class="protocol-heading"><div><span class="project-label">${escape(projectLabel(task))}</span><h3 id="protocol-title">${escape(task.title)}</h3></div><button class="close-detail" data-action="close" data-focus="close" aria-label="收起实验详情">收起${closeIcon}</button></header>
    <div class="detail-status"><strong>${completionLabel(task)}</strong>${statusControls(task,true)}</div>
    ${recipeView(task)}
  </section>`;
}
function showDetail(animate=false) {
  if(!state.selected)return;
  requestAnimationFrame(()=>document.getElementById('planning-detail')?.scrollIntoView({block:'start',behavior:animate&&!matchMedia('(prefers-reduced-motion: reduce)').matches?'smooth':'instant'}));
}
function closeDetail() {
  const selected=state.selected;
  state.selected=null;writeLocation();render();
  const button=app.querySelector(`[data-focus="${CSS.escape(selected || '')}"]`);
  button?.focus({preventScroll:true});button?.scrollIntoView({block:'nearest',behavior:'instant'});
}
function render() {
  if(state.view==='hc') {
    app.innerHTML=`<main id="main" class="planning container-xl" data-testid="planning-only"><header class="brand"><span class="brand-mark" aria-hidden="true">${flask}</span><h1>实验助手</h1><nav class="view-tabs" aria-label="实验范围"><button data-view="week">本周实验</button><button data-view="future">后续实验</button><button data-view="hc" aria-pressed="true">一体化硬碳负极</button></nav></header><div id="hc-host"></div></main>`;
    hcWorkspace.mount(document.getElementById('hc-host'));
    return;
  }
  const activeInline=document.activeElement?.closest('.usage-inline')?document.activeElement:null;
  mountRequests=[];
  const focused=document.activeElement?.dataset?.focus,scrollY=window.scrollY;
  const selection = document.activeElement?.tagName === 'INPUT' ? [document.activeElement.selectionStart,document.activeElement.selectionEnd] : null;
  const today=beijingToday(),current=state.week===mondayOf(today);
  const week=state.snapshot ? planningWeek(state.snapshot,state.week) : null;
  let taskIndex=0;
  const outlook=state.snapshot?planningOutlook(state.snapshot,state.week):{tasks:[],directions:[]};
  const allTasks=week?[...new Map([...(state.view==='future'?outlook.tasks:[...week.days.flatMap(day=>day.tasks),...week.undated])].map(task=>[key(task),task])).values()]:[];
  const matches=task=>state.filter==='all'||task.completionStatus===state.filter;
  const days=(week?.days || []).map(day=>({...day,tasks:day.tasks.filter(matches)})).filter(day=>day.tasks.length);
  const any=days.some(day=>day.tasks.length) || Boolean(week?.undated?.some(matches));
  const selectedTask=allTasks.find(task=>key(task)===state.selected);
  app.innerHTML=`<main id="main" class="planning container-xl" data-testid="planning-only">
    <header class="brand"><span class="brand-mark" aria-hidden="true">${flask}</span><h1>实验助手</h1><nav class="view-tabs" aria-label="实验范围"><button data-view="week" aria-pressed="${state.view==='week'}">本周实验</button><button data-view="future" aria-pressed="${state.view==='future'}">后续实验</button><button data-view="hc" aria-pressed="false">一体化硬碳负极</button></nav></header>
    <section class="plan-heading"><h2>${state.view==='future'?'后续实验':current?'本周实验':'实验安排'}</h2><nav class="week-switcher" aria-label="选择周次">
      <button class="icon-button previous" data-action="previous" data-focus="previous" aria-label="上一周">${arrow}</button>
      <span>${dateLabel(state.week)} — ${dateLabel(shiftDate(state.week,6))}</span>
      <button class="icon-button" data-action="next" data-focus="next" aria-label="下一周">${arrow}</button>
      ${current?'': '<button class="this-week" data-action="today" data-focus="today">本周</button>'}<button data-action="latest" data-focus="latest">最近实验</button>
    </nav></section>
    ${week && state.view==='week'?`<nav class="completion-filters" aria-label="按完成状态筛选">${[['all','全部'],['incomplete','未完成'],['completed','已完成']].map(([value,label])=>`<button data-completion-filter="${value}" aria-pressed="${state.filter===value}">${label} ${allTasks.filter(task=>value==='all'||task.completionStatus===value).length}</button>`).join('')}</nav>`:''}
    ${state.error?`<div class="read-error" role="status">${state.snapshot?'连接中断，暂显示上次安排。':'暂时无法读取实验安排。'}<button data-action="retry" data-focus="retry">重试</button></div>`:''}
    ${!week?`<p class="empty-plan" role="status">${state.error?'请刷新网页重试。':'正在读取实验安排…'}</p>`:state.view==='future'?futureView(outlook):any?
      `<div class="day-list" data-testid="planning-days">${days.map(day=>`<section class="plan-day ${day.date===today?'today':''}" data-date="${day.date}"><h3 class="day-heading"><span class="day-weekday">周${weekdayLabel(day.date)}</span><time datetime="${day.date}" aria-label="${day.date.slice(0,4)}年${dateLabel(day.date)}"><span class="date-number">${Number(day.date.slice(8,10))}</span><span class="date-month">${Number(day.date.slice(5,7))}月</span></time>${day.date===today?'<span class="today-label">今天</span>':''}</h3><div class="day-experiments">${day.tasks.length?day.tasks.map(task=>taskView(task,taskIndex++)).join(''):'<p class="day-empty">暂无安排</p>'}</div></section>`).join('')}</div>
      ${week.undated.filter(matches).length?`<section class="plan-day undated"><h3>待安排</h3><div class="day-experiments">${week.undated.filter(matches).map(task=>taskView(task,taskIndex++)).join('')}</div></section>`:''}`
      :'<p class="empty-plan">这周还没有实验安排。</p>'}
    
    ${detailView(selectedTask)}
<p class="cloud-sync">只读展示 · 快照时间：${escape(state.snapshot?.generated_at_label||"加载中")} · 数据版本 r${state.snapshot?.data_revision||""}。本机记录更新后需重新导出发布。</p>
  </main>`;
  for(const request of mountRequests) {
    const {task,groupIndex,groupKey,record}=request;
    const editorKey=JSON.stringify([state.snapshot.database_id,groupKey,recordId(record)||'__new__']);
    if(!inlineEditors.has(editorKey)) {
      const editor=createUsageUI({embedded:true,getSnapshot:()=>state.snapshot,onSaved:async()=>{const ok=await refresh();render();return ok;},onSelectRecord:(id,options)=>{recordSelections.set(groupKey,id);render();if(options?.edit)inlineEditors.get(JSON.stringify([state.snapshot.database_id,groupKey,id]))?.edit();},onNew:()=>{recordSelections.set(groupKey,'__new__');inlineNotices.delete(groupKey);render();},onRecordDeleted:receipt=>applyDeletion(receipt,groupKey),onRecordSaved:(id,record,databaseId,receipt)=>{acknowledgeStatus(receipt);if(databaseId!==state.snapshot.database_id)return;recordSelections.set(groupKey,id);if(record)acknowledgedRecords.set(groupKey,{databaseId,record:{...record,record_id:id,is_latest:true}});for(const [key,value] of inlineEditors)if(value===editor)inlineEditors.delete(key);inlineEditors.set(JSON.stringify([databaseId,groupKey,id]),editor);render();}});
      inlineEditors.set(editorKey,editor);
    }
    const host=[...app.querySelectorAll('[data-usage-inline]')].find(el=>el.dataset.usageInline===groupKey);
    inlineEditors.get(editorKey).mount(host,{...task,groupIndex},record);
  }
  for(const button of app.querySelectorAll('button'))button.classList.add('btn','btn-sm');
  if(activeInline?.isConnected)activeInline.focus({preventScroll:true});
  state.renderDay=today;
  if(focused){const target=app.querySelector(`[data-focus="${CSS.escape(focused)}"]`);target?.focus({preventScroll:true});if(selection?.[0]!=null&&target?.setSelectionRange)target.setSelectionRange(...selection);}
  window.scrollTo(0,scrollY);
}
let refreshRunning = false;
const refreshWaiters = [];
function refresh() {
  const result = new Promise(resolve => refreshWaiters.push(resolve));
  if (!refreshRunning) drainSnapshotReads();
  return result;
}
async function drainSnapshotReads() {
  refreshRunning = true;
  try {
    while (refreshWaiters.length) {
      const waiting = refreshWaiters.splice(0);
      const success = await readSnapshot();
      waiting.forEach(resolve => resolve(success));
    }
  } finally { refreshRunning = false; }
}
async function readSnapshot() {
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),10000);
  try {
    const response=await fetch('./planning.json',{cache:'no-store',headers:{Accept:'application/json'},signal:controller.signal});
    if(!response.ok)throw new Error('读取失败');
    const snapshot=await response.json();
    for(const [id,entry] of statusAcknowledgements) {
      if(entry.databaseId!==snapshot.database_id || snapshot.data_revision>=entry.row._revision)statusAcknowledgements.delete(id);
      else if(!snapshot.feedback.some(row=>row.id===id))snapshot.feedback.push(entry.row);
    }
    if(!Array.isArray(snapshot.plans)||!Array.isArray(snapshot.projects)||!Number.isInteger(snapshot.data_revision))throw new Error('快照无效');
    const changed=!state.snapshot||snapshot.database_id!==state.snapshot.database_id||snapshot.data_revision!==state.snapshot.data_revision||state.error||state.renderDay!==beijingToday();
    state.snapshot=snapshot;state.error=false;
    const firstRead=!state.initialized;
    if(firstRead){readLocation();writeLocation(true);state.initialized=true;}
    if(changed)render();
    if(firstRead)showDetail();
    return true;
  } catch {
    if(!state.error){state.error=true;render();}
    return false;
  } finally {clearTimeout(timeout);}
}
app.addEventListener('click',event=>{
  const groupButton=event.target.closest('[data-select-group]');if(groupButton){groupSelections.set(state.selected,Number(groupButton.dataset.selectGroup));writeLocation();render();return;}
  const view=event.target.closest('[data-view]');if(view){state.view=view.dataset.view;state.selected=null;writeLocation();render();return;}
  const filter=event.target.closest('[data-completion-filter]');if(filter){state.filter=filter.dataset.completionFilter;render();return;}
  const status=event.target.closest('[data-experiment-action]');
  if(status){const {statusPlan:plan,statusTask:task,experimentAction:action,statusGroup}=status.dataset;const groupIndex=statusGroup===undefined?undefined:Number(statusGroup);if(action==='edit'){state.selected=JSON.stringify([plan,task]);if(Number.isInteger(groupIndex))groupSelections.set(state.selected,groupIndex);writeLocation();render();for(const request of mountRequests){const editorKey=JSON.stringify([state.snapshot.database_id,request.groupKey,recordId(request.record)||'__new__']);inlineEditors.get(editorKey)?.edit();}showDetail();}else void changeStatus(plan,task,action,groupIndex);return;}

  if(confirmUI.isSaving()||usageUI.isBusy())return;
  if(usageUI.click(event)||confirmUI.click(event)||researchUI.click(event))return;
  const button=event.target.closest('button[data-action]');if(!button)return;
  const action=button.dataset.action;
  if(action==='retry'){refresh();return;}
  if(action==='close'){closeDetail();return;}
  if(action==='task'){
    const selected=JSON.stringify([button.dataset.plan,button.dataset.task]);state.selected=state.selected===selected?null:selected;
  }else{
    state.view='week';state.week=action==='latest'?state.snapshot.default_week:action==='today'?mondayOf(beijingToday()):shiftDate(state.week,action==='previous'?-7:7);state.selected=null;
  }
  writeLocation();render();
  if(action==='task')showDetail(true);
});
app.addEventListener('input',event=>{if(event.target.closest('.usage-inline')){const group=event.target.closest('[data-usage-inline]');if(group)inlineNotices.delete(group.dataset.usageInline);event.target.closest('.record-group')?.querySelector('.inline-saved-notice')?.remove();}else confirmUI.input(event);});
app.addEventListener('change',event=>{
  const select=event.target.closest('[data-record-select]');
  if(select){recordSelections.set(select.dataset.recordSelect,select.value);render();}
});
app.addEventListener('toggle',event=>{
  if(!event.target.matches('[data-record-fold]') || !event.target.isConnected)return;
  if(event.target.open)recordFolds.add(event.target.dataset.recordFold);else recordFolds.delete(event.target.dataset.recordFold);
},true);
app.addEventListener('submit',event=>{if(!event.target.matches('[data-usage-form]'))confirmUI.submit(event);});
window.addEventListener('beforeunload',event=>{if([...inlineEditors.values()].some(editor=>editor.isDirty()||editor.isBusy())){event.preventDefault();event.returnValue='';}});
document.addEventListener('keydown',event=>{if(usageUI.isOpen())return;if(event.key==='Escape'&&state.selected){event.preventDefault();if(confirmUI.isSaving()||confirmUI.cancel())return;closeDetail();}});
window.addEventListener('popstate',()=>{readLocation();render();});
window.addEventListener('online',()=>refresh());
window.addEventListener('offline',()=>{state.error=true;render();});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')refresh();});
readLocation();render();refresh();



if(false) {
  const events=null;
  events.addEventListener('revision',()=>refresh());
  events.onopen=()=>refresh();
}

