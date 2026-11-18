package com.lumavun.hedge;

import android.app.Activity;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.graphics.*;
import android.graphics.drawable.GradientDrawable;
import android.content.SharedPreferences;
import android.net.Uri;
import android.view.*;
import android.app.AlertDialog;
import android.text.InputType;
import org.json.JSONArray;
import java.time.Instant;
import android.widget.*;
import java.io.*;
import java.net.URL;
import javax.net.ssl.HttpsURLConnection;
import java.math.BigDecimal;
import java.text.DecimalFormat;
import java.time.OffsetDateTime;
import java.util.Locale;
import org.json.JSONObject;

public class MainActivity extends Activity {

 private static final int BG=0xff090e19, PANEL=0xff13222f, BORDER=0xff344f60, WHITE=0xffeff7fa, MUTED=0xffa9bbc9, TEAL=0xff55f3c1, PURPLE=0xffa58bff, RED=0xffff8497;
 private static final String[] TABS={"Home","Dashboard","Bot","History","Settings"};
 private LinearLayout root, shell, body, nav;
 private ExnessClient client;
 private PaperHedge paper;
 private boolean botStarting=false;
 private int botGeneration=0;
 private okhttp3.WebSocket ticks;
 private final okhttp3.OkHttpClient socketClient=new okhttp3.OkHttpClient.Builder().followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false).pingInterval(15,java.util.concurrent.TimeUnit.SECONDS).build();
 private String botStatus="STOPPED",paperSymbol="",paperFeeDescription="Belum diperiksa";
 private boolean paperFeeKnown=false;
 private String preferredSymbol="";
 private long lastBotPaint=0, botStartTime=0;
 private final java.util.ArrayDeque<String> botLogs=new java.util.ArrayDeque<>();
 private final Runnable watchdog=new Runnable(){public void run(){
  if(ticks!=null||botStarting){long now=System.currentTimeMillis();if(now-botStartTime>15000&&(paper==null||!paper.fresh(now))){stopBot("STALE / NO FRESH TICK",true);return;}handler.postDelayed(this,1000);}
 }};
 private ExnessClient.Vault vault;
 private JSONArray positions=new JSONArray(), deals=new JSONArray();
 private String historyStatus="Belum dimuat";
 private SharedPreferences prefs;
 private final Handler handler=new Handler(Looper.getMainLooper());
 private int tab=0, filter=0, generation=0;
 private boolean preview=false, busy=false;
 private long cooldown=0;
 private Snapshot snapshot;
 private String status="Hubungkan akun Exness untuk melihat saldo.";
 private final float[] demoEquity={41,53,49,72,62,87,66,105,91,123,112,151,139,174};
 private final float[] demoBalance={37,46,42,51,55,64,58,76,82,94,98,112,123,138};
 private final double[] demoPnl={1.00,1.35,-2.40,1.15,1.00,-0.65};
 private final String[] demoSides={"BUY","SELL","BUY","SELL","BUY","SELL"};
 private static final class Snapshot {
  final BigDecimal balance,equity,margin; final String currency; final long time;
  Snapshot(JSONObject j) throws Exception {
   if(!"SNAPSHOT".equals(j.getString("status")))throw new Exception();
   balance=decimal(j,"balance");equity=decimal(j,"equity");margin=decimal(j,"used_margin");
   currency=j.getString("currency");time=OffsetDateTime.parse(j.getString("asOf")).toInstant().toEpochMilli();
   if(!currency.matches("[A-Za-z][A-Za-z0-9]{1,11}")||margin.signum()<0||time>System.currentTimeMillis()+2000||System.currentTimeMillis()-time>30000)throw new Exception();
  }
  static BigDecimal decimal(JSONObject j,String key)throws Exception{
   Object raw=j.get(key);if(!(raw instanceof String)||!((String)raw).matches("-?(0|[1-9][0-9]{0,29})(\\.[0-9]{1,18})?"))throw new Exception();return new BigDecimal((String)raw);
  }
 }
 @Override public void onCreate(Bundle state){
  super.onCreate(state);getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);getWindow().setStatusBarColor(BG);getWindow().setNavigationBarColor(BG);
  prefs=getSharedPreferences("lumavun_ui",MODE_PRIVATE);preview=prefs.getBoolean("preview",false);preferredSymbol=prefs.getString("paper_symbol","");
  vault=new ExnessClient.Vault(this);try{JSONObject saved=vault.load();if(saved!=null){client=new ExnessClient(saved);status="API tersimpan. Refresh untuk membaca akun.";}}catch(Exception e){status="Kunci lokal tidak dapat dibuka. Sambungkan ulang.";}
  root=column();root.setBackgroundColor(BG);
  root.setOnApplyWindowInsetsListener((v,i)->{v.setPadding(i.getSystemWindowInsetLeft(),i.getSystemWindowInsetTop(),i.getSystemWindowInsetRight(),i.getSystemWindowInsetBottom());return i;});
  setContentView(root);showShell();
 }
 private int dp(float n){return Math.round(n*getResources().getDisplayMetrics().density);}
 private LinearLayout column(){LinearLayout l=new LinearLayout(this);l.setOrientation(LinearLayout.VERTICAL);return l;}
 private LinearLayout row(){LinearLayout l=new LinearLayout(this);l.setOrientation(LinearLayout.HORIZONTAL);l.setGravity(Gravity.CENTER_VERTICAL);return l;}
 private GradientDrawable bg(int color,int edge,int radius){GradientDrawable d=new GradientDrawable();d.setColor(color);d.setCornerRadius(dp(radius));if(edge!=0)d.setStroke(dp(1),edge);return d;}
 private TextView txt(String s,float size,int color,boolean bold){TextView t=new TextView(this);t.setText(s);t.setTextSize(size);t.setTextColor(color);t.setIncludeFontPadding(true);t.setBreakStrategy(android.text.Layout.BREAK_STRATEGY_HIGH_QUALITY);if(bold)t.setTypeface(Typeface.create("sans-serif-medium",Typeface.NORMAL));return t;}
 private void gap(LinearLayout parent,int n){View v=new View(this);parent.addView(v,new LinearLayout.LayoutParams(1,dp(n)));}
 private void add(LinearLayout parent,View v){parent.addView(v,new LinearLayout.LayoutParams(-1,-2));}
 private void line(LinearLayout parent,String value){add(parent,txt(value,13,MUTED,false));}
 private void heading(String s){gap(body,16);add(body,txt(s,18,WHITE,true));gap(body,10);}
 private LinearLayout card(LinearLayout parent){LinearLayout c=column();c.setPadding(dp(14),dp(12),dp(14),dp(12));c.setBackground(bg(PANEL,BORDER,14));add(parent,c);gap(parent,10);return c;}
 private void weighted(LinearLayout parent,View v,boolean right){LinearLayout.LayoutParams p=new LinearLayout.LayoutParams(0,-2,1);if(right)p.leftMargin=dp(9);parent.addView(v,p);}
 private TextView action(String label,boolean primary,Runnable run){TextView t=txt(label,14,primary?BG:TEAL,true);t.setGravity(Gravity.CENTER);t.setPadding(dp(10),dp(10),dp(10),dp(10));t.setMinHeight(dp(48));t.setBackground(bg(primary?TEAL:0xff102b33,primary?0:0xff3b8b88,12));t.setClickable(true);t.setFocusable(true);t.setOnClickListener(v->run.run());return t;}
 private void labelValue(LinearLayout parent,String label,String value,int color){LinearLayout r=row();TextView a=txt(label,13,MUTED,false);r.addView(a,new LinearLayout.LayoutParams(0,-2,1));TextView b=txt(value,14,color,true);b.setGravity(Gravity.END);r.addView(b,new LinearLayout.LayoutParams(0,-2,1));add(parent,r);gap(parent,8);}
 private void showShell(){
  root.removeAllViews();shell=column();shell.setBackgroundColor(BG);root.addView(shell,new LinearLayout.LayoutParams(-1,-1));
  LinearLayout header=row();header.setPadding(dp(17),dp(12),dp(17),dp(10));
  LinearLayout mark=column();TextView name=txt("◈  LUMAVUN  HEDGE",20,WHITE,true);add(mark,name);add(mark,txt("DIRECT API  /  v0.4.2",11,TEAL,true));header.addView(mark,new LinearLayout.LayoutParams(0,-2,1));
  TextView mode=txt(preview?"PREVIEW":snapshot!=null?"SNAPSHOT":client==null?"OFFLINE":"API SAVED",11,preview?PURPLE:TEAL,true);mode.setPadding(dp(10),dp(7),dp(10),dp(7));mode.setBackground(bg(PANEL,BORDER,10));header.addView(mode);add(shell,header);
  ScrollView scroll=new ScrollView(this);scroll.setFillViewport(true);body=column();body.setPadding(dp(16),dp(6),dp(16),dp(18));scroll.addView(body,new ScrollView.LayoutParams(-1,-2));shell.addView(scroll,new LinearLayout.LayoutParams(-1,0,1));
  nav=row();nav.setPadding(dp(3),dp(4),dp(3),dp(5));nav.setBackground(bg(0xff101c29,BORDER,0));
  for(int i=0;i<TABS.length;i++){final int ix=i;LinearLayout cell=column();cell.setGravity(Gravity.CENTER);cell.setPadding(0,dp(5),0,dp(5));cell.setMinimumHeight(dp(58));int color=i==tab?TEAL:MUTED;View icon=new NavIcon(i,color);cell.addView(icon,new LinearLayout.LayoutParams(dp(26),dp(26)));TextView cap=txt(TABS[i],11,color,i==tab);cap.setGravity(Gravity.CENTER);add(cell,cap);cell.setContentDescription(TABS[i]);cell.setSelected(i==tab);cell.setClickable(true);cell.setFocusable(true);cell.setOnClickListener(v->{tab=ix;showShell();});nav.addView(cell,new LinearLayout.LayoutParams(0,-2,1));}
  add(shell,nav);
  if(preview){TextView warning=txt("PREVIEW DESAIN • semua angka contoh, bukan data broker",12,PURPLE,true);warning.setPadding(dp(10),dp(8),dp(10),dp(8));warning.setBackground(bg(0xff211d38,0xff65548e,10));add(body,warning);gap(body,12);}
  switch(tab){case 0: home();break;case 1: dashboard();break;case 2: bot();break;case 3: history();break;default:settings();}
 }
 private String amount(BigDecimal x){return new DecimalFormat("#,##0.00").format(x);}
 private String val(String example,BigDecimal value){return preview?example:value==null?"—":amount(value);}
 private int pnlColor(BigDecimal p){return p==null?MUTED:p.signum()<0?RED:TEAL;}
 private BigDecimal floating(){return snapshot==null?null:snapshot.equity.subtract(snapshot.balance);}
 private void home(){
  TextView page=txt("Account overview",24,WHITE,true);add(body,page);gap(body,13);
  LinearLayout hero=column();GradientDrawable gradient=new GradientDrawable(GradientDrawable.Orientation.TL_BR,new int[]{0xff123e45,0xff182637,0xff302347});gradient.setCornerRadius(dp(18));gradient.setStroke(dp(1),0xff518b9c);hero.setBackground(gradient);hero.setPadding(dp(17),dp(16),dp(17),dp(14));add(body,hero);
  line(hero,preview?"Contoh total balance":"Saldo broker • read-only");
  add(hero,txt(val("128.50",snapshot==null?null:snapshot.balance),34,WHITE,true));
  add(hero,txt(preview?"USD • contoh data":snapshot==null?"Currency belum tersedia":snapshot.currency+" • snapshot",13,TEAL,true));gap(hero,12);
  LinearLayout buttons=row();weighted(buttons,action(busy?"Memuat…":"Refresh saldo",true,()->refresh()),false);weighted(buttons,action("Akun Exness",false,()->connectDialog()),true);add(hero,buttons);gap(hero,9);line(hero,preview?"Mode contoh aktif.":statusText());
  heading("Account metrics");
  LinearLayout r=row();metric(r,"Equity",val("116.20",snapshot==null?null:snapshot.equity),WHITE,false);metric(r,"Floating PnL*",val("−12.30",floating()),preview?RED:pnlColor(floating()),true);add(body,r);gap(body,10);
  LinearLayout r2=row();metric(r2,"Used margin",val("8.00",snapshot==null?null:snapshot.margin),WHITE,false);metric(r2,"Account type",preview?"Contoh":"Belum diverifikasi",MUTED,true);add(body,r2);gap(body,8);line(body,"*Equity − balance adalah selisih snapshot, bukan rincian PnL trade.");
  heading("Market pulse");
  LinearLayout market=card(body);labelValue(market,"XAUUSD / Gold","Exness feed",TEAL);line(market,"Market stream belum aktif. Snapshot posisi berasal dari Exness langsung.");gap(market,9);for(int i=0;i<positions.length();i++){JSONObject p=positions.optJSONObject(i);if(p!=null)labelValue(market,p.optString("instrument")+" "+p.optString("direction"),p.optString("volume")+" lot",WHITE);}
  heading("Hedge engine");
  LinearLayout engine=card(body);labelValue(engine,"Execution","PAPER / "+botStatus,TEAL);line(engine,"Bot berjalan dengan tick Exness; order virtual terpisah dari transaksi akun.");gap(engine,8);add(engine,action("Buka kontrol bot",false,()->{tab=2;showShell();}));
 }
 private String statusText(){if(snapshot!=null&&System.currentTimeMillis()-snapshot.time>30000)return "Snapshot kedaluwarsa • refresh kembali.";return status;}
 private void metric(LinearLayout r,String label,String value,int color,boolean right){LinearLayout c=column();c.setBackground(bg(PANEL,BORDER,13));c.setPadding(dp(12),dp(12),dp(12),dp(12));add(c,txt(label,12,MUTED,false));gap(c,7);add(c,txt(value,value.length()>15?14:21,color,true));weighted(r,c,right);}
 private void dashboard(){
  add(body,txt("Analytics & Dashboard",25,WHITE,true));gap(body,13);
  LinearLayout chart=card(body);add(chart,txt(preview?"Contoh grafik equity & balance (ilustrasi terpisah)":"Equity & balance history",16,WHITE,true));gap(chart,8);
  ChartView graph=new ChartView(preview,false);graph.setContentDescription(preview?"Contoh grafik equity dan balance, bukan data broker":"Riwayat equity belum tersedia");chart.addView(graph,new LinearLayout.LayoutParams(-1,dp(180)));
  line(chart,preview?"Teal: equity  •  Ungu: balance (contoh)":"Grafik historis equity belum tersedia. Close deal dapat dibaca di History.");
  LinearLayout r=row();metric(r,"Win rate",preview?"66.7%":"—",TEAL,false);metric(r,"Realized PnL",preview?"+1.45":"—",TEAL,true);add(body,r);gap(body,10);
  LinearLayout dist=card(body);add(dist,txt("Trade distribution",16,WHITE,true));ChartView donut=new ChartView(preview,true);donut.setContentDescription(preview?"Contoh distribusi, empat profit dan dua loss":"Distribusi belum tersedia");dist.addView(donut,new LinearLayout.LayoutParams(-1,dp(150)));line(dist,preview?"Contoh: 4 profit • 2 loss":"Distribusi lengkap belum dihitung. Close deal tersedia di History.");
  LinearLayout current=card(body);add(current,txt("Broker snapshot",16,WHITE,true));gap(current,8);labelValue(current,"Balance",val("128.50",snapshot==null?null:snapshot.balance),WHITE);labelValue(current,"Equity",val("116.20",snapshot==null?null:snapshot.equity),TEAL);add(current,action("Refresh saldo",false,()->refresh()));
 }
 private void bot(){
  add(body,txt("Hedge Engine Control",25,WHITE,true));gap(body,13);
  LinearLayout c=card(body);labelValue(c,"Engine status",botStatus,paper!=null&&paper.running?TEAL:MUTED);
  line(c,"PAPER EXECUTION • tick Exness. Order riil belum diaktifkan.");
  gap(c,10);LinearLayout controls=row();weighted(controls,action("START BOT",true,()->startBot()),false);weighted(controls,action("STOP BOT",false,()->stopBot("STOPPED",false)),true);add(c,controls);
  gap(c,8);add(c,action("EMERGENCY CLOSE ALL (PAPER)",false,()->emergencyPaper()));
  LinearLayout p=card(body);add(p,txt("Active strategy",17,WHITE,true));gap(p,12);labelValue(p,"Strategy","Adaptive hedge • EMA tick 9/21",TEAL);labelValue(p,"Instrument",paperSymbol.isEmpty()?(preferredSymbol.isEmpty()?"XAUUSD / auto suffix":preferredSymbol):paperSymbol,WHITE);gap(p,6);add(p,action("Pilih simbol XAUUSD",false,()->selectSymbol()));labelValue(p,"Volume","0.01 lot",WHITE);labelValue(p,"Profit target",paper!=null&&!paperFeeKnown?"$1 gross / posisi":"$1 / posisi (estimasi)",TEAL);line(p,"Komisi: "+paperFeeDescription);labelValue(p,"Entry cooldown","30 detik",WHITE);labelValue(p,"Position cap","5",WHITE);labelValue(p,"Drawdown guard","15%",RED);line(p,"Modal virtual $100; margin asumsi $5/posisi; biaya hanya jika model tersedia. Tidak termasuk swap, slippage atau stop-out broker.");line(p,"Engine hanya saat APK aktif; Stop membekukan entry dan close otomatis. Sesi virtual tersimpan di RAM, hilang jika proses APK mati.");
  if(paper!=null){
   LinearLayout v=card(body);add(v,txt("Virtual trading account",17,WHITE,true));gap(v,8);labelValue(v,paperFeeKnown?"Balance (estimasi)":"Balance gross paper",String.format(java.util.Locale.US,"$%.2f",paper.balance),WHITE);boolean fresh=paper.fresh(System.currentTimeMillis())&&ticks!=null;
   labelValue(v,paperFeeKnown?"Equity (estimasi)":"Equity gross paper",fresh?String.format(java.util.Locale.US,"$%.2f",paper.equity()):"—",WHITE);labelValue(v,paperFeeKnown?"Floating PnL (estimasi)":"Floating PnL gross",fresh?String.format(java.util.Locale.US,"%+.2f",paper.floating()):"—",TEAL);labelValue(v,"Open / Closed",paper.open.size()+" / "+paper.closed.size(),WHITE);
   if(fresh)labelValue(v,"Bid / Ask",String.format(java.util.Locale.US,"%.3f / %.3f",paper.bid,paper.ask),WHITE);
   for(PaperHedge.Position pos:paper.open)labelValue(v,(pos.buy?"BUY ":"SELL ")+String.format(java.util.Locale.US,"%.3f",pos.entry),fresh?String.format(java.util.Locale.US,"%+.2f",pos.pnl(paper.bid,paper.ask,paper.units,paper.fee)):"—",WHITE);
  }
  LinearLayout logs=card(body);add(logs,txt("Engine logs",16,WHITE,true));gap(logs,8);if(botLogs.isEmpty())line(logs,"Tekan START BOT untuk memulai koneksi tick.");else for(String log:botLogs)line(logs,log);
 }
 private void logBot(String message){if(botLogs.size()>=12)botLogs.removeFirst();botLogs.addLast(new java.text.SimpleDateFormat("HH:mm:ss",java.util.Locale.US).format(new java.util.Date())+"  "+message);}
 private void renderBot(){if(tab==2&&!isDestroyed()&&!isFinishing())showShell();}
 private void selectSymbol(){
  if(botStarting||(paper!=null&&(paper.running||!paper.open.isEmpty()))){Toast.makeText(this,"Stop dan tutup sesi paper sebelum mengubah simbol.",Toast.LENGTH_LONG).show();return;}
  EditText input=new EditText(this);input.setText(preferredSymbol);input.setHint("Kosong = auto; contoh XAUUSDm");
  new AlertDialog.Builder(this).setTitle("Simbol XAUUSD").setMessage("Gunakan nama yang tersedia di akun Exness. Mengganti simbol mereset sesi paper lokal yang sudah ditutup.").setView(input).setNegativeButton("Batal",null).setPositiveButton("Simpan",(d,w)->{String v=input.getText().toString().trim();if(!v.isEmpty()&&!v.matches("XAUUSD[a-z0-9._-]{0,5}")){Toast.makeText(this,"Format simbol tidak valid",Toast.LENGTH_SHORT).show();return;}stopBot("STOPPED",true);preferredSymbol=v;prefs.edit().putString("paper_symbol",v).apply();paper=null;paperSymbol="";paperFeeDescription="Belum diperiksa";renderBot();}).show();
 }
 private String optionalText(JSONObject j,String name){Object raw=j==null?null:j.opt(name);return raw instanceof String?(String)raw:null;}
 private void preflightLog(int run,String message){handler.post(()->{if(run==botGeneration&&botStarting&&!isDestroyed()){logBot(message);renderBot();}});}
 private void startBot(){
  if(preview){Toast.makeText(this,"Matikan preview untuk memakai tick Exness.",Toast.LENGTH_SHORT).show();return;}
  if(client==null){connectDialog();return;}if(busy||botStarting||(paper!=null&&paper.running))return;
  if(paper!=null&&paper.halted&&paper.open.isEmpty()){Toast.makeText(this,"Emergency latch aktif. Sesi paper telah dihentikan.",Toast.LENGTH_LONG).show();return;}
  if(paper!=null&&ticks!=null&&paper.fresh(System.currentTimeMillis())){if(paper.halted){paper.emergency(System.currentTimeMillis());botStatus="EMERGENCY CLOSED";renderBot();return;}paper.start();botStatus="WAITING FOR TICKS";logBot("PAPER START");renderBot();return;}
  if(System.currentTimeMillis()<cooldown){Toast.makeText(this,"Cooldown API aktif.",Toast.LENGTH_SHORT).show();return;}
  if(ticks!=null){ticks.cancel();ticks=null;if(paper!=null){paper.lastTick=0;paper.bid=Double.NaN;paper.ask=Double.NaN;}}handler.removeCallbacks(watchdog);
  final int run=++botGeneration;final ExnessClient current=client;botStarting=true;botStartTime=System.currentTimeMillis();botStatus="CONNECTING";logBot("Memeriksa akun dan simbol");renderBot();
  final String requestedSymbol=preferredSymbol;
  new Thread(()->{
   String stage="ACCOUNT";
   try{
    JSONObject details=current.details();PreflightPolicy.account(optionalText(details,"currency"),optionalText(details,"trade_mode"));preflightLog(run,"ACCOUNT OK • paper currency USD terpisah");
    stage="INSTRUMENTS";JSONArray symbols=current.instruments().getJSONArray("instruments");java.util.ArrayList<String> names=new java.util.ArrayList<>();
    for(int i=0;i<symbols.length();i++){Object value=symbols.get(i);if(!(value instanceof String))throw new org.json.JSONException("INVALID_SYMBOL_LIST");names.add((String)value);}
    java.util.ArrayList<String> gold=new java.util.ArrayList<>();for(String sym:names)if(sym.matches("XAUUSD[a-z0-9._-]{0,5}")&&!gold.contains(sym))gold.add(sym);
    if(gold.size()>1)preflightLog(run,"XAUUSD tersedia: "+String.join(", ",gold.subList(0,Math.min(6,gold.size()))));
    final String actual=PreflightPolicy.symbol(names,requestedSymbol);preflightLog(run,"INSTRUMENT OK • "+actual);
    stage="CONDITIONS";JSONObject cond=current.conditions(actual);if(!actual.equals(optionalText(cond,"instrument")))throw new IllegalArgumentException("INSTRUMENT_MISMATCH");
    final double units=PreflightPolicy.units(optionalText(cond,"contract_size"),optionalText(cond,"volume_min"),optionalText(cond,"volume_max"),optionalText(cond,"volume_step"),optionalText(cond,"quote_currency"),optionalText(cond,"trade_mode"));
    preflightLog(run,"CONDITIONS OK • lot 0.01");
    stage="COMMISSION";JSONObject commission=cond.optJSONObject("commission_settings"),cv=commission==null?null:commission.optJSONObject("commission_value");final PreflightPolicy.Fee estimate=PreflightPolicy.fee(optionalText(commission,"commission_type"),optionalText(cv,"amount"),optionalText(cv,"currency"));final double fee=estimate.amount;
    preflightLog(run,estimate.known?"COMMISSION • estimasi tersedia":"COMMISSION UNKNOWN • gross paper only; biaya tidak dihitung");
    stage="WS_SIGN";final okhttp3.Request req=current.tickRequest();preflightLog(run,"WS SIGN OK");
    handler.post(()->{if(run!=botGeneration||current!=client||isDestroyed()||!botStarting)return;
     if(paper!=null&&(!actual.equals(paperSymbol)||Math.abs(paper.units-units)>1e-9||Math.abs(paper.fee-fee)>1e-9||paperFeeKnown!=estimate.known)){stopBot("PARAMETER CHANGED",true);return;}
     if(paper==null){paper=new PaperHedge(100,units,fee,1,2,.5,5,30000,5);paperSymbol=actual;}
     paperFeeKnown=estimate.known;paperFeeDescription=estimate.known?String.format(java.util.Locale.US,"$%.4f estimasi round-trip",fee):"UNKNOWN • gross paper, bukan net profit";paper.start();botStatus="WAITING FOR TICKS";botStartTime=System.currentTimeMillis();botStarting=false;
     final String subId=java.util.UUID.randomUUID().toString();
     ticks=socketClient.newWebSocket(req,new okhttp3.WebSocketListener(){
      @Override public void onOpen(okhttp3.WebSocket w,okhttp3.Response response){
       if(!"exness-ws-protocol".equals(response.header("Sec-WebSocket-Protocol"))){w.cancel();handler.post(()->{if(run==botGeneration)stopBot("WS PROTOCOL FAILED",true);});return;}
       try{boolean sent=w.send(new JSONObject().put("id",subId).put("subscribe",new JSONObject().put("event","ticks").put("instruments",new JSONArray().put(actual))).toString());handler.post(()->{if(run==botGeneration){if(!sent){stopBot("WS SUBSCRIBE SEND FAILED",true);return;}logBot("WS OPEN • subscribe terkirim; menunggu data");renderBot();}});}catch(Exception ex){handler.post(()->{if(run==botGeneration)stopBot("WS SUBSCRIBE SEND FAILED",true);});w.cancel();}
      }
      @Override public void onMessage(okhttp3.WebSocket w,String msg){
       if(msg.length()>16384){w.cancel();handler.post(()->{if(run==botGeneration)stopBot("WS FRAME TOO LARGE",true);});return;}
       try{
        JSONObject j=new JSONObject(msg);
        if(j.has("code")){
         if(j.length()==2&&j.optInt("code")==200&&subId.equals(j.optString("id")))return;
         final int code=j.optInt("code",-1);final String reason=PreflightPolicy.publicCode(code)?"WS CODE "+code:"WS CONTROL INVALID";handler.post(()->{if(run==botGeneration){if(code==3015||code==1)cooldown=System.currentTimeMillis()+60000;stopBot(reason,true);}});return;
        }
        if(!actual.equals(j.getString("instrument"))||!(j.get("bid") instanceof Number)||!(j.get("ask") instanceof Number))return;
        final double bid=j.getDouble("bid"),ask=j.getDouble("ask");final long ts=java.time.OffsetDateTime.parse(j.getString("timestamp")).toInstant().toEpochMilli();
        handler.post(()->{if(run!=botGeneration||ticks!=w||current!=client||paper==null)return;
         boolean first=paper.lastTick==0;String prev=paper.note;String result=paper.tick(bid,ask,ts,System.currentTimeMillis());if(result.equals("INVALID_OR_STALE"))return;if(first)logBot("FIRST VALID TICK • "+actual);
         if(paper.halted&&!paper.open.isEmpty())paper.emergency(System.currentTimeMillis());if(paper.running)botStatus="RUNNING / PAPER";else if(paper.halted)botStatus="EMERGENCY";
         if(!prev.equals(result)&&(result.startsWith("PAPER ")||result.equals("HARVEST")||result.startsWith("EMERGENCY")))logBot(result);
         long now=System.currentTimeMillis();if(now-lastBotPaint>=1000){lastBotPaint=now;renderBot();}
        });
       }catch(Exception ignored){}
      }
      @Override public void onFailure(okhttp3.WebSocket w,Throwable e,okhttp3.Response response){handler.post(()->{if(run==botGeneration){if(response!=null&&response.code()==429)cooldown=System.currentTimeMillis()+60000;stopBot(response==null?"WS "+PreflightPolicy.safeReason(e):"WS HTTP "+response.code(),true);}});}
      @Override public void onClosed(okhttp3.WebSocket w,int code,String reason){handler.post(()->{if(run==botGeneration)stopBot("WS CLOSED",true);});}
     });
     logBot("Subscription "+actual+"; menunggu tick valid");handler.removeCallbacks(watchdog);handler.postDelayed(watchdog,1000);renderBot();
    });
   }catch(Exception e){final String failedStage=stage;handler.post(()->{if(run!=botGeneration)return;if(e instanceof ExnessClient.ApiError){ExnessClient.ApiError api=(ExnessClient.ApiError)e;if(api.http==429)cooldown=System.currentTimeMillis()+Math.max(60000,api.retryMs);stopBot(failedStage+" HTTP "+api.http+(PreflightPolicy.publicCode(api.code)?" / CODE "+api.code:""),true);}else stopBot(failedStage+" / "+PreflightPolicy.safeReason(e),true);});}
  },"hedge-tick-preflight").start();
 }
 private void stopBot(String reason,boolean disconnect){
  botStarting=false;if(paper!=null)paper.stop(reason);botStatus=reason;logBot(reason);
  if(disconnect||ticks==null){botGeneration++;handler.removeCallbacks(watchdog);if(ticks!=null){ticks.cancel();ticks=null;}if(paper!=null){paper.bid=Double.NaN;paper.ask=Double.NaN;paper.lastTick=0;}}
  renderBot();
 }
 private void emergencyPaper(){
  if(paper==null){Toast.makeText(this,"Belum ada sesi paper.",Toast.LENGTH_SHORT).show();return;}
  new AlertDialog.Builder(this).setTitle("Emergency close paper?").setMessage("Menutup posisi virtual saja. Tidak menyentuh posisi broker.").setNegativeButton("Batal",null).setPositiveButton("Close paper",(d,w)->{
   boolean ok=paper.emergency(System.currentTimeMillis());botStatus=ok?"EMERGENCY CLOSED":"EMERGENCY / STALE";logBot(paper.note);renderBot();
  }).show();
 }
 private void history(){
  add(body,txt("Trade History",25,WHITE,true));gap(body,13);
  LinearLayout filters=row();String[] names={"All","Profit","Loss"};for(int i=0;i<3;i++){final int n=i;TextView t=action(names[i],filter==i,()->{filter=n;showShell();});if(i==0)weighted(filters,t,false);else weighted(filters,t,true);}add(body,filters);gap(body,12);
  LinearLayout total=card(body);add(total,txt(preview?"Total realized PnL":"Net PnL lengkap",13,MUTED,false));add(total,txt(preview?"+1.45":"—",27,TEAL,true));line(total,preview?"Contoh riwayat • USD":"Profit close deal per transaksi; belum termasuk rekonsiliasi seluruh biaya dan halaman.");
  if(preview){for(int i=0;i<demoPnl.length;i++){double p=demoPnl[i];if((filter==1&&p<0)||(filter==2&&p>=0))continue;LinearLayout trade=card(body);labelValue(trade,"Contoh #"+(i+1)+" • "+demoSides[i],String.format(Locale.US,"%+.2f USD",p),p>=0?TEAL:RED);line(trade,"Simulasi ilustratif • bukan transaksi Exness");}}
  else{LinearLayout empty=card(body);line(empty,historyStatus);gap(empty,8);add(empty,action("Refresh history",false,()->refreshHistory()));for(int i=deals.length()-1;i>=0;i--){JSONObject item=deals.optJSONObject(i);if(item==null)continue;JSONObject p=item.optJSONObject("deal");if(p==null)continue;JSONObject profit=p.optJSONObject("profit");if(profit==null)continue;try{BigDecimal n=new BigDecimal(profit.getString("amount"));if((filter==1&&n.signum()<=0)||(filter==2&&n.signum()>=0))continue;LinearLayout trade=card(body);labelValue(trade,p.optString("instrument")+" • "+p.optString("direction"),amount(n)+" "+profit.optString("currency"),pnlColor(n));line(trade,item.optString("event_time"));line(trade,"Volume: "+p.optString("volume")+" • Harga: "+p.optString("price"));}catch(Exception ignored){}}}
 }
 private void settings(){
  add(body,txt("System Settings",25,WHITE,true));gap(body,13);
  LinearLayout c=card(body);add(c,txt("Exness account",17,WHITE,true));gap(c,8);line(c,client==null?"API belum tersambung. Tidak perlu login LUMAVUN.":"API lokal tersimpan • akun "+client.account);gap(c,10);add(c,action("Sambungkan API Exness",true,()->connectDialog()));gap(c,8);add(c,action("Hapus koneksi lokal",false,()->disconnect()));
  LinearLayout p=card(body);add(p,txt("Risk management",17,WHITE,true));gap(p,10);labelValue(p,"Individual take profit","$1 (rancangan)",TEAL);labelValue(p,"Emergency drawdown","15% (rancangan)",RED);labelValue(p,"Martingale","Nonaktif",MUTED);line(p,"Pengaturan engine native belum diterapkan pada transaksi.");
  LinearLayout d=card(body);add(d,txt("Appearance",17,WHITE,true));gap(d,8);labelValue(d,"Theme","Midnight / teal",TEAL);Switch sw=new Switch(this);sw.setText("Preview desain (data contoh)");sw.setTextColor(WHITE);sw.setTextSize(14);sw.setMinHeight(dp(48));sw.setChecked(preview);sw.setOnCheckedChangeListener((b,checked)->{stopBot("STOPPED",true);preview=checked;snapshot=null;generation++;busy=false;prefs.edit().putBoolean("preview",preview).apply();showShell();});add(d,sw);
  LinearLayout about=card(body);add(about,txt("About LUMAVUN Hedge",16,WHITE,true));gap(about,7);line(about,"Version 0.4.2 • Standalone Android");line(about,"Direct signed REST & ticks • paper execution");
 }
 private void connectDialog(){
  if(busy)return;if(paper!=null&&!paper.open.isEmpty()){Toast.makeText(this,"Tutup posisi paper melalui emergency sebelum mengganti akun.",Toast.LENGTH_LONG).show();return;}stopBot("STOPPED",true);paper=null;paperSymbol="";
  LinearLayout form=column();form.setPadding(dp(20),dp(6),dp(20),dp(10));
  String[] labels={"Trading account ID","API key","Private signing key (hex / PEM)","Gateway dari DNS widget"};
  EditText[] inputs=new EditText[4];
  for(int i=0;i<4;i++){EditText e=new EditText(this);e.setHint(labels[i]);e.setSingleLine(i!=2);e.setTextColor(WHITE);e.setHintTextColor(MUTED);e.setInputType(i==0?InputType.TYPE_CLASS_NUMBER:i==1||i==2?InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_VARIATION_PASSWORD:InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_VARIATION_URI);e.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO);add(form,e);inputs[i]=e;}
  AlertDialog dlg=new AlertDialog.Builder(this,android.R.style.Theme_Material_Dialog_Alert).setTitle("Connect Exness API").setView(form).setMessage("Kunci dienkripsi di Android Keystore. Gunakan akun yang mendukung Trader API.").setNegativeButton("Batal",null).setPositiveButton("Test & simpan",null).create();
  dlg.setOnShowListener(x->dlg.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v->{
   try{JSONObject j=new JSONObject().put("account",inputs[0].getText().toString().trim()).put("key",inputs[1].getText().toString().trim()).put("secret",inputs[2].getText().toString().trim()).put("gateway",inputs[3].getText().toString().trim());
    ExnessClient candidate=new ExnessClient(j);for(EditText e:inputs)e.setText("");dlg.dismiss();loadSnapshot(candidate,j);
   }catch(Exception e){Toast.makeText(this,"Periksa format account, API key, secret dan Gateway.",Toast.LENGTH_LONG).show();}
  }));dlg.show();
 }
 private void disconnect(){if(busy)return;if(paper!=null&&!paper.open.isEmpty()){Toast.makeText(this,"Tutup posisi paper terlebih dahulu.",Toast.LENGTH_LONG).show();return;}stopBot("STOPPED",true);paper=null;paperSymbol="";new AlertDialog.Builder(this).setTitle("Hapus koneksi?").setMessage("Kunci lokal dihapus. Akses di Exness tidak otomatis dicabut.").setNegativeButton("Batal",null).setPositiveButton("Hapus",(d,w)->{try{vault.clear();client=null;generation++;snapshot=null;positions=new JSONArray();deals=new JSONArray();status="API belum tersambung.";historyStatus="Belum dimuat";showShell();}catch(Exception e){status="Gagal menghapus koneksi lokal.";showShell();}}).show();}
 private void refresh(){if(preview){Toast.makeText(this,"Nonaktifkan preview untuk membaca akun.",Toast.LENGTH_SHORT).show();return;}if(client==null){connectDialog();return;}loadSnapshot(client,null);}
 private void loadSnapshot(ExnessClient c,JSONObject store){
  if(busy)return;if(System.currentTimeMillis()<cooldown){Toast.makeText(this,"Cooldown API. Jangan refresh berulang.",Toast.LENGTH_SHORT).show();return;}
  busy=true;snapshot=null;positions=new JSONArray();status="Menghubungi Exness langsung…";int ticket=++generation;showShell();
  new Thread(()->{Snapshot out=null;JSONArray pos=null;String msg="Koneksi atau format respons API belum valid.";long retry=10000;
   try{JSONObject config=c.details();JSONObject data=c.snapshot();JSONObject m=data.getJSONObject("account_state");JSONObject parsed=new JSONObject().put("status","SNAPSHOT").put("balance",m.get("balance")).put("equity",m.get("equity")).put("used_margin",m.get("used_margin")).put("currency",config.getString("currency")).put("asOf",Instant.now().toString());out=new Snapshot(parsed);pos=data.getJSONArray("positions");msg="Snapshot langsung Exness diterima.";}
   catch(ExnessClient.ApiError e){msg="Exness HTTP "+e.http+" • periksa key, scope, akun atau kuota.";if(e.http==429)retry=60000;}
   catch(Exception ignored){}
   final Snapshot value=out;final JSONArray list=pos;final String message=msg;final long delay=retry;
   handler.post(()->{if(ticket!=generation||isDestroyed()||isFinishing())return;busy=false;cooldown=System.currentTimeMillis()+delay;status=message;
    if(value!=null&&list!=null){try{if(store!=null){vault.save(store);deals=new JSONArray();historyStatus="Belum dimuat";}client=c;snapshot=value;positions=list;preview=false;prefs.edit().putBoolean("preview",false).apply();}catch(Exception e){status="Gagal menyimpan kunci lokal.";snapshot=null;positions=new JSONArray();}}
    showShell();if(snapshot!=null)handler.postDelayed(()->{if(ticket==generation&&!isDestroyed()){snapshot=null;positions=new JSONArray();status="Snapshot kedaluwarsa. Refresh saldo.";showShell();}},30000);
   });
  },"exness-direct-snapshot").start();
 }
 private void refreshHistory(){
  if(preview||busy)return;if(client==null){connectDialog();return;}if(System.currentTimeMillis()<cooldown){Toast.makeText(this,"Cooldown API",Toast.LENGTH_SHORT).show();return;}
  final ExnessClient current=client;final int ticket=++generation;busy=true;historyStatus="Memuat close deals 24 jam terakhir…";deals=new JSONArray();snapshot=null;positions=new JSONArray();showShell();
  new Thread(()->{JSONArray result=null;String message="History tidak tersedia atau rentang ditolak oleh API.";long delay=10000;
   try{current.limits();Instant end=Instant.now(),start=end.minusSeconds(86400);String query="from="+Uri.encode(start.toString())+"&to="+Uri.encode(end.toString())+"&deal_type=close&limit=100";JSONObject payload=current.deals(query);result=payload.getJSONArray("items");message="Close deals • 24 jam • "+result.length()+" transaksi"+(payload.optBoolean("has_more")||!payload.optString("next_cursor","").isEmpty()?" • halaman pertama, belum lengkap":"");}
   catch(ExnessClient.ApiError e){message="Exness HTTP "+e.http+" • history gagal";if(e.http==429)delay=60000;}catch(Exception ignored){}
   final JSONArray list=result;final String msg=message;final long wait=delay;handler.post(()->{if(ticket!=generation||isDestroyed()||client!=current)return;busy=false;cooldown=System.currentTimeMillis()+wait;historyStatus=msg;deals=list==null?new JSONArray():list;showShell();});},"exness-history").start();
 }
 @Override public void onBackPressed(){if(tab!=0){tab=0;showShell();}else super.onBackPressed();}
 @Override protected void onPause(){stopBot("PAUSED / APP BACKGROUND",true);generation++;busy=false;snapshot=null;positions=new JSONArray();status="Refresh saldo setelah kembali ke aplikasi.";super.onPause();}
 @Override protected void onResume(){super.onResume();if(root!=null)showShell();}
 @Override protected void onDestroy(){botGeneration++;if(ticks!=null){ticks.cancel();ticks=null;}socketClient.dispatcher().executorService().shutdown();generation++;handler.removeCallbacksAndMessages(null);super.onDestroy();}
 private class NavIcon extends View{
  int kind,col;Paint p=new Paint(3);NavIcon(int k,int c){super(MainActivity.this);kind=k;col=c;setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO);}
  @Override protected void onDraw(Canvas c){super.onDraw(c);c.save();c.scale(getWidth()/24f,getHeight()/24f);p.setColor(col);p.setStrokeWidth(1.6f);p.setStyle(Paint.Style.STROKE);p.setStrokeCap(Paint.Cap.ROUND);p.setStrokeJoin(Paint.Join.ROUND);
   if(kind==0){Path x=new Path();x.moveTo(3,11);x.lineTo(12,3);x.lineTo(21,11);x.lineTo(19,11);x.lineTo(19,21);x.lineTo(14,21);x.lineTo(14,15);x.lineTo(10,15);x.lineTo(10,21);x.lineTo(5,21);x.lineTo(5,11);x.close();c.drawPath(x,p);}
   else if(kind==1){for(int x=4;x<=14;x+=10)for(int y=4;y<=14;y+=10)c.drawRoundRect(x,y,x+6,y+6,1,1,p);}
   else if(kind==2){c.drawRoundRect(4,7,20,20,4,4,p);c.drawLine(12,7,12,3,p);c.drawCircle(12,3,1,p);c.drawCircle(9,12,1,p);c.drawCircle(15,12,1,p);c.drawLine(9,16,15,16,p);}
   else if(kind==3){c.drawCircle(12,12,8,p);c.drawLine(12,7,12,12,p);c.drawLine(12,12,16,14,p);c.drawLine(3,5,3,10,p);c.drawLine(3,10,7,10,p);}
   else{c.drawCircle(12,12,7,p);c.drawCircle(12,12,2.7f,p);for(int i=0;i<8;i++){double a=i*Math.PI/4;c.drawLine(12+8*(float)Math.cos(a),12+8*(float)Math.sin(a),12+10*(float)Math.cos(a),12+10*(float)Math.sin(a),p);}}
   c.restore();
  }
 }
 private class ChartView extends View{
  final boolean demo,ring;final Paint p=new Paint(3);
  ChartView(boolean d,boolean r){super(MainActivity.this);demo=d;ring=r;}
  @Override protected void onDraw(Canvas c){super.onDraw(c);float w=getWidth(),h=getHeight();p.setStyle(Paint.Style.STROKE);p.setStrokeWidth(dp(1));p.setColor(BORDER);
   if(ring){float radius=Math.min(w,h)*.29f;RectF rect=new RectF(w/2-radius,h/2-radius,w/2+radius,h/2+radius);p.setStrokeWidth(dp(18));p.setColor(BORDER);c.drawArc(rect,0,360,false,p);if(demo){p.setColor(TEAL);c.drawArc(rect,-90,240,false,p);p.setColor(PURPLE);c.drawArc(rect,150,120,false,p);}p.setStyle(Paint.Style.FILL);p.setTextAlign(Paint.Align.CENTER);p.setColor(WHITE);p.setTextSize(dp(23));c.drawText(demo?"6":"—",w/2,h/2+dp(7),p);return;}
   for(int i=1;i<5;i++){float y=h*i/5;c.drawLine(dp(4),y,w-dp(4),y,p);}if(!demo){p.setStyle(Paint.Style.FILL);p.setColor(MUTED);p.setTextSize(dp(12));p.setTextAlign(Paint.Align.CENTER);c.drawText("History belum tersedia",w/2,h/2,p);return;}
   plot(c,demoBalance,PURPLE,w,h);plot(c,demoEquity,TEAL,w,h);
  }
  void plot(Canvas c,float[] values,int color,float w,float h){Path path=new Path();float inset=dp(6);for(int i=0;i<values.length;i++){float x=inset+(w-2*inset)*i/(values.length-1),y=h-inset-(h-2*inset)*values[i]/190;if(i==0)path.moveTo(x,y);else path.lineTo(x,y);}p.setStyle(Paint.Style.STROKE);p.setStrokeWidth(dp(2.4f));p.setColor(color);p.setStrokeJoin(Paint.Join.ROUND);p.setStrokeCap(Paint.Cap.ROUND);c.drawPath(path,p);}
 }
}
