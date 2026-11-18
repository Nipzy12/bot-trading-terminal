package com.lumavun.hedge;
import android.app.Activity;
import android.os.Bundle;
import android.graphics.Color;
import android.net.Uri;
import android.webkit.*;
import android.widget.*;
import android.view.*;
public class MainActivity extends Activity {
 private static final String ORIGIN="https://bot-trading-terminal.vercel.app";
 private WebView web;
 private boolean allowed(Uri u){return "https".equals(u.getScheme()) && "bot-trading-terminal.vercel.app".equals(u.getHost()) && (u.getPort()==-1||u.getPort()==443) && u.getUserInfo()==null;}
 @Override public void onCreate(Bundle b){
 super.onCreate(b);
 LinearLayout root=new LinearLayout(this);root.setOrientation(LinearLayout.VERTICAL);root.setBackgroundColor(0xff101827);
 root.setOnApplyWindowInsetsListener((v,i)->{v.setPadding(0,i.getSystemWindowInsetTop(),0,i.getSystemWindowInsetBottom());return i;});
 TextView title=new TextView(this);title.setText("LUMAVUN  /  HEDGE");title.setTextColor(Color.WHITE);title.setTextSize(20);title.setPadding(18,12,18,8);root.addView(title);
 TextView note=new TextView(this);note.setText("Exness monitor • eksekusi PAPER ONLY");note.setTextColor(0xffaabbd0);note.setPadding(18,0,18,8);root.addView(note);
 LinearLayout nav=new LinearLayout(this);
 web=new WebView(this);
 String[] names={"Terminal","Bot","Akun","Refresh"};String[] paths={"/?feed=live","/bot?feed=live","/accounts",""};
 for(int j=0;j<names.length;j++){final String p=paths[j];Button btn=new Button(this);btn.setText(names[j]);btn.setAllCaps(false);nav.addView(btn,new LinearLayout.LayoutParams(0,-2,1));btn.setOnClickListener(v->{if(p.isEmpty())web.reload();else web.loadUrl(ORIGIN+p);});}
 root.addView(nav);root.addView(web,new LinearLayout.LayoutParams(-1,0,1));setContentView(root);
 WebSettings s=web.getSettings();s.setJavaScriptEnabled(true);s.setDomStorageEnabled(true);s.setAllowFileAccess(false);s.setAllowContentAccess(false);s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);s.setSupportMultipleWindows(false);s.setJavaScriptCanOpenWindowsAutomatically(false);
 CookieManager.getInstance().setAcceptCookie(true);CookieManager.getInstance().setAcceptThirdPartyCookies(web,false);
 WebView.setWebContentsDebuggingEnabled(false);
 web.setWebViewClient(new WebViewClient(){@Override public boolean shouldOverrideUrlLoading(WebView v,WebResourceRequest r){return !allowed(r.getUrl());}});
 web.loadUrl(ORIGIN+"/accounts");
 }
 @Override public void onBackPressed(){if(web.canGoBack())web.goBack();else super.onBackPressed();}
 @Override protected void onDestroy(){web.stopLoading();web.destroy();super.onDestroy();}
}
