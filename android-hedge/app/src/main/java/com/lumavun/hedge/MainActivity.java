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
import android.webkit.*;
import android.widget.*;
import java.io.*;
import java.net.*;
import javax.net.ssl.HttpsURLConnection;
import java.math.BigDecimal;
import java.text.DecimalFormat;
import java.time.OffsetDateTime;
import java.util.Locale;
import org.json.JSONObject;

public class MainActivity extends Activity {
 private static final String ORIGIN="https://bot-trading-terminal.vercel.app";
 private static final int BG=0xff090e19, PANEL=0xff13222f, BORDER=0xff344f60, WHITE=0xffeff7fa, MUTED=0xffa9bbc9, TEAL=0xff55f3c1, PURPLE=0xffa58bff, RED=0xffff8497;
 private static final String[] TABS={"Home","Dashboard","Bot","History","Settings"};
 private LinearLayout root, shell, body, nav, browser;
 private WebView web;
 private SharedPreferences prefs;
 private final Handler handler=new Handler(Looper.getMainLooper());
 private int tab=0, filter=0, generation=0;
 private boolean preview=false, busy=false, browserOpen=false;
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
  super.onCreate(state);getWindow().setStatusBarColor(BG);getWindow().setNavigationBarColor(BG);
  prefs=getSharedPreferences("lumavun_ui",MODE_PRIVATE);preview=prefs.getBoolean("preview",false);
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
  browserOpen=false;root.removeAllViews();shell=column();shell.setBackgroundColor(BG);root.addView(shell,new LinearLayout.LayoutParams(-1,-1));
  LinearLayout header=row();header.setPadding(dp(17),dp(12),dp(17),dp(10));
  LinearLayout mark=column();TextView name=txt("◈  LUMAVUN  HEDGE",20,WHITE,true);add(mark,name);add(mark,txt("PAPER EXECUTION  /  v0.2",11,TEAL,true));header.addView(mark,new LinearLayout.LayoutParams(0,-2,1));
  TextView mode=txt(preview?"PREVIEW":"EXNESS",11,preview?PURPLE:TEAL,true);mode.setPadding(dp(10),dp(7),dp(10),dp(7));mode.setBackground(bg(PANEL,BORDER,10));header.addView(mode);add(shell,header);
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
  LinearLayout buttons=row();weighted(buttons,action(busy?"Memuat…":"Refresh saldo",true,()->refresh()),false);weighted(buttons,action("Akun Exness",false,()->openWeb("/accounts")),true);add(hero,buttons);gap(hero,9);line(hero,preview?"Mode contoh aktif.":statusText());
  heading("Account metrics");
  LinearLayout r=row();metric(r,"Equity",val("116.20",snapshot==null?null:snapshot.equity),WHITE,false);metric(r,"Floating PnL*",val("−12.30",floating()),preview?RED:pnlColor(floating()),true);add(body,r);gap(body,10);
  LinearLayout r2=row();metric(r2,"Used margin",val("8.00",snapshot==null?null:snapshot.margin),WHITE,false);metric(r2,"Account type",preview?"Contoh":"Belum diverifikasi",MUTED,true);add(body,r2);gap(body,8);line(body,"*Equity − balance adalah selisih snapshot, bukan rincian PnL trade.");
  heading("Market pulse");
  LinearLayout market=card(body);labelValue(market,"XAUUSD / Gold","Exness feed",TEAL);line(market,"Harga dan simbol akun tersedia di terminal setelah koneksi terverifikasi.");gap(market,9);add(market,action("Buka live market",false,()->openWeb("/?feed=live")));
  heading("Hedge engine");
  LinearLayout engine=card(body);labelValue(engine,"Execution","PAPER ONLY",TEAL);line(engine,"Engine hedging belum terhubung ke order broker. Buka Bot untuk kontrol paper yang tersedia.");
 }
 private String statusText(){if(snapshot!=null&&System.currentTimeMillis()-snapshot.time>30000)return "Snapshot kedaluwarsa • refresh kembali.";return status;}
 private void metric(LinearLayout r,String label,String value,int color,boolean right){LinearLayout c=column();c.setBackground(bg(PANEL,BORDER,13));c.setPadding(dp(12),dp(12),dp(12),dp(12));add(c,txt(label,12,MUTED,false));gap(c,7);add(c,txt(value,value.length()>15?14:21,color,true));weighted(r,c,right);}
 private void dashboard(){
  add(body,txt("Analytics & Dashboard",25,WHITE,true));gap(body,13);
  LinearLayout chart=card(body);add(chart,txt(preview?"Contoh grafik equity & balance":"Equity & balance history",16,WHITE,true));gap(chart,8);
  ChartView graph=new ChartView(preview,false);graph.setContentDescription(preview?"Contoh grafik equity dan balance, bukan data broker":"Riwayat equity belum tersedia");chart.addView(graph,new LinearLayout.LayoutParams(-1,dp(180)));
  line(chart,preview?"Teal: equity  •  Ungu: balance (contoh)":"Riwayat broker belum terintegrasi. Tidak ada grafik sintetis di mode akun.");
  LinearLayout r=row();metric(r,"Win rate",preview?"66.7%":"—",TEAL,false);metric(r,"Realized PnL",preview?"+1.45":"—",TEAL,true);add(body,r);gap(body,10);
  LinearLayout dist=card(body);add(dist,txt("Trade distribution",16,WHITE,true));ChartView donut=new ChartView(preview,true);donut.setContentDescription(preview?"Contoh distribusi, empat profit dan dua loss":"Distribusi belum tersedia");dist.addView(donut,new LinearLayout.LayoutParams(-1,dp(150)));line(dist,preview?"Contoh: 4 profit • 2 loss":"Belum ada riwayat deal broker.");
  LinearLayout current=card(body);add(current,txt("Broker snapshot",16,WHITE,true));gap(current,8);labelValue(current,"Balance",val("128.50",snapshot==null?null:snapshot.balance),WHITE);labelValue(current,"Equity",val("116.20",snapshot==null?null:snapshot.equity),TEAL);add(current,action("Refresh saldo",false,()->refresh()));
 }
 private void bot(){
  add(body,txt("Hedge Engine Control",25,WHITE,true));gap(body,13);
  LinearLayout c=card(body);labelValue(c,"Engine status","PAPER ONLY",TEAL);line(c,"Kontrol native belum terhubung. Bot terminal menggunakan strategi paper existing, bukan engine hedging baru.");gap(c,10);add(c,action("Buka kontrol bot paper",true,()->openWeb("/bot?feed=live")));gap(c,8);line(c,"Start/stop dilakukan di terminal. Menutup terminal menghentikan halaman paper.");
  LinearLayout p=card(body);add(p,txt("Active strategy • rancangan",17,WHITE,true));gap(p,12);labelValue(p,"Strategy","Dynamic Hedging",TEAL);labelValue(p,"Instrument","XAUUSD",WHITE);labelValue(p,"Volume","0.01 lot",WHITE);labelValue(p,"Profit target","$1 / posisi",TEAL);labelValue(p,"Entry cooldown","30 detik",WHITE);labelValue(p,"Position cap","5",WHITE);labelValue(p,"Drawdown guard","15%",RED);line(p,"Parameter prototype, bukan konfigurasi aktif atau hasil backtest.");
  LinearLayout logs=card(body);add(logs,txt("Engine logs",16,WHITE,true));gap(logs,8);line(logs,"Belum ada worker hedging aktif. Log eksekusi nyata belum tersedia.");
 }
 private void history(){
  add(body,txt("Trade History",25,WHITE,true));gap(body,13);
  LinearLayout filters=row();String[] names={"All","Profit","Loss"};for(int i=0;i<3;i++){final int n=i;TextView t=action(names[i],filter==i,()->{filter=n;showShell();});if(i==0)weighted(filters,t,false);else weighted(filters,t,true);}add(body,filters);gap(body,12);
  LinearLayout total=card(body);add(total,txt("Total realized PnL",13,MUTED,false));add(total,txt(preview?"+1.45":"—",27,TEAL,true));line(total,preview?"Contoh riwayat • USD":"Riwayat broker belum terhubung");
  if(preview){for(int i=0;i<demoPnl.length;i++){double p=demoPnl[i];if((filter==1&&p<0)||(filter==2&&p>=0))continue;LinearLayout trade=card(body);labelValue(trade,"Contoh #"+(i+1)+" • "+demoSides[i],String.format(Locale.US,"%+.2f USD",p),p>=0?TEAL:RED);line(trade,"Simulasi ilustratif • bukan transaksi Exness");}}
  else{LinearLayout empty=card(body);add(empty,txt("Belum ada data history broker",18,WHITE,true));gap(empty,8);line(empty,"Riwayat paper yang sudah ada tetap dapat dilihat di terminal. Tidak dicampur dengan transaksi broker.");gap(empty,12);add(empty,action("Buka riwayat paper",false,()->openWeb("/?feed=live")));}
 }
 private void settings(){
  add(body,txt("System Settings",25,WHITE,true));gap(body,13);
  LinearLayout c=card(body);add(c,txt("Exness account",17,WHITE,true));gap(c,8);line(c,"Koneksi dan kunci API dikelola oleh terminal HTTPS yang sudah ada.");gap(c,10);add(c,action("Kelola koneksi Exness",true,()->openWeb("/accounts")));
  LinearLayout p=card(body);add(p,txt("Risk management",17,WHITE,true));gap(p,10);labelValue(p,"Individual take profit","$1 (rancangan)",TEAL);labelValue(p,"Emergency drawdown","15% (rancangan)",RED);labelValue(p,"Martingale","Nonaktif",MUTED);line(p,"Pengaturan engine native belum diterapkan pada transaksi.");
  LinearLayout d=card(body);add(d,txt("Appearance",17,WHITE,true));gap(d,8);labelValue(d,"Theme","Midnight / teal",TEAL);Switch sw=new Switch(this);sw.setText("Preview desain (data contoh)");sw.setTextColor(WHITE);sw.setTextSize(14);sw.setMinHeight(dp(48));sw.setChecked(preview);sw.setOnCheckedChangeListener((b,checked)->{preview=checked;snapshot=null;generation++;busy=false;prefs.edit().putBoolean("preview",preview).apply();showShell();});add(d,sw);
  LinearLayout about=card(body);add(about,txt("About LUMAVUN Hedge",16,WHITE,true));gap(about,7);line(about,"Version 0.2 • Native Android UI");line(about,"No native broker orders • no cloud worker");
 }
 private void refresh(){
  if(preview){status="Preview desain aktif.";return;}
  if(busy)return;if(System.currentTimeMillis()<cooldown){status="Cooldown refresh. Coba kembali setelah batas waktu.";showShell();return;}
  String cookie=CookieManager.getInstance().getCookie(ORIGIN+"/api/account/monitor");
  if(cookie==null||cookie.isEmpty()){snapshot=null;status="Masuk dan pilih akun melalui Akun Exness.";showShell();return;}
  busy=true;snapshot=null;status="Memuat snapshot akun…";int ticket=++generation;showShell();
  new Thread(()->{Snapshot result=null;String message="Snapshot tidak tersedia. Periksa koneksi serta akun terpilih.";long retry=0;HttpsURLConnection conn=null;
   try{conn=(HttpsURLConnection)new URL(ORIGIN+"/api/account/monitor").openConnection();conn.setInstanceFollowRedirects(false);conn.setConnectTimeout(8000);conn.setReadTimeout(8000);conn.setRequestMethod("GET");conn.setRequestProperty("Accept","application/json");conn.setRequestProperty("Cache-Control","no-store");conn.setRequestProperty("Cookie",cookie);
    int code=conn.getResponseCode();if(code==200){try(InputStream in=conn.getInputStream();ByteArrayOutputStream bytes=new ByteArrayOutputStream()){byte[] chunk=new byte[1024];int n;while((n=in.read(chunk))!=-1){if(bytes.size()+n>16384)throw new IOException();bytes.write(chunk,0,n);}result=new Snapshot(new JSONObject(bytes.toString("UTF-8")));message="Snapshot Exness terverifikasi oleh respons API.";}}
    else if(code==401||code==409)message="Login atau pilih akun yang sudah terverifikasi di Akun Exness.";
    else if(code==429){message="Kuota Exness tercapai. Jangan refresh berulang.";String h=conn.getHeaderField("Retry-After");try{long sec=Long.parseLong(h);if(sec>0&&sec<=86400)retry=sec*1000;}catch(Exception ignored){retry=60000;}}
   }catch(Exception ignored){}finally{if(conn!=null)conn.disconnect();}
   final Snapshot done=result;final String msg=message;final long wait=retry;
   handler.post(()->{if(ticket!=generation||isFinishing()||isDestroyed()||browserOpen||preview)return;busy=false;snapshot=done;status=msg;cooldown=System.currentTimeMillis()+Math.max(10000,wait);showShell();if(done!=null)handler.postDelayed(()->{if(ticket==generation&&!browserOpen&&!preview&&!isDestroyed()){snapshot=null;status="Snapshot kedaluwarsa. Refresh saldo.";showShell();}},Math.max(1,30001-(System.currentTimeMillis()-done.time)));});
  },"lumavun-readonly-snapshot").start();
 }
 private boolean allowed(Uri u){return "https".equals(u.getScheme())&&"bot-trading-terminal.vercel.app".equals(u.getHost())&&(u.getPort()==-1||u.getPort()==443)&&u.getUserInfo()==null;}
 private void openWeb(String path){
  generation++;snapshot=null;busy=false;status="Refresh untuk membaca akun terpilih.";browserOpen=true;root.removeAllViews();browser=column();
  LinearLayout h=row();h.setPadding(dp(12),dp(8),dp(12),dp(8));h.addView(action("Kembali",false,()->closeWeb()));TextView title=txt("  Exness terminal",18,WHITE,true);h.addView(title,new LinearLayout.LayoutParams(0,-2,1));add(browser,h);
  web=new WebView(this);WebSettings s=web.getSettings();s.setJavaScriptEnabled(true);s.setDomStorageEnabled(true);s.setAllowFileAccess(false);s.setAllowContentAccess(false);s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);s.setSupportMultipleWindows(false);s.setJavaScriptCanOpenWindowsAutomatically(false);
  CookieManager.getInstance().setAcceptCookie(true);CookieManager.getInstance().setAcceptThirdPartyCookies(web,false);WebView.setWebContentsDebuggingEnabled(false);
  web.setWebViewClient(new WebViewClient(){@Override public boolean shouldOverrideUrlLoading(WebView v,WebResourceRequest req){return !allowed(req.getUrl());}});
  browser.addView(web,new LinearLayout.LayoutParams(-1,0,1));root.addView(browser,new LinearLayout.LayoutParams(-1,-1));web.loadUrl(ORIGIN+path);
 }
 private void closeWeb(){if(web!=null){web.stopLoading();browser.removeView(web);web.destroy();web=null;}showShell();}
 @Override public void onBackPressed(){if(browserOpen){if(web!=null&&web.canGoBack())web.goBack();else closeWeb();}else if(tab!=0){tab=0;showShell();}else super.onBackPressed();}
 @Override protected void onPause(){generation++;busy=false;snapshot=null;status="Refresh saldo setelah kembali ke aplikasi.";if(web!=null)web.onPause();super.onPause();}
 @Override protected void onResume(){super.onResume();if(web!=null)web.onResume();else if(root!=null)showShell();}
 @Override protected void onDestroy(){generation++;handler.removeCallbacksAndMessages(null);if(web!=null){web.stopLoading();web.destroy();web=null;}super.onDestroy();}
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
