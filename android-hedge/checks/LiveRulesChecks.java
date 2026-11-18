package com.lumavun.hedge;
import java.math.BigDecimal;
public class LiveRulesChecks {
 static BigDecimal n(String s){return new BigDecimal(s);}
 static void check(boolean b,String m){if(!b)throw new AssertionError(m);}
 public static void main(String[] args){
  long t=100000;
  check(!LiveRules.allowsOpen(false,true,false,false,true,0,t,t,t,0),"not armed");
  check(!LiveRules.allowsOpen(true,true,true,false,true,0,t,t,t,0),"pending");
  check(!LiveRules.allowsOpen(true,true,false,false,false,0,t,t,t,0),"foreign exposure");
  check(!LiveRules.allowsOpen(true,true,false,false,true,5,t,t,t,0),"max positions");
  check(!LiveRules.allowsOpen(true,true,false,false,true,0,t,t-6000,t,0),"stale tick");
  check(!LiveRules.allowsOpen(true,true,false,false,true,0,t,t,t-16000,0),"stale state");
  check(!LiveRules.allowsOpen(true,true,false,false,true,0,t,t,t,t-1000),"cooldown");
  check(LiveRules.allowsOpen(true,true,false,false,true,0,t,t,t,0),"authorized intent");
  check(!LiveRules.correlation("key1",null,"key2","10"),"wrong key");
  check(!LiveRules.correlation("key1","9","key1","10"),"wrong operation");
  check(LiveRules.correlation("key1","10","key1","10"),"matching result");
  check(LiveRules.gross("buy",n("4000"),n(".01"),n("100"),n("4001"),n("4001.2"),LiveRules.factor("USD")).compareTo(n("1"))==0,"buy pnl");
  check(LiveRules.gross("sell",n("4000"),n(".01"),n("100"),n("3998.8"),n("3999"),LiveRules.factor("USC")).compareTo(n("100"))==0,"cent pnl");
  BigDecimal reserve=LiveRules.estimatedMargin(n(".01"),n("100"),n("4000"),n("2000"),n("1"));check(reserve.compareTo(n("20"))==0,"capped leverage");
  check(!LiveRules.entryMargin(n("30"),n("0"),reserve),"insufficient reserve");
  check(LiveRules.drawdown(n("85"),n("100")),"drawdown guard");
  System.out.println("16 live rules checks passed");
 }
}
