"use client";
import { useEffect, useState } from "react";

interface InstallEvent extends Event { prompt(): Promise<void>; userChoice: Promise<{ outcome: string }> }
export function InstallApp() {
  const [prompt, setPrompt] = useState<InstallEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  useEffect(() => {
    const capture = (event: Event) => { event.preventDefault(); setPrompt(event as InstallEvent); };
    const done = () => { setInstalled(true); setPrompt(null); };
    const standalone = window.matchMedia("(display-mode: standalone)");
    if (standalone.matches) queueMicrotask(done);
    window.addEventListener("beforeinstallprompt", capture);
    window.addEventListener("appinstalled", done);
    if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/sw.js").catch(() => { /* Installation can still use the browser menu. */ });
    return () => { window.removeEventListener("beforeinstallprompt", capture); window.removeEventListener("appinstalled", done); };
  }, []);
  if (installed) return null;
  return <aside className="install-app">{prompt ? <button className="text-button" onClick={async () => { await prompt.prompt(); await prompt.userChoice; setPrompt(null); }}>Install T on this device</button> : <p>Add T to your home screen from your browser’s menu.</p>}</aside>;
}
