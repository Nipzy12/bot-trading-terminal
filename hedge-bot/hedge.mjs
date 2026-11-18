function decide(state,q,cfg){
 if(!q||!Number.isFinite(q.bid)||!Number.isFinite(q.ask)||q.bid<=0||q.ask<q.bid||!Number.isFinite(q.ageMs)||q.ageMs<0||q.ageMs>10000)return {status:"STALE",close:[],open:null};
 if(!Number.isFinite(state.equity)||!Number.isFinite(state.peakEquity)||state.peakEquity<=0||!Array.isArray(state.positions)||state.positions.some(p=>!Number.isFinite(p.netPnl)||!Number.isFinite(p.entry)||!["BUY","SELL"].includes(p.side)))return {status:"INVALID_STATE",close:[],open:null};
 const drawdown=(state.peakEquity-state.equity)/state.peakEquity;
 if(drawdown>=cfg.maxDrawdown)return {status:"EMERGENCY",close:state.positions.map(p=>p.id),open:null};
 const close=state.positions.filter(p=>p.netPnl>=cfg.target).map(p=>p.id);
 if(close.length)return {status:"HARVEST",close,open:null};
 if(state.paused||state.positions.length>=cfg.maxPositions||q.ask-q.bid>cfg.maxSpread||!["BUY","SELL"].includes(q.signal)||!Number.isFinite(q.time)||!Number.isFinite(state.lastEntryTime)||q.time-state.lastEntryTime<cfg.cooldownMs)return {status:"HOLD",close:[],open:null};
 const entry=q.signal==="BUY"?q.ask:q.bid;
 if(state.positions.some(p=>p.side===q.signal&&Math.abs(p.entry-entry)<cfg.gridDistance))return {status:"GRID_WAIT",close:[],open:null};
 return {status:"PAPER_ENTRY",close:[],open:{side:q.signal,volume:cfg.volume,entry}};
}
export { decide };
