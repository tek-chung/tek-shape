import type { Metadata, Viewport } from "next";
import "./globals.css";
export const viewport: Viewport = { themeColor: "#263d36" };
export const metadata: Metadata = {
  title: "T — Know broadly. Explore deeply.",
  description: "T is a personal knowledge feed for curiosity-driven learning. Know broadly. Explore deeply.",
  robots: { index: false, follow: false },
  icons: { icon: { url: "/logo.svg", type: "image/svg+xml", sizes: "any" } },
};
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en-GB"><body>{children}</body></html>;
}
