// Read-only quantities for the basic record table. Record identity follows the
// actual-usage endpoint: same plan, unique full-formulation source, then group.
const list = value => Array.isArray(value) ? value : [];
const rows = value => Array.isArray(value) ? value : Object.values(value || {});
const retired = new Set(['superseded','archived','cancelled','canceled']);
const invalidRecords = new Set(['superseded','retracted','invalid','withdrawn']);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);

function equal(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => own(right,key) && equal(left[key],right[key]));
}
function protocol(task) {
  const q = task?.quick_protocol;
  if (q?.version !== 1 || !Array.isArray(q.formulations) || !q.formulations.length) return null;
  try {
    if (!equal(JSON.parse(q.source_signature), {procedure:task.procedure || [], bench_parameters:task.bench_parameters || [], parameters_status:task.parameters_status || ''})) return null;
  } catch { return null; }
  return q;
}
const sameFormulation = (left, right) => equal(left?.ingredients,right?.ingredients)
  && equal(own(left,'ratio') ? left.ratio : '', own(right,'ratio') ? right.ratio : '');

/** Resolve only explicit source links, matching the backend's complete ordered
 * ingredient list and ratio. Missing, cyclic or ambiguous sources return null. */
export function groupTarget(snapshot, task, groupIndex) {
  const planId = task?.planId || task?.plan_id;
  if (!planId || !task?.id || !Number.isInteger(groupIndex) || groupIndex < 0 || groupIndex > 1000) return null;
  const plans = rows(snapshot?.plans).filter(plan => plan.id === planId);
  if (plans.length !== 1) return null;
  const plan = plans[0];
  if (retired.has(plan.status) || plan.archived_at) return null;
  const tasks = list(plan.tasks), currentMatches = tasks.filter(item => item.id === task.id);
  if (currentMatches.length !== 1) return null;
  const current = currentMatches[0], projectId = current.project_id;
  if ((current.kind || 'experiment') !== 'experiment' || retired.has(current.status) || !rows(snapshot?.projects).some(project => project.id === projectId)) return null;
  const seen = new Set();
  function upstream(item,index) {
    const marker = JSON.stringify([item.id,index]);
    if (seen.has(marker)) return null;
    seen.add(marker);
    const q = protocol(item);
    if (!q || index >= q.formulations.length || !q.formulations[index]) return null;
    const refs = q.formulation_source_task_ids ?? [];
    if (!Array.isArray(refs) || refs.some(ref => typeof ref !== 'string') || new Set(refs).size !== refs.length) return null;
    const matches = [];
    for (const sourceId of refs) {
      const sources = tasks.filter(source => source.id === sourceId);
      if (sources.length !== 1 || sources[0].project_id !== projectId) return null;
      const source = sources[0], sourceProtocol = protocol(source);
      if (!sourceProtocol) return null;
      sourceProtocol.formulations.forEach((group,sourceIndex) => {
        if (sameFormulation(group,q.formulations[index])) matches.push([source,sourceIndex]);
      });
    }
    if (matches.length > 1) return null;
    if (matches.length) return upstream(...matches[0]);
    return {plan_id:planId, task_id:item.id, group_index:index, project_id:projectId};
  }
  return upstream(current,groupIndex);
}

export const recordBody = record => record?.actual_usage || record || {};
export const recordId = record => record?.record_id || recordBody(record).record_id || record?.id || '';

function completionReport(snapshot, task, groupIndex) {
  const deleted=deletedUsageIds(snapshot,{project_id:task.projectId || task.project_id});
  const planId=task.planId || task.plan_id;
  const reports=rows(snapshot?.feedback).filter(row=>{
    const status=row.experiment_status;
    return status?.version===1 && status.scope==='experiment_completion_user_report'
      && ['completed','incomplete'].includes(status.state)
      && !deleted.has(status.usage_record_id)
      && (groupIndex===undefined || (Number.isInteger(status.group_index)?status.group_index:
        row.actual_usage_request?.group_index ?? (taskGroups(snapshot,task).length===1?0:null))===groupIndex)
      && status.plan_id===planId && status.task_id===task.id
      && status.project_id===(task.projectId || task.project_id) && row.project_id===status.project_id
      && !invalidRecords.has(row.status) && !row.retracted_at && !row.withdrawn_at;
  }).sort((a,b)=>Number(b._revision||0)-Number(a._revision||0) || String(b.submitted_at||'').localeCompare(String(a.submitted_at||'')));
  return reports[0]?.experiment_status.state==='completed'?'completed':reports.length?'incomplete':groupIndex===undefined && ['completed','done'].includes(task.status)?'completed':'incomplete';
}

