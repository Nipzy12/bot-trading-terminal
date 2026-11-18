package com.lumavun.hedge;
import java.math.BigDecimal;
import java.util.*;
final class PreflightPolicy {
 static void account(String currency,String mode){
  if(currency==null||!currency.matches("[A-Za-z][A-Za-z0-9]{1,11}"))throw new IllegalArgumentException("ACCOUNT_CURRENCY_INVALID");
  if(!"enabled".equals(mode))throw new IllegalArgumentException("ACCOUNT_TRADE_DISABLED_OR_UNKNOWN");
 }
 static String symbol(List<String> names,String preferred){
  Set<String> candidates=new LinkedHashSet<>();for(String s:names)if(s!=null&&s.matches("XAUUSD[a-z0-9._-]{0,5}"))candidates.add(s);
  if(preferred!=null&&!preferred.isEmpty()){if(!candidates.contains(preferred))throw new IllegalArgumentException("SELECTED_SYMBOL_UNAVAILABLE");return preferred;}
  if(candidates.contains("XAUUSD"))return "XAUUSD";
  if(candidates.isEmpty())throw new IllegalArgumentException("XAUUSD_NOT_FOUND");
  if(candidates.size()>1)throw new IllegalArgumentException("XAUUSD_AMBIGUOUS");return candidates.iterator().next();
 }
 static BigDecimal decimal(String v,String reason){if(v==null||!v.matches("[+-]?[0-9]{1,30}(\\.[0-9]{1,18})?"))throw new IllegalArgumentException(reason);return new BigDecimal(v);}
 static double units(String contract,String minimum,String maximum,String increment,String quote,String mode){
  if(!"enabled".equals(mode))throw new IllegalArgumentException("SYMBOL_TRADE_DISABLED_OR_UNKNOWN");
  if(!"USD".equals(quote))throw new IllegalArgumentException("QUOTE_CURRENCY_UNSUPPORTED");
  BigDecimal min=decimal(minimum,"VOLUME_MIN_UNAVAILABLE"),max=decimal(maximum,"VOLUME_MAX_UNAVAILABLE"),step=decimal(increment,"VOLUME_STEP_UNAVAILABLE"),lot=new BigDecimal("0.01");
  if(min.signum()<=0||max.compareTo(min)<0||step.signum()<=0)throw new IllegalArgumentException("VOLUME_CONDITIONS_INVALID");
  if(lot.compareTo(min)<0||lot.compareTo(max)>0||lot.subtract(min).remainder(step).signum()!=0)throw new IllegalArgumentException("LOT_0_01_NOT_SUPPORTED");
  double units=decimal(contract,"CONTRACT_SIZE_UNAVAILABLE").multiply(lot).doubleValue();if(!Double.isFinite(units)||units<=0)throw new IllegalArgumentException("CONTRACT_SIZE_INVALID");return units;
 }
 static final class Fee {final double amount;final boolean known;Fee(double a,boolean k){amount=a;known=k;}}
 static Fee fee(String type,String amount,String currency){
  if(amount==null)return new Fee(0,false);
  double cost=decimal(amount,"COMMISSION_AMOUNT_INVALID").abs().doubleValue();if(cost==0)return new Fee(0,true);
  if("USC".equals(currency))cost/=100;else if(!"USD".equals(currency))return new Fee(0,false);
  if("per_lot_per_side".equals(type))return new Fee(cost*.01*2,true);
  if("per_lot_per_trade".equals(type))return new Fee(cost*.01,true);
  return new Fee(0,false);
 }
 static String safeReason(Throwable e){
  if(e instanceof IllegalArgumentException){String m=e.getMessage();if(m!=null&&m.matches("(?:ACCOUNT_CURRENCY_INVALID|ACCOUNT_TRADE_DISABLED_OR_UNKNOWN|SELECTED_SYMBOL_UNAVAILABLE|XAUUSD_NOT_FOUND|XAUUSD_AMBIGUOUS|SYMBOL_TRADE_DISABLED_OR_UNKNOWN|QUOTE_CURRENCY_UNSUPPORTED|VOLUME_MIN_UNAVAILABLE|VOLUME_MAX_UNAVAILABLE|VOLUME_STEP_UNAVAILABLE|VOLUME_CONDITIONS_INVALID|LOT_0_01_NOT_SUPPORTED|CONTRACT_SIZE_UNAVAILABLE|CONTRACT_SIZE_INVALID|COMMISSION_AMOUNT_INVALID|INSTRUMENT_MISMATCH|WS_LIMITS_UNAVAILABLE)"))return m;}
  if(e instanceof java.net.SocketTimeoutException)return "NETWORK_TIMEOUT";
  if(e instanceof java.net.UnknownHostException)return "DNS_FAILED";
  if(e instanceof javax.net.ssl.SSLException)return "TLS_FAILED";
  if(e instanceof java.io.IOException)return "NETWORK_IO_FAILED";
  return "RESPONSE_OR_PROTOCOL_INVALID";
 }
 static boolean publicCode(int code){return code>=1&&code<=3||code>=1000&&code<=1002||code>=2000&&code<=2002||code>=3000&&code<=3015||code>=4000&&code<=4004||code>=5000&&code<=5010||code>=6000&&code<=6001;}
}
