const DAY=86400000;
export function beijingToday(now=new Date()){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);}
export function shiftDate(d,n){return new Date(Date.parse(d+'T00:00:00Z')+n*DAY).toISOString().slice(0,10);}
export function mondayOf(d){return shiftDate(d,-(new Date(d+'T00:00:00Z').getUTCDay()+6)%7);}
export function planningWeek(s,w){const d=mondayOf(w);return s.weeks[d]||{weekStart:d,weekEnd:shiftDate(d,6),days:[],undated:[]};}
export function planningOutlook(s,w){return s.outlooks[mondayOf(w)]||{tasks:[],directions:[]};}
