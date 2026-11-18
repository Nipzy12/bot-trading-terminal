package com.lumavun.hedge;

import android.content.SharedPreferences;
import android.os.Handler;
import org.json.*;
import okhttp3.*;
import java.math.*;
import java.time.OffsetDateTime;
import java.util.*;
import java.util.concurrent.*;

final class LiveBroker {
 interface Observer {
  void update(String status,String symbol,String reason,JSONObject account,JSONArray positions,JSONObject newDeal);
 }
 final ExnessClient api; final SharedPreferences prefs; final Handler ui; final Observer observer;
 final String ledger; final String preferred;
 final OkHttpClient socketClient=new OkHttpClient.Builder().followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false).pingInterval(15,TimeUnit.SECONDS).build();
 final ExecutorService worker=Executors.newSingleThreadExecutor();
 final Map<String,JSONObject> positions=new LinkedHashMap<>();
 final Set<String> owned=new LinkedHashSet<>();
 final LiveRules.Signal signal=new LiveRules.Signal();
 volatile boolean active=false; boolean ready=false,closing=false,finished=false;
 WebSocket ticks,events; String status="STOPPED",symbol="",currency="",lastReason=""; JSONObject account;
 BigDecimal contract,multiplier,leverage,bid,ask,peak=BigDecimal.ZERO; long tickTime,stateTime,started,lastAction;
 String pendingKey,pendingOperation,pendingSide,pendingPosition; long pendingAt; JSONObject bufferedEvent;
 int maxMessage=16384;
 final Runnable watchdog=new Runnable(){public void run(){
  if(!active)return;long now=System.currentTimeMillis();
  if(pendingKey!=null&&now-pendingAt>25000){halt("ORDER UNKNOWN • cek broker, jangan kirim ulang");return;}
  if(now-started>25000&&(!ready||!LiveRules.fresh(tickTime,now,10000)||!LiveRules.fresh(stateTime,now,25000))){halt("STALE / NO BROKER STATE • posisi asli tetap terbuka");return;}
  ui.postDelayed(this,1000);
 }};
 LiveBroker(ExnessClient api,SharedPreferences prefs,Handler ui,String preferred,Observer observer){
  this.api=api;this.prefs=prefs;this.ui=ui;this.observer=observer;this.preferred=preferred;
  ledger="live_"+api.account+"_"+Integer.toHexString(api.gateway.hashCode());
 }
 static String safe(Throwable e){
  if(e instanceof ExnessClient.ApiError){ExnessClient.ApiError a=(ExnessClient.ApiError)e;return "HTTP "+a.http+" / CODE "+a.code;}
  if(e instanceof IllegalArgumentException){String m=e.getMessage();if(m!=null&&m.matches("[A-Z0-9_]{3,80}"))return m;}
  return PreflightPolicy.safeReason(e);
 }
 void emit(String message,JSONObject deal){if(message!=null)lastReason=message;observer.update(status,symbol,lastReason,account,new JSONArray(positions.values()),deal);}
 static BigDecimal dec(JSONObject j,String name)throws Exception{return LiveRules.number(j.getString(name));}
 static String id(JSONObject j,String name)throws Exception{String s=j.getString(name);if(!s.matches("[0-9]{1,20}"))throw new IllegalArgumentException("INVALID_BROKER_ID");return s;}
 static long timestamp(JSONObject j,String name)throws Exception{return OffsetDateTime.parse(j.getString(name)).toInstant().toEpochMilli();}
 boolean save(){
  try{
   JSONObject j=new JSONObject().put("owned",new JSONArray(owned)).put("symbol",symbol).put("peak",peak.toPlainString()).put("pending_key",pendingKey==null?"":pendingKey).put("operation_id",pendingOperation==null?"":pendingOperation);
   return prefs.edit().putString(ledger,j.toString()).commit();
  }catch(Exception e){return false;}
 }
 void start(){
  if(active||finished)return;active=true;status="PREFLIGHT LIVE";started=System.currentTimeMillis();emit("Memeriksa akun, simbol, dan journal",null);
  try{
   String raw=prefs.getString(ledger,null);if(raw!=null){
    JSONObject j=new JSONObject(raw);if(!j.optString("pending_key").isEmpty())throw new IllegalArgumentException("UNRESOLVED_ORDER_REVIEW_BROKER");
    JSONArray a=j.getJSONArray("owned");for(int i=0;i<a.length();i++){String x=a.getString(i);if(!x.matches("[0-9]{1,20}"))throw new IllegalArgumentException("JOURNAL_INVALID");owned.add(x);}
    peak=LiveRules.number(j.getString("peak"));symbol=j.optString("symbol");
   }
  }catch(Exception e){halt(safe(e));return;}
  final String priorSymbol=symbol;
  worker.execute(()->{
   try{
    JSONObject details=api.details();String cur=details.getString("currency");BigDecimal scale=LiveRules.factor(cur);
    PreflightPolicy.account(cur,details.getString("trade_mode"));if(!"active".equals(details.getString("account_status")))throw new IllegalArgumentException("ACCOUNT_NOT_ACTIVE");
    BigDecimal lev=LiveRules.number(details.getString("leverage"));if(lev.signum()<=0)throw new IllegalArgumentException("LEVERAGE_UNSUPPORTED");
    JSONArray names=api.instruments().getJSONArray("instruments");List<String> list=new ArrayList<>();for(int i=0;i<names.length();i++)list.add(names.getString(i));
    String sym=PreflightPolicy.symbol(list,preferred);if(!owned.isEmpty()&&!priorSymbol.equals(sym))throw new IllegalArgumentException("BOT_POSITIONS_OTHER_SYMBOL");
    JSONObject cond=api.conditions(sym);if(!sym.equals(cond.getString("instrument")))throw new IllegalArgumentException("INSTRUMENT_MISMATCH");
    PreflightPolicy.units(cond.optString("contract_size",null),cond.optString("volume_min",null),cond.optString("volume_max",null),cond.optString("volume_step",null),cond.optString("quote_currency",null),cond.optString("trade_mode",null));
    String mode=cond.optString("calc_mode"),mc=cond.optString("margin_currency");
    if(!Arrays.asList("forex","cfd_leverage").contains(mode)||!("USD".equals(mc)||"XAU".equals(mc)||"USC".equals(mc)))throw new IllegalArgumentException("MARGIN_MODEL_UNSUPPORTED");
    if(!"market".equals(cond.optString("exec_mode"))||!"market".equals(details.getString("execution_mode")))throw new IllegalArgumentException("MARKET_EXECUTION_REQUIRED");
    BigDecimal cs=dec(cond,"contract_size");
    JSONObject lim=api.limits().getJSONObject("limits");JSONObject ws=lim.getJSONObject("websocket").getJSONObject("global_account_limits");
    if(ws.getInt("max_active_connections")<2||ws.getInt("max_inbound_message_bytes")<256)throw new IllegalArgumentException("WS_LIMITS_UNAVAILABLE");
    JSONObject rate=lim.getJSONObject("rest").getJSONObject("global_account_rate");
    if(rate.getInt("limit")<1||rate.getDouble("window_seconds")<=0)throw new IllegalArgumentException("REST_LIMITS_UNAVAILABLE");
    long interval=Math.max(30000L,(long)Math.ceil(rate.getDouble("window_seconds")*1000));
    Request tickReq=api.streamRequest("ticks"),eventReq=api.streamRequest("events");
    ui.post(()->{if(!active)return;symbol=sym;currency=cur;multiplier=scale;leverage=lev;contract=cs;mutationInterval=interval;lastAction=System.currentTimeMillis();status="WAITING BROKER SNAPSHOT";emit("LIVE • "+sym+" • "+cur,null);
     ticks=socketClient.newWebSocket(tickReq,new Stream(true));events=socketClient.newWebSocket(eventReq,new Stream(false));ui.removeCallbacks(watchdog);ui.postDelayed(watchdog,1000);
    });
   }catch(Exception e){ui.post(()->{if(active)halt("PREFLIGHT / "+safe(e));});}
  });
 }
 long mutationInterval=30000;
 final class Stream extends WebSocketListener {
  final boolean isTick;Stream(boolean t){isTick=t;}
  @Override public void onOpen(WebSocket w,Response r){
   if(!"exness-ws-protocol".equals(r.header("Sec-WebSocket-Protocol"))){ui.post(()->{if(active)halt("WS_PROTOCOL_INVALID");});w.cancel();return;}
   try{JSONObject sub=new JSONObject().put("event",isTick?"ticks":"transactions");if(isTick)sub.put("instruments",new JSONArray().put(symbol));
    boolean ok=w.send(new JSONObject().put("id",UUID.randomUUID().toString()).put("subscribe",sub).toString());
    if(!isTick)ok=ok&&w.send(new JSONObject().put("id",UUID.randomUUID().toString()).put("subscribe",new JSONObject().put("event","account_state")).toString());
    if(!ok)throw new IllegalArgumentException("WS_SUBSCRIBE_FAILED");
   }catch(Exception e){ui.post(()->{if(active)halt("WS_SUBSCRIBE_FAILED");});}
  }
  @Override public void onMessage(WebSocket w,String text){if(text.length()>1048576){ui.post(()->{if(active)halt("WS_FRAME_LIMIT");});return;}ui.post(()->{
   if(!active||w!=(isTick?ticks:events))return;
   try{
    JSONObject j=new JSONObject(text);if(j.has("code")){if(j.optInt("code")==200)return;halt("WS CODE "+j.optInt("code",-1));return;}
    if(isTick){if(!symbol.equals(j.getString("instrument")))return;onTick(j);}else onEvent(j);
   }catch(Exception e){halt("BROKER_FRAME / "+safe(e));}
  });}
  @Override public void onFailure(WebSocket w,Throwable e,Response r){ui.post(()->{if(active)halt(r==null?"WS_DISCONNECTED":"WS HTTP "+r.code());});}
  @Override public void onClosed(WebSocket w,int code,String reason){ui.post(()->{if(active)halt("WS_CLOSED");});}
 }
 void state(JSONObject a,long time)throws Exception{
  if(!LiveRules.fresh(time,System.currentTimeMillis(),25000))throw new IllegalArgumentException("STALE_BROKER_STATE");
  if(time<stateTime)return;BigDecimal eq=dec(a,"equity"),bal=dec(a,"balance"),used=dec(a,"used_margin");if(used.signum()<0)throw new IllegalArgumentException("INVALID_MARGIN");
  if(a.has("leverage")){BigDecimal l=dec(a,"leverage");if(l.signum()<=0)throw new IllegalArgumentException("LEVERAGE_UNSUPPORTED");leverage=l;}
  account=a;stateTime=time;if(peak.signum()==0)peak=eq.max(BigDecimal.ZERO);
  if(eq.compareTo(peak)>0){peak=eq;if(!save())throw new IllegalArgumentException("JOURNAL_WRITE_FAILED");}
  if(ready&&LiveRules.drawdown(eq,peak)){closing=true;status="DRAWDOWN / CLOSE OWNED";}
 }
 void onEvent(JSONObject j)throws Exception{
  String type=j.getString("event_type");JSONObject p=j.getJSONObject("payload");long ts=timestamp(j,"event_time");
  if("trading_state_snapshot".equals(type)){
   if(ready||pendingKey!=null)throw new IllegalArgumentException("UNEXPECTED_SNAPSHOT");
   if(p.getJSONArray("orders").length()!=0)throw new IllegalArgumentException("FOREIGN_OR_PENDING_ORDERS");
   JSONArray a=p.getJSONArray("positions");Map<String,JSONObject> next=new LinkedHashMap<>();
   for(int i=0;i<a.length();i++){JSONObject x=a.getJSONObject(i);String pid=id(x,"position_id");if(!owned.contains(pid)||!symbol.equals(x.getString("instrument"))||!"open".equals(x.getString("state")))throw new IllegalArgumentException("FOREIGN_POSITION_USE_DEDICATED_ACCOUNT");next.put(pid,x);}
   owned.retainAll(next.keySet());positions.clear();positions.putAll(next);if(positions.isEmpty())peak=BigDecimal.ZERO;
   state(p.getJSONObject("account_state"),ts);if(!save())throw new IllegalArgumentException("JOURNAL_WRITE_FAILED");ready=true;status="LIVE / WARMUP";emit("Broker snapshot diterima • "+positions.size()+" posisi milik bot",null);return;
  }
  if("account_state_event".equals(type)){state(p.getJSONObject("account_state"),ts);emit(null,null);return;}
  if(!"transaction_event".equals(type))return;
  if(pendingKey==null||!LiveRules.correlation(pendingKey,pendingOperation,j.optString("client_request_id"),j.optString("operation_id"))){halt("EXTERNAL / UNMATCHED TRANSACTION • cek broker");return;}
  if(pendingOperation==null){bufferedEvent=j;return;}finish(j);
 }
 void finish(JSONObject j)throws Exception{
  if(!LiveRules.correlation(pendingKey,pendingOperation,j.optString("client_request_id"),j.optString("operation_id")))throw new IllegalArgumentException("OPERATION_MISMATCH");
  String result=j.getString("status");
  if("rejected".equals(result)||"failed".equals(result)){pendingKey=null;pendingOperation=null;bufferedEvent=null;if(!save())throw new IllegalArgumentException("JOURNAL_WRITE_FAILED");halt("BROKER "+result.toUpperCase(Locale.ROOT)+" / "+j.optInt("error_code",-1));return;}
  if(!"success".equals(result))throw new IllegalArgumentException("UNKNOWN_OPERATION_STATUS");
  JSONObject payload=j.getJSONObject("payload");JSONArray changes=payload.getJSONArray("positions");if(changes.length()!=1)throw new IllegalArgumentException("POSITION_RESULT_AMBIGUOUS");
  JSONObject pos=changes.getJSONObject(0);String pid=id(pos,"position_id");if(!symbol.equals(pos.getString("instrument")))throw new IllegalArgumentException("POSITION_SYMBOL_MISMATCH");
  final boolean opening=pendingPosition==null;
  if(opening){if(!"open".equals(pos.getString("state"))||!pendingSide.equals(pos.getString("direction"))||owned.contains(pid)||dec(pos,"volume").compareTo(LiveRules.LOT)!=0)throw new IllegalArgumentException("OPEN_NOT_CONFIRMED");owned.add(pid);positions.put(pid,pos);}
  else{if(!pid.equals(pendingPosition)||!owned.contains(pid)||!"closed".equals(pos.getString("state")))throw new IllegalArgumentException("CLOSE_NOT_CONFIRMED");owned.remove(pid);positions.remove(pid);}
  JSONArray dealRows=payload.getJSONArray("deals");JSONObject deal=null;
  for(int i=0;i<dealRows.length();i++){JSONObject d=dealRows.getJSONObject(i);if(pid.equals(d.optString("position_id"))&&(opening?"open":"close").equals(d.optString("type"))){if(deal!=null)throw new IllegalArgumentException("DEAL_AMBIGUOUS");deal=d;}}
  if(deal==null)throw new IllegalArgumentException("DEAL_CONFIRMATION_MISSING");
  JSONObject newState=payload.getJSONObject("account_state");
  // Verify all required fields before committing ledger.
  dec(newState,"equity");dec(newState,"balance");dec(newState,"used_margin");
  state(newState,timestamp(j,"event_time"));pendingKey=null;pendingOperation=null;pendingSide=null;pendingPosition=null;bufferedEvent=null;
  if(!save())throw new IllegalArgumentException("JOURNAL_WRITE_FAILED");
  status=closing?"CLOSING OWNED":"LIVE / RUNNING";emit((opening?"OPEN":"CLOSE")+" CONFIRMED #"+pid,deal);
  if(closing&&owned.isEmpty())halt("ALL BOT POSITIONS CLOSED");
 }
 void onTick(JSONObject j)throws Exception{
  long now=System.currentTimeMillis(),t=timestamp(j,"timestamp");if(t<=tickTime||!LiveRules.fresh(t,now,5000))return;
  double b=j.getDouble("bid"),a=j.getDouble("ask");String trend=signal.next(b,a);bid=BigDecimal.valueOf(b);ask=BigDecimal.valueOf(a);tickTime=t;
  if(!ready||account==null||pendingKey!=null||!LiveRules.fresh(stateTime,now,15000)||now-lastAction<mutationInterval)return;
  BigDecimal eq=dec(account,"equity"),used=dec(account,"used_margin");
  if(LiveRules.drawdown(eq,peak)){closing=true;status="DRAWDOWN / CLOSE OWNED";}
  if(closing){if(positions.isEmpty()){halt("ALL BOT POSITIONS CLOSED");return;}send(null,positions.keySet().iterator().next());return;}
  for(JSONObject pos:positions.values()){
   BigDecimal gross=LiveRules.gross(pos.getString("direction"),dec(pos,"open_price"),dec(pos,"volume"),contract,bid,ask,multiplier);
   // Profit threshold is gross, not a promised realized amount. Broker history is authoritative.
   if(gross.compareTo(multiplier)>=0){send(null,id(pos,"position_id"));return;}
  }
  if(trend.isEmpty()||!LiveRules.allowsOpen(active,ready,false,false,true,positions.size(),now,t,stateTime,lastAction)||ask.subtract(bid).compareTo(LiveRules.SPREAD)>0)return;
  BigDecimal price="buy".equals(trend)?ask:bid;
  for(JSONObject pos:positions.values())if(trend.equals(pos.getString("direction"))&&price.subtract(dec(pos,"open_price")).abs().compareTo(new BigDecimal("2"))<0)return;
  BigDecimal margin=LiveRules.estimatedMargin(LiveRules.LOT,contract,ask,leverage,multiplier);
  if(!LiveRules.entryMargin(eq,used,margin)){status="LIVE / MARGIN WAIT";emit("Cadangan free margin tidak cukup (estimasi konservatif)",null);return;}
  send(trend,null);
 }
 void send(String side,String pid){
  if(!active||pendingKey!=null||(!ready)||pid!=null&&!owned.contains(pid))return;
  pendingKey="lumavun-"+UUID.randomUUID();pendingOperation=null;pendingPosition=pid;pendingSide=side;pendingAt=lastAction=System.currentTimeMillis();bufferedEvent=null;
  if(!save()){halt("JOURNAL_WRITE_FAILED");return;}
  final String key=pendingKey;status="ORDER SENT / WAITING";emit(pid==null?"Request "+side.toUpperCase(Locale.ROOT)+" "+symbol:"Request CLOSE #"+pid,null);
  worker.execute(()->{
   if(!active)return;
   try{
    JSONObject ack=pid==null?api.openPosition(symbol,side,LiveRules.LOT.toPlainString(),key):api.closePosition(pid,key);
    ui.post(()->{if(!active||!key.equals(pendingKey))return;
     try{if(!"accepted".equals(ack.getString("status"))||!key.equals(ack.getString("client_request_id")))throw new IllegalArgumentException("ACK_MISMATCH");pendingOperation=id(ack,"operation_id");if(!save())throw new IllegalArgumentException("JOURNAL_WRITE_FAILED");emit("ACK #"+pendingOperation+" • belum final",null);if(bufferedEvent!=null)finish(bufferedEvent);}catch(Exception e){halt("ACK / "+safe(e));}
    });
   }catch(Exception e){ui.post(()->{if(active&&key.equals(pendingKey))halt("ORDER UNKNOWN / "+safe(e));});}
  });
 }
 void emergency(){if(!active||!ready){emit("Tidak terhubung. Tutup posisi di Exness secara manual.",null);return;}closing=true;status="CLOSING OWNED";emit("Emergency: antre close posisi milik bot",null);}
 void halt(String why){if(finished)return;active=false;finished=true;ready=false;status=pendingKey==null?"STOPPED":"LOCKED / ORDER UNKNOWN";ui.removeCallbacks(watchdog);
  if(ticks!=null)ticks.cancel();if(events!=null)events.cancel();worker.shutdown();socketClient.dispatcher().executorService().shutdown();socketClient.connectionPool().evictAll();emit(why,null);}
}
