package com.lumavun.hedge;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.util.Arrays;
import javax.crypto.*;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.SecretKey;
import javax.net.ssl.HttpsURLConnection;
import org.json.*;
import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters;
import org.bouncycastle.crypto.signers.Ed25519Signer;
import org.bouncycastle.crypto.util.PrivateKeyFactory;

final class ExnessClient {
 final String account,key,gateway;
 private final Ed25519PrivateKeyParameters signing;
 private String access;
 private static String b64(byte[] b){return Base64.encodeToString(b,Base64.URL_SAFE|Base64.NO_PADDING|Base64.NO_WRAP);}
 private static byte[] hex(String s){byte[] b=new byte[s.length()/2];for(int i=0;i<b.length;i++)b[i]=(byte)Integer.parseInt(s.substring(i*2,i*2+2),16);return b;}
 static String origin(String value)throws Exception{
  String s=value.trim();if(!s.contains("://"))s="https://"+s;
  URI u=new URI(s);String h=u.getHost();
  if(!"https".equals(u.getScheme())||h==null||u.getUserInfo()!=null||u.getQuery()!=null||u.getFragment()!=null||(u.getPort()!=-1&&u.getPort()!=443)||!(u.getPath().isEmpty()||"/".equals(u.getPath())))throw new Exception("INVALID_HOST");
  h=h.toLowerCase(java.util.Locale.ROOT);
  if(!(h.equals("exness.com")||h.endsWith(".exness.com")||h.equals("exness-api.com")||h.endsWith(".exness-api.com")))throw new Exception("INVALID_HOST");
  return "https://"+h;
 }
 ExnessClient(JSONObject data)throws Exception{
  account=data.getString("account");key=data.getString("key");gateway=origin(data.getString("gateway"));
  if(!account.matches("[0-9]{1,20}")||!key.matches("[A-Za-z0-9._~-]{5,256}"))throw new Exception("INVALID_CREDENTIAL_FORMAT");
  String secret=data.getString("secret").trim();
  if(secret.matches("[0-9a-fA-F]{64}|[0-9a-fA-F]{128}")){
   byte[] k=hex(secret);signing=new Ed25519PrivateKeyParameters(k,0);
   if(k.length==64&&!MessageDigest.isEqual(Arrays.copyOfRange(k,32,64),signing.generatePublicKey().getEncoded()))throw new Exception("INVALID_PRIVATE_KEY");
   Arrays.fill(k,(byte)0);
  }else if(secret.startsWith("-----BEGIN PRIVATE KEY-----")){
   byte[] der=Base64.decode(secret.replace("-----BEGIN PRIVATE KEY-----","").replace("-----END PRIVATE KEY-----",""),Base64.DEFAULT);
   try{signing=(Ed25519PrivateKeyParameters)PrivateKeyFactory.createKey(der);}finally{Arrays.fill(der,(byte)0);}
  }else throw new Exception("INVALID_PRIVATE_KEY");
 }
 static final class ApiError extends Exception{
  final int http;ApiError(int http){super("HTTP "+http);this.http=http;}
 }
 JSONObject request(String host,String method,String path,JSONObject body,String idempotency)throws Exception{
  byte[] bytes=body==null?new byte[0]:body.toString().getBytes(StandardCharsets.UTF_8);
  long ts=System.currentTimeMillis();
  JSONObject p=new JSONObject().put("api_key",key).put("idempotency_key",idempotency).put("timestamp",ts).put("sign_version",1).put("method",method).put("path",path).put("body_hash",b64(MessageDigest.getInstance("SHA-256").digest(bytes)));
  byte[] payload=p.toString().getBytes(StandardCharsets.UTF_8);
  Ed25519Signer signer=new Ed25519Signer();signer.init(true,signing);signer.update(payload,0,payload.length);
  HttpsURLConnection c=(HttpsURLConnection)new URL(origin(host)+path).openConnection();
  try{
   c.setInstanceFollowRedirects(false);c.setConnectTimeout(8000);c.setReadTimeout(10000);c.setUseCaches(false);c.setRequestMethod(method);
   c.setRequestProperty("Accept","application/json");c.setRequestProperty("EXN-API-KEY",key);c.setRequestProperty("EXN-IDEMPOTENCY-KEY",idempotency);c.setRequestProperty("EXN-TIMESTAMP",Long.toString(ts));c.setRequestProperty("EXN-SIGN-VERSION","1");c.setRequestProperty("EXN-DATA",b64(payload));c.setRequestProperty("EXN-SIGN",b64(signer.generateSignature()));
   if(body!=null){c.setDoOutput(true);c.setRequestProperty("Content-Type","application/json");c.setFixedLengthStreamingMode(bytes.length);try(OutputStream out=c.getOutputStream()){out.write(bytes);}}
   int code=c.getResponseCode();if(code!=200&&code!=202)throw new ApiError(code);
   try(InputStream in=c.getInputStream();ByteArrayOutputStream out=new ByteArrayOutputStream()){
    byte[] chunk=new byte[4096];int n;while((n=in.read(chunk))!=-1){if(out.size()+n>2097152)throw new IOException();out.write(chunk,0,n);}return new JSONObject(out.toString("UTF-8"));
   }
  }finally{c.disconnect();}
 }
 private synchronized String access()throws Exception{
  if(access==null){JSONObject j=request(gateway,"GET","/v1/trading/access-point?account_id="+account,null,"");if(!account.equals(j.getString("account_id")))throw new Exception("ACCOUNT_MISMATCH");access=origin(j.getString("access_point"));}return access;
 }
 okhttp3.Request tickRequest()throws Exception{
  String host=access(),path="/v1/server-events/accounts/"+account+"/ws/ticks";
  long ts=System.currentTimeMillis();
  JSONObject data=new JSONObject().put("api_key",key).put("idempotency_key","").put("timestamp",ts).put("sign_version",1).put("method","GET").put("path",path).put("body_hash",b64(MessageDigest.getInstance("SHA-256").digest(new byte[0])));
  byte[] bytes=data.toString().getBytes(StandardCharsets.UTF_8);
  Ed25519Signer signer=new Ed25519Signer();signer.init(true,signing);signer.update(bytes,0,bytes.length);
  return new okhttp3.Request.Builder().url("wss://"+host.substring(8)+path).header("Sec-WebSocket-Protocol","exness-ws-protocol").header("EXN-API-KEY",key).header("EXN-IDEMPOTENCY-KEY","").header("EXN-TIMESTAMP",Long.toString(ts)).header("EXN-SIGN-VERSION","1").header("EXN-DATA",b64(bytes)).header("EXN-SIGN",b64(signer.generateSignature())).build();
 }
 JSONObject instruments()throws Exception{return get("/v1/configuration/accounts/"+account+"/instruments");}
 JSONObject conditions(String symbol)throws Exception{if(!symbol.matches("[A-Za-z0-9._-]{1,11}"))throw new Exception("INVALID_SYMBOL");return get("/v1/configuration/accounts/"+account+"/instruments/"+symbol+"/conditions");}
 JSONObject get(String path)throws Exception{return request(access(),"GET",path,null,"");}
 JSONObject details()throws Exception{JSONObject j=get("/v1/configuration/accounts/"+account+"/account");if(!account.equals(j.getString("account_id")))throw new Exception("ACCOUNT_MISMATCH");return j.getJSONObject("settings");}
 JSONObject snapshot()throws Exception{return get("/v1/trading/accounts/"+account+"/snapshot");}
 JSONObject limits()throws Exception{return get("/v1/configuration/accounts/"+account+"/limits");}
 JSONObject deals(String query)throws Exception{return get("/v1/history/accounts/"+account+"/deals?"+query);}
 // Transport primitives only: intentionally not connected to UI or autonomous loop.
 // Caller must validate symbol conditions, margin, fresh prices, permissions, and persist/reconcile the operation.
 JSONObject openPosition(String instrument,String side,String volume,String idempotency)throws Exception{
  if(!instrument.matches("[A-Za-z0-9._-]{1,11}")||!side.matches("buy|sell")||!volume.matches("[0-9]+(\\.[0-9]+)?")||new java.math.BigDecimal(volume).signum()<=0||!idempotency.matches("[A-Za-z0-9._~-]{5,128}"))throw new Exception("INVALID_ORDER");
  JSONObject body=new JSONObject().put("instrument",instrument).put("side",side).put("volume",volume);
  return request(access(),"POST","/v1/trading/accounts/"+account+"/positions",body,idempotency);
 }
 JSONObject closePosition(String position,String idempotency)throws Exception{
  if(!position.matches("[0-9]{1,20}")||!idempotency.matches("[A-Za-z0-9._~-]{5,128}"))throw new Exception("INVALID_ORDER");
  return request(access(),"DELETE","/v1/trading/accounts/"+account+"/positions/"+position,null,idempotency);
 }
 JSONObject operation(String operation)throws Exception{if(!operation.matches("[0-9]{1,20}"))throw new Exception("INVALID_OPERATION");return get("/v1/trading/accounts/"+account+"/operations/"+operation);}
 static final class Vault{
  private final SharedPreferences prefs;private static final String ALIAS="lumavun.exness.v1";
  Vault(Context ctx){prefs=ctx.getSharedPreferences("exness_vault",Context.MODE_PRIVATE);}
  private SecretKey secret()throws Exception{
   KeyStore ks=KeyStore.getInstance("AndroidKeyStore");ks.load(null);
   if(!ks.containsAlias(ALIAS)){KeyGenerator gen=KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore");gen.init(new KeyGenParameterSpec.Builder(ALIAS,KeyProperties.PURPOSE_ENCRYPT|KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256).build());gen.generateKey();}
   return (SecretKey)ks.getKey(ALIAS,null);
  }
  void save(JSONObject value)throws Exception{
   Cipher c=Cipher.getInstance("AES/GCM/NoPadding");c.init(Cipher.ENCRYPT_MODE,secret());
   byte[] encrypted=c.doFinal(value.toString().getBytes(StandardCharsets.UTF_8));if(!prefs.edit().putString("iv",b64(c.getIV())).putString("cipher",b64(encrypted)).commit())throw new IOException();
  }
  JSONObject load()throws Exception{
   String e=prefs.getString("cipher",null),iv=prefs.getString("iv",null);if(e==null||iv==null)return null;
   Cipher c=Cipher.getInstance("AES/GCM/NoPadding");c.init(Cipher.DECRYPT_MODE,secret(),new GCMParameterSpec(128,Base64.decode(iv,Base64.URL_SAFE|Base64.NO_WRAP)));
   byte[] plain=c.doFinal(Base64.decode(e,Base64.URL_SAFE|Base64.NO_WRAP));try{return new JSONObject(new String(plain,StandardCharsets.UTF_8));}finally{Arrays.fill(plain,(byte)0);}
  }
  void clear()throws Exception{if(!prefs.edit().clear().commit())throw new IOException();KeyStore ks=KeyStore.getInstance("AndroidKeyStore");ks.load(null);ks.deleteEntry(ALIAS);}
 }
}
