package com.lumavun.hedge;
public final class PaperHedgeChecks {
 static void check(boolean v,String msg){if(!v)throw new AssertionError(msg);}
 static PaperHedge engine(){return new PaperHedge(100,1,0,1,2,.5,5,30000,1);}
 public static void main(String[] args){
  PaperHedge e=engine();long t=100000;e.start();
  for(int i=0;i<21;i++){t+=1000;e.tick(4000+i*.1,4000.2+i*.1,t,t);}
  check(e.open.size()==1&&e.open.get(0).buy,"buy trend");t+=31000;
  e.tick(4004,4004.2,t,t);check(e.closed.size()==1&&e.balance>100,"harvest win");
  PaperHedge h=engine();h.start();t=200000;
  for(int i=0;i<21;i++){t+=1000;h.tick(4000+i*.1,4000.2+i*.1,t,t);}
  for(int i=0;i<25;i++){t+=2000;h.tick(3999-i*.03,3999.2-i*.03,t,t);}
  check(h.open.stream().anyMatch(p->p.buy)&&h.open.stream().anyMatch(p->!p.buy),"loser kept, reverse opened");
  int size=h.open.size();h.stop("STOPPED");t+=40000;h.tick(3998,3998.2,t,t);check(h.open.size()==size,"stopped prevents entries and closes");
  check(!h.emergency(t+20000)&&h.open.size()==size,"no stale close");check(h.emergency(t)&&h.open.isEmpty(),"emergency closes paper only");
  PaperHedge d=engine();d.start();for(int i=0;i<21;i++){t+=1000;d.tick(4000+i*.1,4000.2+i*.1,t,t);}t+=1000;d.tick(3950,3950.2,t,t);check(d.halted&&!d.running&&d.open.isEmpty(),"drawdown guard");
  System.out.println("6 paper engine scenarios passed");
 }
}
