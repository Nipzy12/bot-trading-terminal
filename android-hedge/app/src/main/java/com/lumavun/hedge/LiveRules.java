package com.lumavun.hedge;

import java.math.*;
import java.util.*;

/** Deterministic risk/signal decisions; never invents positions or balance. */
final class LiveRules {
 static final BigDecimal LOT=new BigDecimal("0.01"), TWO=new BigDecimal("2"), DD=new BigDecimal("0.85"), SPREAD=new BigDecimal("0.50");
 static final int MAX_POSITIONS=5;
 static BigDecimal number(String s){if(s==null||!s.matches("[+-]?[0-9]{1,30}(\\.[0-9]{1,18})?"))throw new IllegalArgumentException("INVALID_DECIMAL");return new BigDecimal(s);}
 static BigDecimal factor(String currency){if("USD".equals(currency))return BigDecimal.ONE;if("USC".equals(currency))return new BigDecimal("100");throw new IllegalArgumentException("LIVE_CURRENCY_UNSUPPORTED");}
 static boolean fresh(long timestamp,long now,long age){return timestamp>0&&timestamp<=now+2000&&now-timestamp<=age;}
 static BigDecimal estimatedMargin(BigDecimal lots,BigDecimal contract,BigDecimal ask,BigDecimal leverage,BigDecimal factor){
  if(lots.signum()<=0||contract.signum()<=0||ask.signum()<=0||leverage.signum()<=0)throw new IllegalArgumentException("MARGIN_INPUT_INVALID");
  // Conservative XAUUSD notional reserve; cap assumed leverage at 200 even if configured higher.
  return lots.multiply(contract).multiply(ask).multiply(factor).divide(leverage.min(new BigDecimal("200")),8,RoundingMode.UP);
 }
 static boolean entryMargin(BigDecimal equity,BigDecimal used,BigDecimal reserve){return equity.signum()>0&&used.signum()>=0&&reserve.signum()>0&&equity.subtract(used).compareTo(reserve.multiply(TWO))>=0;}
 static BigDecimal gross(String side,BigDecimal entry,BigDecimal volume,BigDecimal contract,BigDecimal bid,BigDecimal ask,BigDecimal multiplier){
  BigDecimal delta;if("buy".equals(side))delta=bid.subtract(entry);else if("sell".equals(side))delta=entry.subtract(ask);else throw new IllegalArgumentException("INVALID_SIDE");
  return delta.multiply(volume).multiply(contract).multiply(multiplier);
 }
 static boolean correlation(String expectedKey,String expectedOperation,String eventKey,String eventOperation){
  return expectedKey!=null&&!expectedKey.isEmpty()&&expectedKey.equals(eventKey)&&eventOperation!=null&&eventOperation.matches("[0-9]{1,20}")&&(expectedOperation==null||expectedOperation.equals(eventOperation));
 }
 static boolean allowsOpen(boolean armed,boolean ready,boolean pending,boolean closing,boolean ownedOnly,int count,long now,long tick,long state,long lastAction){
  return armed&&ready&&!pending&&!closing&&ownedOnly&&count<MAX_POSITIONS&&fresh(tick,now,5000)&&fresh(state,now,15000)&&now-lastAction>=30000;
 }
 static boolean drawdown(BigDecimal equity,BigDecimal peak){return peak.signum()>0&&equity.compareTo(peak.multiply(DD))<=0;}
 static final class Signal {
  int samples; double fast,slow;
  String next(double bid,double ask){
   if(!Double.isFinite(bid)||!Double.isFinite(ask)||bid<=0||ask<bid)throw new IllegalArgumentException("INVALID_TICK");
   double mid=(bid+ask)/2;if(samples==0){fast=slow=mid;}else{fast+=(mid-fast)*.2;slow+=(mid-slow)*(2.0/22.0);}if(samples<21)samples++;
   return samples<21||Math.abs(fast-slow)<1e-9?"":fast>slow?"buy":"sell";
  }
 }
}
