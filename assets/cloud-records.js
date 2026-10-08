export {ratioSummary} from './ratio-source.js';
export const recordBody=r=>r||{};
export const recordId=r=>r?.record_id||'';
export const completionForGroup=(snapshot,task,i)=>task.recipe?.formulations?.[i]?.completionStatus||'incomplete';
export const recordsForGroup=(snapshot,task,i)=>task.recipe?.formulations?.[i]?.records||[];
export const actualSummary=(group,record)=>record?.rows||group.ingredients.map((r,i)=>({ingredientIndex:i,name:r.name,actual:'—'}));