function taskGroups(snapshot,task) {
  const raw=rows(snapshot?.plans).find(p=>p.id===(task.planId||task.plan_id))?.tasks?.find(t=>t.id===task.id);
  return protocol(raw)?.formulations || [];
}
export function completionForGroup(snapshot,task,index) { return completionReport(snapshot,task,index); }
export function completionForTask(snapshot,task) {
  const groups=taskGroups(snapshot,task);
  return groups.length?groups.every((_,index)=>completionForGroup(snapshot,task,index)==='completed')?'completed':'incomplete':completionReport(snapshot,task);
}

const decimalValue = value => (typeof value === 'string' || typeof value === 'number')
  && /^\d+(?:\.\d+)?$/.test(String(value)) && Number.isFinite(Number(value)) ? String(value) : null;
const clone = value => JSON.parse(JSON.stringify(value));
function ingredientIdentity(name) {
  const text = String(name || '').normalize('NFKC').replace(/\s+/g,'').toLowerCase();
  const base = text.replace(/[（(].*$/,'');
  if (/^(?:商业)?硬碳(?:hc)?$/.test(base) || base === 'hc') return 'hard_carbon';
  if (/^(?:同批|原始)?石墨(?:g)?$/.test(base) || base === 'g') return 'graphite';
  if (['superp','super_p'].includes(base)) return 'Super_P';
  if (base === 'cmc') return 'CMC';
  if (['sa','海藻酸钠'].includes(base)) return 'SA';
  if (base === '木质素') return 'lignin';
  if (['fe盐','fecl3·6h2o','fecl3.6h2o'].includes(base)) return 'Fe_salt';
  if (['mo盐','na2moo4·2h2o','na2moo4.2h2o'].includes(base)) return 'Mo_salt';
  if (['moo3','三氧化钼'].includes(base)) return 'MoO3';
  if (['mn3o4','四氧化三锰'].includes(base)) return 'Mn3O4';
  if (base === '氧化物') return 'oxide';
  if (['淀粉','淀粉原样','可溶性淀粉'].includes(base)) return 'starch';
  if (base === '可溶性淀粉母液' && /名义引入\d+(?:\.\d+)?mg淀粉/.test(text)) return 'starch';
  if (['水','去离子水','蒸馏水','屈臣氏蒸馏水'].includes(base)) return 'water';
  if (base === '乙醇') return 'ethanol';
  return null;
}
function targetGroup(snapshot,target) {
  return rows(snapshot?.plans).find(plan=>plan.id===target.plan_id)?.tasks?.find(task=>task.id===target.task_id)
    ?.quick_protocol?.formulations?.[target.group_index];
}
function historicalRecord(snapshot,target) {
  const group = targetGroup(snapshot,target), ref = group?.historical_actual_ref;
  if (!ref?.experiment_id || !ref.batch_id || !ref.source_feedback_id || !Array.isArray(ref.ingredient_fields)) return null;
  const experiments = rows(snapshot?.experiments).filter(item=>item.id===ref.experiment_id && item.project_id===target.project_id);
  const feedback = rows(snapshot?.feedback).filter(item=>item.id===ref.source_feedback_id && item.project_id===target.project_id
    && item.experiment_id===ref.experiment_id && !invalidRecords.has(item.status) && !item.retracted_at && !item.withdrawn_at);
  if (experiments.length !== 1 || feedback.length !== 1) return null;
  const experiment = experiments[0], parameters = experiment.parameters;
  if (!parameters || invalidRecords.has(experiment.status)) return null;
  const ingredients = list(group.ingredients), seen = new Set(), entries = [], parts = [];
  for (const field of ref.ingredient_fields) {
    const index = field.ingredient_index, item = ingredients[index], path = field.parameter_path;
    if (!Number.isInteger(index) || !item || seen.has(index) || !Array.isArray(path) || path.length !== 2) return null;
    seen.add(index);
    const identity = ingredientIdentity(item.name);
    const mass = path[0] === 'actual_dry_mass_mg' && ['hard_carbon','Super_P','CMC'].includes(path[1]);
    const water = path[0] === 'water' && path[1] === 'volume';
    if ((!mass && !water) || identity !== (mass ? path[1] : 'water') || field.unit !== (mass?'mg':'mL')
      || (water && parameters.water?.unit !== field.unit)) return null;
    const quantity = decimalValue(parameters[path[0]]?.[path[1]]);
    if (quantity === null) return null;
    if (mass) {
      const value = decimalValue(parameters.target_dry_mass_ratio?.[path[1]]);
      if (value === null) return null;
      parts.push({ingredient_index:index,value});
    }
    entries.push({key:`ingredient-${index}`,ingredient_index:index,name:item.name,quantity,unit:field.unit,
      design_amount:`计划用量未记录（${field.unit}）`});
  }
  if (!entries.length || parts.length !== 3 || !parts.some(part=>Number(part.value)>0)) return null;
  const design = clone(group);
  delete design.historical_actual_ref;
  design.ingredients = ingredients.map((item,index)=>({...clone(item),amount:entries.find(entry=>entry.ingredient_index===index)?.design_amount || '计划用量未记录'}));
  design.planned_ratio = {version:1,basis:'dry_mass',parts,source_ids:[experiment.id,feedback[0].id]};
  design.ratio = parts.map(part=>ingredients[part.ingredient_index].name).join('∶')+'＝'+parts.map(part=>part.value).join('∶')+'（干质量）';
  return {...target,record_id:`HISTORICAL-USAGE:${experiment.id}:${ref.batch_id}`,historical:true,is_latest:true,
    scope:'historical_experiment_projection',batch_label:'既有 HC-REF 批次',batch_id:ref.batch_id,
    source_experiment_id:experiment.id,source_feedback_id:feedback[0].id,source_ids:[experiment.id,feedback[0].id],
    date_interval:clone(experiment.date_interval || feedback[0].date_interval || null),occurred_at:null,
    recorded_at:feedback[0].submitted_at || null,entries,design_group:design};
}

/** Current records remain separate batches; no material-name lookup, unit
 * summation, or merging of records with the same batch label takes place. */
export function recordsForGroup(snapshot, task, groupIndex) {
  const target = groupTarget(snapshot,task,groupIndex);
  if (!target) return [];
  const deleted=deletedUsageIds(snapshot,target);
  const matches = rows(snapshot?.feedback).filter(row => {
    const usage = row.actual_usage;
    return usage && typeof usage === 'object' && row.project_id === target.project_id
      && ['plan_id','task_id','group_index','project_id'].every(key => usage[key] === target[key]);
  }).sort((a,b) => (Number(b._revision || 0) - Number(a._revision || 0))
    || String(b.submitted_at || '').localeCompare(String(a.submitted_at || ''))
    || String(b.id || '').localeCompare(String(a.id || '')));
  // Match the endpoint: even a later withdrawn correction must not silently
  // revive its older measurement as the current record.
  const corrected = new Set(matches.map(row => row.actual_usage.corrects_id).filter(Boolean));
  const result = matches.filter(row => !invalidRecords.has(row.status) && !row.retracted_at && !row.withdrawn_at && !corrected.has(row.id))
    .map(row => ({...row.actual_usage, record_id:row.id, is_latest:true}));
  const historical = historicalRecord(snapshot,target);
  if (historical && !corrected.has(historical.record_id) && !result.some(record=>record.source_experiment_id===historical.source_experiment_id && record.batch_id===historical.batch_id)) result.push(historical);
  return result.filter(record=>!deleted.has(recordId(record)));
}

export function deletedUsageIds(snapshot,target={}) {
  return new Set(rows(snapshot?.feedback).flatMap(row=>{
    const d=row.actual_usage_deletion;
    return d?.version===1 && d.scope==='actual_usage_deletion_user_report' && row.project_id===d.project_id
      && Object.entries(target).every(([key,value])=>d[key]===value) && Array.isArray(d.record_ids)?d.record_ids:[];
  }));
}

const mixedSolvent = name => ['水＋乙醇','水+乙醇'].includes(String(name || '').replace(/\s+/g,''));
const quantityText = entry => entry && entry.quantity !== '' && entry.quantity !== null && entry.quantity !== undefined
  && /^(?:\d+)(?:\.\d+)?$/.test(String(entry.quantity)) && typeof entry.unit === 'string' && entry.unit.trim()
  ? `${entry.quantity} ${entry.unit}` : '—';

function namedRatio(value) {
  const text = String(value || ''), match = text.match(/^([^＝=；;]+)[＝=]\s*(\d+(?:\.\d+)?(?:\s*[:∶：]\s*\d+(?:\.\d+)?)+)\s*(?=$|[（(;；])/);
  if (!match) return null;
  const names = match[1].split(/[:∶：]/).map(name=>name.trim()), values = match[2].split(/[:∶：]/).map(value=>value.trim());
  if (names.length !== values.length || !values.some(value=>Number(value)>0)) return null;
  const identities = names.map(ingredientIdentity);
  if (identities.some(identity=>!identity) || new Set(identities).size!==identities.length) return null;
  const map = new Map(identities.map((identity,index)=>[identity,values[index]]));
  // This known historical weighing was once mislabeled as a design ratio.
  if (Number(map.get('hard_carbon'))===905 && Number(map.get('Super_P'))===56.5 && Number(map.get('CMC'))===45.4) return null;
  return {map,names,basis:/体积/.test(text)?'volume':/干质量|干料/.test(text)?'dry_mass':'mass'};
}

/** Ratio parts are read only from explicit ratio data. Amounts in mg or mL do
 * not become ratio parts. Names match identities, never their row positions. */
export function ratioRows(group) {
  const ingredients=list(group?.ingredients), result=ingredients.map((item,index)=>({ingredientIndex:index,display:'—',value:'',basis:'',components:[]}));
  const labels = {dry_mass:'干质量',mass:'质量',volume:'体积'};
  function assign(index,value,basis) {
    const row=result[index], starch=ingredientIdentity(ingredients[index]?.name)==='starch' && /母液/.test(ingredients[index]?.name);
    row.value=value;row.basis=basis;row.display=`${value} ${starch&&basis!=='volume'?'淀粉质量':basis==='volume'?'体积':'质量'}份`;
  }
  // The confirmation endpoint updates ratio text without rewriting metadata.
  // A present current text must therefore never fall back to older parts.
  const hasRatioText = own(group,'ratio') && group.ratio !== null && String(group.ratio).trim() !== '';
  if (!hasRatioText && own(group,'planned_ratio')) {
    const ratio=group.planned_ratio, parts=ratio?.parts, seen=new Set();
    if (ratio?.version===1 && own(labels,ratio.basis) && Array.isArray(parts) && parts.length>1 && parts.every(part=>{
      const index=part.ingredient_index;
      if(!Number.isInteger(index)||!ingredients[index]||seen.has(index)||decimalValue(part.value)===null)return false;
      seen.add(index);return true;
    }) && parts.some(part=>Number(part.value)>0)) parts.forEach(part=>assign(part.ingredient_index,String(part.value),ratio.basis));
  } else if (hasRatioText) {
    const parsed=namedRatio(group?.ratio);
    if(parsed) {
      const located=[...parsed.map].map(([identity,value])=>({identity,value,indices:ingredients.flatMap((item,index)=>ingredientIdentity(item.name)===identity?[index]:[])}));
      if(located.every(row=>row.indices.length===1 || (!row.indices.length && row.identity==='oxide' && Number(row.value)===0))) {
        located.forEach(row=>{if(row.indices.length)assign(row.indices[0],row.value,parsed.basis);});
      }
    }
  }
  ingredients.forEach((item,index)=>{
    if(!mixedSolvent(item.name))return;
    const expression=String(item.amount || '').match(/(?:水\s*[:∶：]\s*乙醇|乙醇\s*[:∶：]\s*水)\s*[＝=]\s*\d+(?:\.\d+)?\s*[:∶：]\s*\d+(?:\.\d+)?\s*[（(]体积比[）)]/);
    const parsed=namedRatio(expression?.[0]);
    if(!parsed || parsed.basis!=='volume' || !parsed.map.has('water') || !parsed.map.has('ethanol'))return;
    result[index].basis='volume';
    result[index].components=[['water','水'],['ethanol','乙醇']].map(([component,name])=>({component,name,value:parsed.map.get(component),basis:'volume',display:`${parsed.map.get(component)} 体积份`}));
    result[index].display=`水 ${parsed.map.get('water')}、乙醇 ${parsed.map.get('ethanol')} 体积份`;
  });
  return result;
}

/** One complete, unreduced ratio per basis; solvents remain separate. */
export function ratioSummary(group) {
  const rows=ratioRows(group), result=[];
  for(const basis of ['dry_mass','mass','volume']) {
    const parts=rows.filter(row=>row.value!=='' && row.basis===basis);
    if(parts.length>1)result.push({ratio:parts.map(row=>row.value).join(':'),
      names:parts.map(row=>{const name=group.ingredients[row.ingredientIndex].name;return ingredientIdentity(name)==='starch' && /母液/.test(name)?'淀粉（由母液引入）':name;}),basis:basis==='volume'?'体积比':'质量比'});
  }
  const explicit=namedRatio(group?.ratio);
  // A zero-loading reference can explicitly name an absent component (OX-G).
  if(!result.length && explicit?.map.get('oxide')==='0' && rows.filter(row=>row.value!=='').length===1) {
    result.push({ratio:[...explicit.map.values()].join(':'),names:explicit.names,basis:'质量比'});
  }
  for(const row of rows)if(row.components.length>1)result.push({ratio:row.components.map(part=>part.value).join(':'),names:row.components.map(part=>part.name),basis:'体积比'});
  return result;
}

/** One result per planned ingredient. components allows the table to display
 * water and ethanol on separate rows without adding them or assuming ratios.
 * Record values are unescaped text; HTML callers must escape them. */
export function actualSummary(group, record) {
  const body = recordBody(record), ingredients = list(group?.ingredients), saved = list(body.design_group?.ingredients);
  // Read a batch against its saved planned amounts. A changed ingredient schema
  // is not remapped by names: history retains the original complete entry.
  const aligned = saved.length === ingredients.length && saved.every((item,index) => item?.name === ingredients[index]?.name);
  const entries = list(body.entries);
  function find(index,component) {
    if (!aligned) return null;
    const key = `ingredient-${index}${component?'-'+component:''}`;
    const found = entries.filter(entry => entry.key === key && entry.ingredient_index === index
      && (component ? entry.component === component : !entry.component));
    return found.length === 1 ? found[0] : null;
  }
  return ingredients.map((item,index) => {
    const plannedAmount = aligned ? saved[index].amount : item.amount;
    const result = {ingredientIndex:index,name:item.name,plannedAmount,actual:'—',actualName:'',components:[]};
    if (mixedSolvent(item.name)) {
      result.components = [['water','水'],['ethanol','乙醇']].map(([component,name]) => {
        const entry = find(index,component);
        const match = String(plannedAmount || '').match(new RegExp(`${name}\\s+(\\d+(?:\\.\\d+)?\\s*mL)\\b`));
        return {component,name,plannedAmount:match?.[1] || '待确认',actual:quantityText(entry),actualName:entry?.actual_name || ''};
      });
      if (result.components.some(part => part.actual !== '—')) result.actual = result.components.map(part => `${part.name} ${part.actual}`).join('；');
    } else {
      const entry = find(index);
      result.actual = quantityText(entry);
      result.actualName = entry?.actual_name || '';
    }
    return result;
  });
}
