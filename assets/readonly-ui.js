import {ratioSummary} from './ratio-source.js';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const no=()=>false, empty=()=>'';
export function ratioHTML(group){const ratios=ratioSummary(group);return ratios.length?ratios.map(r=>`<div class="recipe-ratio-summary"><strong>配方比例：<span data-ratio-value>${esc(r.ratio)}</span></strong><small>${esc(r.names.join(' : '))}（${esc(r.basis)}）</small></div>`).join(''):'<p>配方比例：未设置</p>';}
export const createUsageUI=()=>({isEnabled:no,isBusy:no,isOpen:no,click:no});
export const createConfirmationUI=()=>({addon:empty,editor:empty,isSaving:no,click:no,input:no,submit:no,cancel:no});
export const createResearchUI=()=>({click:no});
