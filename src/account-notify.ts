export function notifyAccountChange() {
  if (typeof BroadcastChannel !== "undefined") {
    const c = new BroadcastChannel("nexus-account-change");
    c.postMessage("changed");
    c.close();
  }
}
