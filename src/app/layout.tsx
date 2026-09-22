import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "tek shape — A little more perspective",
  description: "A local personal knowledge feed with eight sample ideas.",
  robots: { index: false, follow: false },
};
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en-GB"><body>{children}</body></html>;
}
