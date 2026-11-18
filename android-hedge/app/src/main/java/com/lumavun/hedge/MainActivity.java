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
 private ScrollView pageScroll;
 private int renderedTab=-1;
 private TextView botLiveText,botLogText,botStateText,botSymbolText,brokerSummaryText,historyLiveText;
 private LiveBroker live;
 private ExnessClient client;
 private String botStatus="STOPPED",preferredSymbol="",liveSymbol="",lastLiveReason="";
 private final java.util.ArrayDeque<String> botLogs=new java.util.ArrayDeque<>();
 private long lastPaint=0;
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
  setContentView(root);preview=false;prefs.edit().putBoolean("preview",false).apply();showShell();
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
  final int oldY=pageScroll!=null&&renderedTab==tab?pageScroll.getScrollY():0;
  renderedTab=tab;botLiveText=null;botLogText=null;botStateText=null;brokerSummaryText=null;historyLiveText=null;botSymbolText=null;
  root.removeAllViews();shell=column();shell.setBackgroundColor(BG);root.addView(shell,new LinearLayout.LayoutParams(-1,-1));
  LinearLayout header=row();header.setPadding(dp(17),dp(12),dp(17),dp(10));
  LinearLayout mark=column();TextView name=txt("◈  LUMAVUN  HEDGE",20,WHITE,true);add(mark,name);add(mark,txt("DIRECT API  /  v0.5.0",11,TEAL,true));header.addView(mark,new LinearLayout.LayoutParams(0,-2,1));
  TextView mode=txt(preview?"PREVIEW":snapshot!=null?"SNAPSHOT":client==null?"OFFLINE":"API SAVED",11,preview?PURPLE:TEAL,true);mode.setPadding(dp(10),dp(7),dp(10),dp(7));mode.setBackground(bg(PANEL,BORDER,10));header.addView(mode);add(shell,header);
  ScrollView scroll=new ScrollView(this);pageScroll=scroll;scroll.setFillViewport(true);body=column();body.setPadding(dp(16),dp(6),dp(16),dp(18));scroll.addView(body,new ScrollView.LayoutParams(-1,-2));shell.addView(scroll,new LinearLayout.LayoutParams(-1,0,1));
  nav=row();nav.setPadding(dp(3),dp(4),dp(3),dp(5));nav.setBackground(bg(0xff101c29,BORDER,0));
  for(int i=0;i<TABS.length;i++){final int ix=i;LinearLayout cell=column();cell.setGravity(Gravity.CENTER);cell.setPadding(0,dp(5),0,dp(5));cell.setMinimumHeight(dp(58));int color=i==tab?TEAL:MUTED;View icon=new NavIcon(i,color);cell.addView(icon,new LinearLayout.LayoutParams(dp(26),dp(26)));TextView cap=txt(TABS[i],11,color,i==tab);cap.setGravity(Gravity.CENTER);add(cell,cap);cell.setContentDescription(TABS[i]);cell.setSelected(i==tab);cell.setClickable(true);cell.setFocusable(true);cell.setOnClickListener(v->{tab=ix;showShell();});nav.addView(cell,new LinearLayout.LayoutParams(0,-2,1));}
  add(shell,nav);
  if(preview){TextView warning=txt("PREVIEW DESAIN • semua angka contoh, bukan data broker",12,PURPLE,true);warning.setPadding(dp(10),dp(8),dp(10),dp(8));warning.setBackground(bg(0xff211d38,0xff65548e,10));add(body,warning);gap(body,12);}
  switch(tab){case 0: home();break;case 1: dashboard();break;case 2: bot();break;case 3: history();break;default:settings();}
  if(oldY>0)scroll.post(()->{if(pageScroll==scroll)scroll.scrollTo(0,oldY);});
 }
 private String amount(BigDecimal x){return new DecimalFormat("#,##0.00").format(x);}
 private String val(String example,BigDecimal value){return preview?example:value==null?"—":amount(value);}
 private int pnlColor(BigDecimal p){return p==null?MUTED:p.signum()<0?RED:TEAL;}
 private BigDecimal floating(){return snapshot==null?null:snapshot.equity.subtract(snapshot.balance);}
 private String money(BigDecimal v){return v==null?"—":amount(v)+(snapshot==null?"":" "+snapshot.currency);}
 private boolean active(){return live!=null&&live.active;}
 private void home(){
  add(body,txt("Account overview",24,WHITE,true));gap(body,13);
  LinearLayout hero=column();GradientDrawable gradient=new GradientDrawable(GradientDrawable.Orientation.TL_BR,new int[]{0xff123e45,0xff182637,0xff302347});gradient.setCornerRadius(dp(18));gradient.setStroke(dp(1),0xff518b9c);hero.setBackground(gradient);hero.setPadding(dp(17),dp(16),dp(17),dp(14));add(body,hero);
  add(hero,txt("EXNESS BROKER ACCOUNT",13,TEAL,true));brokerSummaryText=txt("",20,WHITE,true);add(hero,brokerSummaryText);gap(hero,12);
  LinearLayout buttons=row();weighted(buttons,action("Refresh saldo",true,()->refresh()),false);weighted(buttons,action("Akun Exness",false,()->connectDialog()),true);add(hero,buttons);
  heading("Hedge engine");LinearLayout engine=card(body);line(engine,"Eksekusi langsung melalui Exness API. Saldo hanya dari broker.");add(engine,action("Buka kontrol bot",false,()->{tab=2;showShell();}));updateLiveViews();
 }
 private String statusText(){return status;}
 private void dashboard(){
  add(body,txt("Analytics & Dashboard",25,WHITE,true));gap(body,13);LinearLayout current=card(body);add(current,txt("Broker account • data asli",17,TEAL,true));brokerSummaryText=txt("",16,WHITE,true);add(current,brokerSummaryText);gap(current,8);add(current,action("Refresh saldo",false,()->refresh()));
  LinearLayout trade=card(body);add(trade,txt("Realized trading results",17,WHITE,true));historyLiveText=txt("",14,WHITE,false);add(trade,historyLiveText);gap(trade,8);add(trade,action("Buka history broker",false,()->{tab=3;showShell();}));updateLiveViews();
 }
 private void bot(){
  add(body,txt("Live Hedge Engine",25,WHITE,true));gap(body,13);
  LinearLayout c=card(body);botStateText=txt("",17,TEAL,true);add(c,botStateText);line(c,"LIVE • order broker sungguhan. Posisi bisa rugi dan terkena stop-out.");
  gap(c,10);LinearLayout controls=row();weighted(controls,action("START BOT",true,()->startBot()),false);weighted(controls,action("STOP BOT",false,()->stopBot("STOPPED • posisi tetap terbuka")),true);add(c,controls);gap(c,8);add(c,action("EMERGENCY CLOSE BOT POSITIONS",false,()->emergencyLive()));
  LinearLayout p=card(body);add(p,txt("Active strategy",17,WHITE,true));gap(p,8);botSymbolText=txt("",14,WHITE,true);add(p,botSymbolText);add(p,action("Pilih simbol XAUUSD",false,()->selectSymbol()));gap(p,8);labelValue(p,"Strategy","EMA tick 9/21 • hedge",TEAL);labelValue(p,"Volume","0.01 lot",WHITE);labelValue(p,"Profit target","$1 gross / posisi",TEAL);labelValue(p,"Position cap","5",WHITE);labelValue(p,"Drawdown guard","15%",RED);labelValue(p,"Entry cooldown","≥30s • kuota API",WHITE);line(p,"Margin konservatif; posisi minus ditahan sampai recovery atau emergency. Stop/aplikasi di background menghentikan bot, bukan menutup posisi.");
  LinearLayout v=card(body);add(v,txt("Exness account & positions",17,WHITE,true));botLiveText=txt("",14,WHITE,false);add(v,botLiveText);
  LinearLayout logs=card(body);add(logs,txt("Engine logs",16,WHITE,true));gap(logs,8);botLogText=txt("",13,MUTED,false);botLogText.setTextIsSelectable(true);botLogText.setFocusableInTouchMode(false);add(logs,botLogText);updateLiveViews();
 }
 private void logBot(String message){if(message==null||message.isEmpty())return;if(botLogs.size()>=100)botLogs.removeFirst();botLogs.addLast(new java.text.SimpleDateFormat("HH:mm:ss",Locale.US).format(new java.util.Date())+"  "+message);}
 private String brokerSummary(){
  if(snapshot==null||System.currentTimeMillis()-snapshot.time>30000)return "Balance: —\nEquity: —\nFloating PnL: —\nData broker belum tersedia atau kedaluwarsa.";
  return "Balance: "+money(snapshot.balance)+"\nEquity: "+money(snapshot.equity)+"\nFloating PnL: "+money(snapshot.equity.subtract(snapshot.balance))+"\nUsed margin: "+money(snapshot.margin)+"\nOpen positions: "+positions.length();
 }
 private String historySummary(){
  java.util.Map<String,BigDecimal[]> sum=new java.util.LinkedHashMap<>();
  for(int i=0;i<deals.length();i++){JSONObject item=deals.optJSONObject(i),d=item==null?null:item.optJSONObject("deal"),p=d==null?null:d.optJSONObject("profit");if(p==null||!"close".equals(d.optString("type")))continue;try{String cur=p.getString("currency");BigDecimal n=new BigDecimal(p.getString("amount"));BigDecimal[] a=sum.get(cur);if(a==null){a=new BigDecimal[]{BigDecimal.ZERO,BigDecimal.ZERO,BigDecimal.ZERO};sum.put(cur,a);}a[0]=a[0].add(n);if(n.signum()>0)a[1]=a[1].add(n);else a[2]=a[2].add(n);}catch(Exception ignored){}}
  StringBuilder b=new StringBuilder(historyStatus+"\n");for(java.util.Map.Entry<String,BigDecimal[]> a:sum.entrySet()){BigDecimal[] v=a.getValue();b.append("Profit: "+amount(v[1])+" "+a.getKey()+"\nLoss: "+amount(v[2])+" "+a.getKey()+"\nClose PnL: "+amount(v[0])+" "+a.getKey()+"\n");}
  b.append("Jumlah dari close deal yang dimuat; net setelah seluruh biaya belum direkonsiliasi.");return b.toString();
 }
 private void updateLiveViews(){
  if(botStateText!=null)botStateText.setText("ENGINE • "+botStatus);
  if(botSymbolText!=null)botSymbolText.setText("Instrument: "+(liveSymbol.isEmpty()?(preferredSymbol.isEmpty()?"Auto XAUUSD":preferredSymbol):liveSymbol));
  if(brokerSummaryText!=null)brokerSummaryText.setText(brokerSummary());
  if(historyLiveText!=null)historyLiveText.setText(historySummary());
  if(botLiveText!=null){StringBuilder b=new StringBuilder(brokerSummary());if(snapshot!=null&&System.currentTimeMillis()-snapshot.time<=30000)for(int i=0;i<positions.length();i++){JSONObject p=positions.optJSONObject(i);if(p!=null)b.append("\n#"+p.optString("position_id")+" "+p.optString("direction")+" "+p.optString("instrument")+" "+p.optString("volume")+" lot");}botLiveText.setText(b.toString());}
  if(botLogText!=null){String value=botLogs.isEmpty()?"Tekan START BOT untuk memulai live trading.":android.text.TextUtils.join("\n",botLogs);if(!value.contentEquals(botLogText.getText()))botLogText.setText(value);}
 }
 private void selectSymbol(){
  if(active()){Toast.makeText(this,"Stop bot dulu.",Toast.LENGTH_SHORT).show();return;}
  EditText input=new EditText(this);input.setText(preferredSymbol);input.setHint("Kosong = auto; contoh XAUUSDm");
  new AlertDialog.Builder(this).setTitle("Simbol broker").setMessage("Gunakan simbol yang tersedia di akun Exness.").setView(input).setNegativeButton("Batal",null).setPositiveButton("Simpan",(d,w)->{String v=input.getText().toString().trim();if(!v.isEmpty()&&!v.matches("XAUUSD[a-z0-9._-]{0,5}")){Toast.makeText(this,"Format simbol tidak valid",Toast.LENGTH_SHORT).show();return;}preferredSymbol=v;prefs.edit().putString("paper_symbol",v).apply();liveSymbol="";updateLiveViews();}).show();
 }
 private void startBot(){
  if(client==null){connectDialog();return;}if(active()||busy)return;
  if(System.currentTimeMillis()<cooldown){Toast.makeText(this,"Cooldown API aktif.",Toast.LENGTH_SHORT).show();return;}
  new AlertDialog.Builder(this).setTitle("Aktifkan LIVE TRADING?").setMessage("Akun Exness "+client.account+"\nBot akan mengirim order sungguhan otomatis, 0.01 lot, maksimum 5 posisi, target gross $1. Drawdown guard 15% tidak menjamin batas kerugian. Gunakan akun hedging khusus bot tanpa posisi manual. APK harus tetap aktif. Konfirmasi berarti kamu mengizinkan sesi ini.").setNegativeButton("Batal",null).setPositiveButton("START LIVE",(d,w)->{
   if(active()||busy||client==null)return;lastLiveReason="";snapshot=null;positions=new JSONArray();generation++;
   live=new LiveBroker(client,prefs,handler,preferredSymbol,(st,sym,reason,acct,pos,deal)->{
    if(isDestroyed()||isFinishing())return;
    botStatus=st;liveSymbol=sym;
    if(reason!=null&&!reason.isEmpty()&&!reason.equals(lastLiveReason)){lastLiveReason=reason;logBot(reason);}
    if(acct!=null&&live!=null&&live.active&&!live.currency.isEmpty()){
     try{JSONObject parsed=new JSONObject().put("status","SNAPSHOT").put("balance",acct.get("balance")).put("equity",acct.get("equity")).put("used_margin",acct.get("used_margin")).put("currency",live.currency).put("asOf",java.time.Instant.ofEpochMilli(live.stateTime).toString());snapshot=new Snapshot(parsed);positions=pos;}catch(Exception ex){snapshot=null;positions=new JSONArray();}
    } else if(!active()){snapshot=null;positions=new JSONArray();cooldown=System.currentTimeMillis()+60000;status="Bot berhenti; refresh broker setelah cooldown.";}
    if(deal!=null){appendBrokerDeal(deal);if(tab==3)showShell();}
    long now=System.currentTimeMillis();if(deal!=null||!active()||now-lastPaint>=500){lastPaint=now;updateLiveViews();}
   });
   logBot("LIVE session authorized");live.start();updateLiveViews();
  }).show();
 }
 private void stopBot(String why){if(live!=null&&live.active)live.halt(why);else{botStatus="STOPPED";logBot(why);updateLiveViews();}}
 private void emergencyLive(){
  if(!active()){Toast.makeText(this,"Bot tidak terhubung. Tutup posisi melalui Exness.",Toast.LENGTH_LONG).show();return;}
  new AlertDialog.Builder(this).setTitle("Close posisi nyata milik bot?").setMessage("Order close dapat merealisasikan kerugian. Posisi manual tidak disentuh. Jika jaringan terputus, tutup di broker.").setNegativeButton("Batal",null).setPositiveButton("CLOSE BOT",(d,w)->{if(active())live.emergency();}).show();
 }
 private void appendBrokerDeal(JSONObject deal){
  if(!"close".equals(deal.optString("type")))return;String id=deal.optString("deal_id");if(id.isEmpty())return;
  for(int i=0;i<deals.length();i++){JSONObject row=deals.optJSONObject(i),x=row==null?null:row.optJSONObject("deal");if(x!=null&&id.equals(x.optString("deal_id")))return;}
  try{deals.put(new JSONObject().put("event_time",deal.optString("create_time")).put("deal",deal));historyStatus="Close deals broker yang diterima; refresh saat bot berhenti untuk riwayat API.";}catch(Exception ignored){}
 }
 private void history(){
  add(body,txt("Trade History • Exness",25,WHITE,true));gap(body,13);LinearLayout filters=row();String[] names={"All","Profit","Loss"};for(int i=0;i<3;i++){final int n=i;TextView t=action(names[i],filter==i,()->{filter=n;showShell();});weighted(filters,t,i!=0);}add(body,filters);gap(body,12);
  LinearLayout total=card(body);historyLiveText=txt(historySummary(),14,WHITE,true);add(total,historyLiveText);gap(total,8);add(total,action("Refresh history broker",false,()->refreshHistory()));
  for(int i=deals.length()-1;i>=0;i--){JSONObject row=deals.optJSONObject(i),p=row==null?null:row.optJSONObject("deal");if(p==null)continue;JSONObject profit=p.optJSONObject("profit");if(profit==null)continue;try{BigDecimal n=new BigDecimal(profit.getString("amount"));if((filter==1&&n.signum()<=0)||(filter==2&&n.signum()>=0))continue;LinearLayout trade=card(body);labelValue(trade,p.optString("instrument")+" • "+p.optString("direction"),amount(n)+" "+profit.optString("currency"),pnlColor(n));line(trade,"Deal #"+p.optString("deal_id")+" • "+row.optString("event_time"));line(trade,"Volume: "+p.optString("volume")+" • Harga: "+p.optString("price"));}catch(Exception ignored){}}
 }
 private void settings(){
  add(body,txt("System Settings",25,WHITE,true));gap(body,13);
  LinearLayout c=card(body);add(c,txt("Exness account",17,WHITE,true));gap(c,8);line(c,client==null?"API belum tersambung. Tidak perlu login LUMAVUN.":"API lokal tersimpan • akun "+client.account);gap(c,10);add(c,action("Sambungkan API Exness",true,()->connectDialog()));gap(c,8);add(c,action("Hapus koneksi lokal",false,()->disconnect()));
  LinearLayout p=card(body);add(p,txt("Risk management",17,WHITE,true));gap(p,10);labelValue(p,"Profit target","$1 gross",TEAL);labelValue(p,"Drawdown guard","15% • tidak dijamin",RED);labelValue(p,"Martingale","Nonaktif",MUTED);line(p,"Akun khusus bot, USD/USC, market execution. Status order ambigu mengunci Start. Gunakan Exness untuk cek/close posisi jika terputus.");
  LinearLayout about=card(body);add(about,txt("About LUMAVUN Hedge",16,WHITE,true));gap(about,7);line(about,"Version 0.5.0 • Native Android");line(about,"Direct REST + broker transaction and tick streams • LIVE only");
 }
 private void connectDialog(){
  if(busy||active()){Toast.makeText(this,"Stop bot sebelum mengganti akun.",Toast.LENGTH_LONG).show();return;}
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
 private void disconnect(){if(busy||active()){Toast.makeText(this,"Stop bot terlebih dahulu.",Toast.LENGTH_LONG).show();return;}new AlertDialog.Builder(this).setTitle("Hapus koneksi?").setMessage("Kunci lokal dihapus. Akses di Exness tidak otomatis dicabut.").setNegativeButton("Batal",null).setPositiveButton("Hapus",(d,w)->{try{vault.clear();client=null;generation++;snapshot=null;positions=new JSONArray();deals=new JSONArray();status="API belum tersambung.";historyStatus="Belum dimuat";showShell();}catch(Exception e){status="Gagal menghapus koneksi lokal.";showShell();}}).show();}
 private void refresh(){if(active()){updateLiveViews();return;}if(preview){Toast.makeText(this,"Nonaktifkan preview untuk membaca akun.",Toast.LENGTH_SHORT).show();return;}if(client==null){connectDialog();return;}loadSnapshot(client,null);}
 private void loadSnapshot(ExnessClient c,JSONObject store){
  if(busy)return;if(System.currentTimeMillis()<cooldown){Toast.makeText(this,"Cooldown API. Jangan refresh berulang.",Toast.LENGTH_SHORT).show();return;}
  busy=true;snapshot=null;positions=new JSONArray();status="Menghubungi Exness langsung…";int ticket=++generation;showShell();
  new Thread(()->{Snapshot out=null;JSONArray pos=null;String msg="Koneksi atau format respons API belum valid.";long retry=10000;
   try{JSONObject config=c.details();JSONObject data=c.snapshot();JSONObject m=data.getJSONObject("account_state");JSONObject parsed=new JSONObject().put("status","SNAPSHOT").put("balance",m.get("balance")).put("equity",m.get("equity")).put("used_margin",m.get("used_margin")).put("currency",config.getString("currency")).put("asOf",Instant.now().toString());out=new Snapshot(parsed);pos=data.getJSONArray("positions");msg="Snapshot langsung Exness diterima.";}
   catch(ExnessClient.ApiError e){msg="Exness HTTP "+e.http+" • periksa key, scope, akun atau kuota.";if(e.http==429)retry=60000;}
   catch(Exception ignored){}
   final Snapshot value=out;final JSONArray list=pos;final String message=msg;final long delay=retry;
   handler.post(()->{if(ticket!=generation||isDestroyed()||isFinishing())return;busy=false;cooldown=System.currentTimeMillis()+delay;status=message;
    if(value!=null&&list!=null){try{if(store!=null){vault.save(store);deals=new JSONArray();historyStatus="Belum dimuat";}client=c;if(store!=null){live=null;liveSymbol="";botStatus="STOPPED";}snapshot=value;positions=list;preview=false;prefs.edit().putBoolean("preview",false).apply();}catch(Exception e){status="Gagal menyimpan kunci lokal.";snapshot=null;positions=new JSONArray();}}
    showShell();if(snapshot!=null)handler.postDelayed(()->{if(ticket==generation&&!isDestroyed()){snapshot=null;positions=new JSONArray();status="Snapshot kedaluwarsa. Refresh saldo.";showShell();}},30000);
   });
  },"exness-direct-snapshot").start();
 }
 private void refreshHistory(){
  if(active()){Toast.makeText(this,"Histori baru masuk dari stream; stop bot untuk refresh REST.",Toast.LENGTH_LONG).show();return;}if(preview||busy)return;if(client==null){connectDialog();return;}if(System.currentTimeMillis()<cooldown){Toast.makeText(this,"Cooldown API",Toast.LENGTH_SHORT).show();return;}
  final ExnessClient current=client;final int ticket=++generation;busy=true;historyStatus="Memuat close deals 24 jam terakhir…";deals=new JSONArray();snapshot=null;positions=new JSONArray();showShell();
  new Thread(()->{JSONArray result=null;String message="History tidak tersedia atau rentang ditolak oleh API.";long delay=10000;
   try{current.limits();Instant end=Instant.now(),start=end.minusSeconds(86400);String query="from="+Uri.encode(start.toString())+"&to="+Uri.encode(end.toString())+"&deal_type=close&limit=100";JSONObject payload=current.deals(query);result=payload.getJSONArray("items");message="Close deals • 24 jam • "+result.length()+" transaksi"+(payload.optBoolean("has_more")||!payload.optString("next_cursor","").isEmpty()?" • halaman pertama, belum lengkap":"");}
   catch(ExnessClient.ApiError e){message="Exness HTTP "+e.http+" • history gagal";if(e.http==429)delay=60000;}catch(Exception ignored){}
   final JSONArray list=result;final String msg=message;final long wait=delay;handler.post(()->{if(ticket!=generation||isDestroyed()||client!=current)return;busy=false;cooldown=System.currentTimeMillis()+wait;historyStatus=msg;deals=list==null?new JSONArray():list;showShell();});},"exness-history").start();
 }
 @Override public void onBackPressed(){if(tab!=0){tab=0;showShell();}else super.onBackPressed();}
 @Override protected void onPause(){if(active())stopBot("PAUSED / APP BACKGROUND • posisi tetap terbuka");generation++;busy=false;snapshot=null;positions=new JSONArray();status="Refresh saldo setelah kembali ke aplikasi.";super.onPause();}
 @Override protected void onResume(){super.onResume();if(root!=null)showShell();}
 @Override protected void onDestroy(){if(active())live.halt("APP CLOSED • posisi tetap terbuka");generation++;handler.removeCallbacksAndMessages(null);super.onDestroy();}
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
