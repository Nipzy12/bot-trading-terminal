package com.lumavun.hedge;
import java.util.*;
public final class PreflightChecks {
 static void check(boolean b,String s){if(!b)throw new AssertionError(s);}
 static void fail(Runnable r,String expected){try{r.run();throw new AssertionError("expected "+expected);}catch(IllegalArgumentException e){check(expected.equals(e.getMessage()),"wrong reason: "+e.getMessage());}}
 public static void main(String[] args){
  PreflightPolicy.account("USC","enabled");PreflightPolicy.account("IDR","enabled");
  check(!PreflightPolicy.fee(null,null,null).known,"unknown commission must be explicit");
  check(Math.abs(PreflightPolicy.fee("per_lot_per_trade","3.5","USD").amount-.035)<1e-9,"per trade applies once");
  fail(()->PreflightPolicy.account("USC","trading_disabled"),"ACCOUNT_TRADE_DISABLED_OR_UNKNOWN");
  check(PreflightPolicy.symbol(Arrays.asList("EURUSDm","XAUUSDc"),"").equals("XAUUSDc"),"cent suffix");
  check(PreflightPolicy.symbol(Arrays.asList("XAUUSDm","XAUUSD"),"").equals("XAUUSD"),"exact priority");
  fail(()->PreflightPolicy.symbol(Arrays.asList("XAUUSDm","XAUUSDc"),""),"XAUUSD_AMBIGUOUS");
  check(PreflightPolicy.symbol(Arrays.asList("XAUUSDm","XAUUSDc"),"XAUUSDc").equals("XAUUSDc"),"explicit listed symbol");
  check(PreflightPolicy.units("100","0.01","100","0.01","USD","enabled")==1,"contract units");
  fail(()->PreflightPolicy.units(null,"0.01","100","0.01","USD","enabled"),"CONTRACT_SIZE_UNAVAILABLE");
  fail(()->PreflightPolicy.units("100","0.1","100","0.1","USD","enabled"),"LOT_0_01_NOT_SUPPORTED");
  fail(()->PreflightPolicy.units("100","0.01","100","0.01","USC","enabled"),"QUOTE_CURRENCY_UNSUPPORTED");
  check(Math.abs(PreflightPolicy.fee("per_lot_per_side","350","USC").amount-.07)<1e-9,"cent commission converted");
  check(!PreflightPolicy.fee("per_million_usd","10","USD").known,"unsupported model explicit");
  check(PreflightPolicy.fee("undefined","0","USC").known,"explicit zero commission");
  check(PreflightPolicy.safeReason(new IllegalArgumentException("secret-data")).equals("RESPONSE_OR_PROTOCOL_INVALID"),"redact unknown errors");
  System.out.println("Preflight regression checks passed");
 }
}
