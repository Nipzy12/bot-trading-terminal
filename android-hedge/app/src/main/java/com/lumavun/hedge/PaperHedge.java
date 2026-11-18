package com.lumavun.hedge;
import java.util.*;
/** Pure foreground paper engine. No broker mutation, no invented prices. */
final class PaperHedge {
 static final class Position{
  final boolean buy;final double entry;final long time;
  Position(boolean buy,double entry,long time){this.buy=buy;this.entry=entry;this.time=time;}
  double pnl(double bid,double ask,double units,double fee){return (buy?bid-entry:entry-ask)*units-fee;}
 }
 static final class Closed{
  final Position position;final double exit,pnl;final long time;
  Closed(Position p,double exit,double pnl,long time){position=p;this.exit=exit;this.pnl=pnl;this.time=time;}
 }
 final List<Position> open=new ArrayList<>();final List<Closed> closed=new ArrayList<>();
 final double initial,units,fee,target,maxSpread,grid,marginReserve;final int cap;final long cooldown;
 double balance,peak,bid=Double.NaN,ask=Double.NaN,fast,slow;long lastTick,lastEntry;int samples;
 boolean running,halted;String note="STOPPED";
 PaperHedge(double capital,double units,double fee,double target,double grid,double maxSpread,int cap,long cooldown,double marginReserve){
  if(!Double.isFinite(capital)||capital<=0||!Double.isFinite(units)||units<=0||!Double.isFinite(fee)||fee<0||!Double.isFinite(target)||target<=0||!Double.isFinite(grid)||grid<=0||!Double.isFinite(maxSpread)||maxSpread<=0||cap<1||cap>20||cooldown<1000||!Double.isFinite(marginReserve)||marginReserve<=0)throw new IllegalArgumentException();
  initial=balance=peak=capital;this.units=units;this.fee=fee;this.target=target;this.grid=grid;this.maxSpread=maxSpread;this.cap=cap;this.cooldown=cooldown;this.marginReserve=marginReserve;
 }
 void start(){if(!halted){running=true;samples=0;note="WAITING FOR TICKS";}}
 void stop(String reason){running=false;note=reason;}
 boolean fresh(long now){return lastTick>0&&lastTick<=now+2000&&now-lastTick<=10000;}
 double floating(){if(open.isEmpty())return 0;if(!Double.isFinite(bid)||!Double.isFinite(ask))return Double.NaN;double v=0;for(Position p:open)v+=p.pnl(bid,ask,units,fee);return v;}
 double equity(){return balance+floating();}
 void close(Position p,long now){double exit=p.buy?bid:ask;double pnl=p.pnl(bid,ask,units,fee);balance+=pnl;closed.add(new Closed(p,exit,pnl,now));open.remove(p);}
 boolean emergency(long now){stop("EMERGENCY STOP");halted=true;if(!open.isEmpty()&&!fresh(now)){note="EMERGENCY: menunggu tick segar";return false;}for(Position p:new ArrayList<>(open))close(p,now);note="EMERGENCY: paper closed";return true;}
 String tick(double b,double a,long t,long now){
  if(!Double.isFinite(b)||!Double.isFinite(a)||b<=0||a<b||t<=lastTick||t>now+2000||now-t>10000)return "INVALID_OR_STALE";
  bid=b;ask=a;lastTick=t;if(!running)return note;
  double mid=(a+b)/2;if(samples==0){fast=slow=mid;}else{fast+=(mid-fast)*.2;slow+=(mid-slow)*(2.0/22.0);}samples++;
  double eq=equity();peak=Math.max(peak,eq);if(eq<=peak*.85){emergency(now);return note;}
  for(Position p:new ArrayList<>(open)){if(p.pnl(bid,ask,units,fee)>=target){close(p,t);note="HARVEST";return note;}}
  if(samples<21){note="WARMUP "+samples+"/21";return note;}
  if(a-b>maxSpread||open.size()>=cap||t-lastEntry<cooldown||eq<(open.size()+1)*marginReserve*2){note="RISK / GRID WAIT";return note;}
  if(Math.abs(fast-slow)<1e-9){note="NO SIGNAL";return note;}
  boolean buy=fast>slow;double entry=buy?a:b;for(Position p:open)if(p.buy==buy&&Math.abs(entry-p.entry)<grid){note="GRID WAIT";return note;}
  open.add(new Position(buy,entry,t));lastEntry=t;note=buy?"PAPER BUY":"PAPER SELL";return note;
 }
}
